// DeepSeek Harness backend over ACP.
//
// Spawns `dsh --profile acp`, drives it over stdio NDJSON with the
// `ClientSideConnection` from `@agentclientprotocol/sdk`, and folds the ACP
// SessionUpdate stream into the neutral model (model.ts) for the webview.
//
// Known gaps, inherent to dsh's ACP surface (not this adapter):
//   - No `session/load`: resume does not replay history, so getMessages() only
//     returns what this process observed since start.
//   - No streaming: dsh emits committed blocks, so text arrives one block per
//     `agent_message_chunk`, not token-by-token (part.delta is never used).
//   - Tool calls carry only a toolCallId (no messageId), so we attach each tool
//     to the most recent assistant message.
//   - Permission requests are answered "reject once" for now; wiring the
//     webview permission UI is a follow-up.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Readable as NodeReadable, Writable as NodeWritable } from "node:stream"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type ContentBlock,
  type SessionUpdate,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import { parse as parseYaml } from "yaml"
import type { Backend, BackendCapabilities, BackendStatus, PromptInput } from "./index"
import { makeMessageID, makePartID, type Message, type NeutralUpdate, type Session } from "../model"
import type { McpStatus, ProviderInfo, ProviderListResult, SkillInfo } from "../types"
import { scanSkills } from "./skill-scan"

export type DshConfig = {
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
}

type DshProvider = {
  displayName?: string
  api?: string
  baseURL?: string
  models: Array<{ id: string }>
}

type Handlers = {
  onUpdate: (u: NeutralUpdate) => void
  onStatus: (s: BackendStatus) => void
}

export class DshBackend implements Backend {
  readonly kind = "dsh" as const
  readonly capabilities: BackendCapabilities = {
    providers: true,
    agents: false,
    skills: true,
    mcp: true,
    commands: false,
  }

  get pid() {
    return this.child?.pid
  }

  private connection?: ClientSideConnection
  private child?: ChildProcess
  private sessionId?: string
  private handlers?: Handlers
  private started = false

  // Local transcript. dsh's ACP has no session/load, so this is the only
  // source for getMessages(); it accumulates as updates arrive.
  private readonly messages = new Map<string, Message>()
  private readonly toolCallToMessage = new Map<string, string>()
  private currentMessageId?: string

  constructor(private readonly config: DshConfig) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.setStatus({ state: "starting" })

    const args = this.config.args ?? ["--profile", "acp"]
    this.child = spawn(this.config.command, args, {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.config.env },
    })
    this.child.on("exit", () => {
      if (this.started) this.setStatus({ state: "error", message: "dsh process exited" })
    })

    const stdin = this.child.stdin
    const stdout = this.child.stdout
    if (!stdin || !stdout) {
      this.child.kill()
      this.child = undefined
      this.setStatus({ state: "error", message: "dsh process did not expose stdio pipes" })
      return
    }

    const connection = new ClientSideConnection(
      () => this.buildClient(),
      ndJsonStream(
        NodeWritable.toWeb(stdin) as WritableStream<Uint8Array>,
        NodeReadable.toWeb(stdout) as ReadableStream<Uint8Array>,
      ),
    )
    this.connection = connection

    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const session = await connection.newSession({ cwd: this.config.cwd, mcpServers: [] })
      this.sessionId = session.sessionId
      this.setStatus({ state: "ready" })
    } catch (error) {
      this.child?.kill()
      this.child = undefined
      this.setStatus({ state: "error", message: errorMessage(error) })
      this.started = false
    }
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.connection && this.sessionId) {
      try {
        await this.connection.closeSession({ sessionId: this.sessionId })
      } catch {
        // process may already be gone
      }
    }
    this.child?.stdin?.end()
    this.child?.kill()
    this.connection = undefined
    this.child = undefined
    this.sessionId = undefined
  }

  async listSessions(): Promise<Session[]> {
    if (!this.connection) return []
    const { sessions } = await this.connection.listSessions({})
    return sessions.map((s) => ({
      id: s.sessionId,
      directory: s.cwd,
      title: s.title ?? undefined,
      time: s.updatedAt ? { updated: Date.parse(s.updatedAt) } : undefined,
    }))
  }

  async createSession(_input?: { title?: string }): Promise<Session> {
    if (!this.connection) throw new Error("dsh backend not started")
    const session = await this.connection.newSession({ cwd: this.config.cwd, mcpServers: [] })
    this.sessionId = session.sessionId
    this.messages.clear()
    this.toolCallToMessage.clear()
    this.currentMessageId = undefined
    return { id: session.sessionId, directory: this.config.cwd }
  }

  async getMessages(_sessionID: string): Promise<Message[]> {
    return [...this.messages.values()]
  }

  // dsh's ACP has no `providers/list` (returns "Method not found"), so the
  // provider/MCP/skills surfaces are reconstructed statically from the profile
  // patch file (~/.dsh/profiles/<profile>/cordis.patch.yml), which is where
  // llm-pi-ai providers, mcp-client entries, and skill-filesystem dirs live.

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.getProviderList()
    return result.all
  }

  async getProviderList(): Promise<ProviderListResult> {
    const providers = this.patchProviders()
    const all: ProviderInfo[] = Object.entries(providers).map(([id, p]) => ({
      id,
      name: p.displayName ?? id,
      models: Object.fromEntries(p.models.map((m) => [m.id, { id: m.id, name: m.id }])),
      source: "config",
    }))
    return { all, connected: all.map((p) => p.id), default: {} }
  }

  async getMcpStatus(): Promise<Record<string, McpStatus>> {
    const out: Record<string, McpStatus> = {}
    for (const name of this.patchMcpServerNames()) out[name] = { status: "configured" }
    return out
  }

  async listSkills(): Promise<SkillInfo[]> {
    return scanSkills(this.skillDirs())
  }

  private skillDirs(): string[] {
    const custom = this.patchSkillDirs()
    // skill-filesystem always scans ~/.agents/skills (DSH_AGENTS_HOME) in
    // addition to the custom dirs declared in the patch.
    const agentsHome = process.env.DSH_AGENTS_HOME?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), ".agents")
    return [...custom, join(agentsHome, "skills")]
  }

  // --- patch file plumbing ---

  private patchPath(): string {
    const home = process.env.DSH_HOME?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), ".dsh")
    return join(home, "profiles", this.profileName(), "cordis.patch.yml")
  }

  private profileName(): string {
    const args = this.config.args ?? ["--profile", "acp"]
    const idx = args.indexOf("--profile")
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
    return "acp"
  }

  private readPatch(): unknown[] {
    const path = this.patchPath()
    if (!existsSync(path)) return []
    try {
      const parsed = parseYaml(readFileSync(path, "utf8"))
      return Array.isArray(parsed) ? (parsed as unknown[]) : []
    } catch {
      return []
    }
  }

  private patchProviders(): Record<string, DshProvider> {
    for (const entry of this.readPatch()) {
      const e = entry as { id?: string; config?: { providers?: Record<string, DshProvider> } }
      if (e.id === "llm-pi-ai" && e.config?.providers) return e.config.providers
    }
    return {}
  }

  private patchMcpServerNames(): string[] {
    const names: string[] = []
    for (const entry of this.readPatch()) {
      const inserts = (entry as { insert?: unknown }).insert
      if (!Array.isArray(inserts)) continue
      for (const item of inserts) {
        const it = item as { name?: string; config?: { serverName?: string } }
        if (it.name === "@deepseek-ai/dsh-mcp-client" && it.config?.serverName) names.push(it.config.serverName)
      }
    }
    return names
  }

  private patchSkillDirs(): string[] {
    for (const entry of this.readPatch()) {
      const e = entry as { id?: string; config?: { customSkillDirs?: unknown } }
      if (e.id === "skill-filesystem" && Array.isArray(e.config?.customSkillDirs)) {
        return e.config.customSkillDirs.filter((d): d is string => typeof d === "string")
      }
    }
    return []
  }

  async prompt(input: PromptInput): Promise<void> {
    const sessionId = this.sessionId
    if (!this.connection || !sessionId) throw new Error("dsh backend not started")

    const messageID = makeMessageID()
    const textPart = { id: makePartID(), type: "text" as const, text: input.text }
    this.messages.set(messageID, {
      id: messageID,
      role: "user",
      time: { created: Date.now() },
      parts: [textPart],
    })
    this.emit({ kind: "message.upsert", message: { id: messageID, role: "user", time: { created: Date.now() } } })
    this.emit({ kind: "part.upsert", sessionID: sessionId, messageID, part: textPart })

    this.emit({ kind: "session.status", sessionID: sessionId, status: "busy" })
    try {
      const prompt: ContentBlock[] = [{ type: "text", text: input.text }]
      await this.connection.prompt({ sessionId, prompt })
    } finally {
      this.emit({ kind: "session.status", sessionID: sessionId, status: "idle" })
    }
  }

  async abort(_sessionID: string): Promise<void> {
    if (!this.connection || !this.sessionId) return
    await this.connection.cancel({ sessionId: this.sessionId })
  }

  subscribe(handlers: Handlers): () => void {
    this.handlers = handlers
    return () => {
      if (this.handlers === handlers) this.handlers = undefined
    }
  }

  private buildClient(): Client {
    return {
      requestPermission: async (params) => {
        // Follow-up: surface params.options via permission.asked and resolve the
        // pending outcome from the webview. For now decline so the turn does not
        // hang waiting on a decision that never arrives.
        return { outcome: { outcome: "cancelled" } }
      },
      sessionUpdate: async (params) => this.handleUpdate(params.update),
    }
  }

  private handleUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.handleContentChunk(update.messageId, update.content, "text")
        return
      case "agent_thought_chunk":
        this.handleContentChunk(update.messageId, update.content, "reasoning")
        return
      case "tool_call":
        this.handleToolCall(update)
        return
      case "tool_call_update":
        this.handleToolCallUpdate(update)
        return
      case "usage_update":
        this.handleUsage(update.used, update.size)
        return
      default:
        return
    }
  }

  private handleContentChunk(
    messageId: string | null | undefined,
    content: ContentBlock,
    partType: "text" | "reasoning",
  ): void {
    const text = content.type === "text" ? content.text : ""
    const id = this.ensureAssistantMessage(messageId)
    const part =
      partType === "reasoning"
        ? { id: makePartID(), type: "reasoning" as const, text }
        : { id: makePartID(), type: "text" as const, text }
    this.appendPart(id, part)
  }

  private handleToolCall(update: { toolCallId: string; title: string; status?: string; rawInput?: unknown }): void {
    const messageID = this.ensureAssistantMessage(this.currentMessageId)
    this.toolCallToMessage.set(update.toolCallId, messageID)
    const part = {
      id: makePartID(),
      type: "tool" as const,
      callID: update.toolCallId,
      tool: update.title,
      title: update.title,
      status: "running" as const,
      input: update.rawInput,
      time: { start: Date.now() },
    }
    this.appendPart(messageID, part)
  }

  private handleToolCallUpdate(update: ToolCallUpdate): void {
    const messageID = this.toolCallToMessage.get(update.toolCallId)
    if (!messageID) return
    this.toolCallToMessage.delete(update.toolCallId)

    const message = this.messages.get(messageID)
    if (!message) return
    const existing = message.parts.find(
      (p): p is Extract<typeof p, { type: "tool" }> => p.type === "tool" && p.callID === update.toolCallId,
    )
    if (!existing) return

    const text = (update.content ?? [])
      .flatMap((c) => (c.type === "content" && c.content.type === "text" ? [c.content.text] : []))
      .join("")

    const next =
      update.status === "failed"
        ? { ...existing, status: "error" as const, error: text || "tool failed", time: { ...existing.time, end: Date.now() } }
        : { ...existing, status: "completed" as const, output: text, time: { ...existing.time, end: Date.now() } }

    message.parts = message.parts.map((p) => (p.id === existing.id ? next : p))
    this.emit({ kind: "part.upsert", sessionID: this.sessionId ?? "", messageID, part: next })
  }

  private handleUsage(used: number, size: number): void {
    const messageID = this.currentMessageId
    if (!messageID) return
    const message = this.messages.get(messageID)
    if (!message) return
    message.tokens = { input: used, output: 0, reasoning: 0 }
    this.emit({
      kind: "message.upsert",
      message: { id: message.id, role: message.role, time: message.time, tokens: message.tokens },
    })
  }

  private ensureAssistantMessage(messageId: string | null | undefined): string {
    if (messageId && !this.messages.has(messageId)) {
      this.messages.set(messageId, {
        id: messageId,
        role: "assistant",
        time: { created: Date.now() },
        parts: [],
      })
      this.emit({
        kind: "message.upsert",
        message: { id: messageId, role: "assistant", time: { created: Date.now() } },
      })
    }
    const id = messageId ?? makeMessageID()
    this.currentMessageId = id
    if (!this.messages.has(id)) {
      this.messages.set(id, { id, role: "assistant", time: { created: Date.now() }, parts: [] })
      this.emit({ kind: "message.upsert", message: { id, role: "assistant", time: { created: Date.now() } } })
    }
    return id
  }

  private appendPart(messageID: string, part: Message["parts"][number]): void {
    const message = this.messages.get(messageID)
    if (message) message.parts.push(part)
    this.emit({ kind: "part.upsert", sessionID: this.sessionId ?? "", messageID, part })
  }

  private emit(u: NeutralUpdate): void {
    this.handlers?.onUpdate(u)
  }

  private setStatus(s: BackendStatus): void {
    this.handlers?.onStatus(s)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
