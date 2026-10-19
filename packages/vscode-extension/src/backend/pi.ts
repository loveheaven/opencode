// Pi backend over its headless JSONL RPC protocol.
//
// Pi (https://pi.dev, the `@earendil-works/pi-coding-agent` CLI) has no ACP or
// opencode-style HTTP surface. It exposes a long-lived subprocess protocol:
// `pi --mode rpc --no-session`, one JSON record per line on stdin/stdout —
// commands in, `response` + session events out. This backend speaks that
// protocol directly (no pi SDK dependency) and folds the event stream into the
// neutral model (model.ts) for the webview.
//
// Known gaps, inherent to pi's RPC surface (not this adapter):
//   - Single session: pi's RPC has no session/list; listSessions() returns at
//     most the one active session (from get_state). createSession() maps to
//     pi's `new_session`.
//   - No stable message ids: AgentMessage carries no id, so this backend mints
//     local ids and reconstructs them on each getMessages().
//   - Streaming arrives as `message_update` deltas (text_delta / thinking_delta
//     / toolcall_*), which we accumulate into whole parts.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  makeMessageID,
  makePartID,
  type Message,
  type MessageInfo,
  type NeutralUpdate,
  type Part,
  type Session,
  type TokenUsage,
  type ToolPart,
} from "../model"
import type { McpStatus, ProviderInfo, ProviderListResult, SkillInfo } from "../types"
import { scanSkills } from "./skill-scan"
import type { Backend, BackendCapabilities, BackendStatus, PromptInput } from "./index"

export type PiConfig = {
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
}

type Handlers = {
  onUpdate: (u: NeutralUpdate) => void
  onStatus: (s: BackendStatus) => void
}

// --- pi wire types (loose; only the fields this backend reads) ---

type PiTextContent = { type: "text"; text: string }
type PiThinkingContent = { type: "thinking"; thinking: string }
type PiToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
type PiUsage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

// One entry from `get_available_models`. pi reports the provider each model
// belongs to, which is how we reconstruct the configured provider list.
type PiModel = {
  id: string
  name?: string
  provider: string
  baseUrl?: string
}

type PiAssistantMessage = {
  role: "assistant"
  content: Array<PiTextContent | PiThinkingContent | PiToolCall>
  usage?: PiUsage
  stopReason?: string
  errorMessage?: string
  model?: string
  provider?: string
  timestamp?: number
}

type PiUserMessage = {
  role: "user"
  content: string | Array<PiTextContent | { type: "image"; data: string; mimeType: string }>
  timestamp?: number
}

type PiMessage = PiUserMessage | PiAssistantMessage | { role: string; [key: string]: unknown }

type PiAssistantMessageEvent =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCall }

type PiEvent = {
  type: string
  message?: PiMessage
  usage?: PiUsage
  assistantMessageEvent?: PiAssistantMessageEvent
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  durationMs?: number
  aborted?: boolean
  [key: string]: unknown
}

type PiCommandResponse = {
  id?: string
  type: "response"
  command: string
  success: boolean
  data?: unknown
  error?: string
}

const REQUEST_TIMEOUT_MS = 30_000

// pi's static provider catalogue. Configured providers are reconstructed from
// get_available_models (see configuredProviders); this list fills the "More"
// section with providers pi knows about but the user hasn't configured yet.
// Each entry is a provider id (as used in ~/.pi/agent/auth.json) paired with
// the display name and the single API-key env var pi reads for it (from pi's
// providers docs). Providers that need extra config or ambient cloud
// credentials are omitted — configure those with pi's own `/login`.
type PiProviderMeta = { id: string; name: string; env: string }

const PI_PROVIDERS: readonly PiProviderMeta[] = [
  { id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY" },
  { id: "ant-ling", name: "Ant Ling", env: "ANT_LING_API_KEY" },
  { id: "openai", name: "OpenAI", env: "OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY" },
  { id: "nvidia", name: "NVIDIA NIM", env: "NVIDIA_API_KEY" },
  { id: "google", name: "Google Gemini", env: "GEMINI_API_KEY" },
  { id: "github-copilot", name: "GitHub Copilot", env: "COPILOT_GITHUB_TOKEN" },
  { id: "mistral", name: "Mistral", env: "MISTRAL_API_KEY" },
  { id: "groq", name: "Groq", env: "GROQ_API_KEY" },
  { id: "cerebras", name: "Cerebras", env: "CEREBRAS_API_KEY" },
  { id: "xai", name: "xAI", env: "XAI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", env: "AI_GATEWAY_API_KEY" },
  { id: "zai", name: "ZAI Coding Plan (Global)", env: "ZAI_API_KEY" },
  { id: "zai-coding-cn", name: "ZAI Coding Plan (China)", env: "ZAI_CODING_CN_API_KEY" },
  { id: "opencode", name: "OpenCode Zen", env: "OPENCODE_API_KEY" },
  { id: "opencode-go", name: "OpenCode Go", env: "OPENCODE_API_KEY" },
  { id: "radius", name: "Radius", env: "RADIUS_API_KEY" },
  { id: "typesafe", name: "TypeSafe", env: "TYPESAFE_API_KEY" },
  { id: "huggingface", name: "Hugging Face", env: "HF_TOKEN" },
  { id: "fireworks", name: "Fireworks", env: "FIREWORKS_API_KEY" },
  { id: "together", name: "Together AI", env: "TOGETHER_API_KEY" },
  { id: "baseten", name: "Baseten", env: "BASETEN_API_KEY" },
  { id: "kimi-coding", name: "Kimi For Coding", env: "KIMI_API_KEY" },
  { id: "meta", name: "Meta", env: "META_API_KEY" },
  { id: "minimax", name: "MiniMax", env: "MINIMAX_API_KEY" },
  { id: "minimax-cn", name: "MiniMax (China)", env: "MINIMAX_CN_API_KEY" },
  { id: "moonshotai", name: "Moonshot AI (Global)", env: "MOONSHOT_API_KEY" },
  { id: "moonshotai-cn", name: "Moonshot AI (China)", env: "MOONSHOT_API_KEY" },
  { id: "qwen-token-plan", name: "Qwen Token Plan", env: "QWEN_TOKEN_PLAN_API_KEY" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan (China)", env: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  { id: "xiaomi", name: "Xiaomi MiMo", env: "XIAOMI_API_KEY" },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi MiMo Token Plan (China)", env: "XIAOMI_TOKEN_PLAN_CN_API_KEY" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi MiMo Token Plan (Amsterdam)", env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi MiMo Token Plan (Singapore)", env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY" },
]

export class PiBackend implements Backend {
  readonly kind = "pi" as const
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

  private child?: ChildProcess
  private handlers?: Handlers
  private started = false
  private sessionId?: string

  private nextRequestId = 0
  private readonly pending = new Map<string, { resolve: (r: PiCommandResponse) => void; reject: (e: Error) => void }>()
  private stdoutBuffer = ""

  // Local transcript. pi messages have no stable id, so this is the only
  // source for getMessages() and the streaming view; both mint local ids.
  private readonly messages = new Map<string, Message>()
  private currentAssistantId?: string
  private readonly contentParts = new Map<number, { partID: string; text: string }>()
  private readonly toolParts = new Map<string, { messageID: string; partID: string }>()

  constructor(private readonly config: PiConfig) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.setStatus({ state: "starting" })

    const args = this.config.args ?? ["--mode", "rpc", "--continue"]
    this.child = spawn(this.config.command, args, {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.config.env },
    })
    this.child.on("exit", () => {
      if (this.started) this.setStatus({ state: "error", message: "pi process exited" })
      this.rejectAll(new Error("pi process exited"))
    })
    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk.toString()))

    try {
      const state = await this.command("get_state", {})
      this.sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId
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
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = undefined
    this.rejectAll(new Error("pi backend stopped"))
  }

  async listSessions(): Promise<Session[]> {
    if (!this.sessionId) return []
    return [{ id: this.sessionId, directory: this.config.cwd }]
  }

  async createSession(_input?: { title?: string }): Promise<Session> {
    await this.command("new_session", {})
    const state = await this.command("get_state", {})
    this.sessionId = (state.data as { sessionId?: string } | undefined)?.sessionId
    this.messages.clear()
    this.contentParts.clear()
    this.toolParts.clear()
    this.currentAssistantId = undefined
    return { id: this.sessionId ?? "", directory: this.config.cwd }
  }

  async getMessages(_sessionID: string): Promise<Message[]> {
    const res = await this.command("get_messages", {})
    const list = (res.data as { messages?: PiMessage[] } | undefined)?.messages ?? []
    this.messages.clear()
    this.contentParts.clear()
    this.toolParts.clear()
    this.currentAssistantId = undefined
    return list.flatMap((m) => this.recordMessage(m))
  }

  async prompt(input: PromptInput): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId) throw new Error("pi backend not started")

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

    // The response only reports acceptance; the actual turn streams through
    // events and ends with agent_settled, which flips the session back to idle.
    try {
      if (input.model) {
        await this.command("set_model", { provider: input.model.providerID, modelId: input.model.modelID })
      }
      await this.command("prompt", { message: input.text })
    } catch (error) {
      // pi rejected the input (e.g. no API key, already streaming). There will
      // be no agent_settled, so unmark busy before surfacing the error.
      this.emit({ kind: "session.status", sessionID: sessionId, status: "idle" })
      throw error
    }
  }

  async abort(_sessionID: string): Promise<void> {
    await this.command("abort", {})
  }

  async getProviderList(): Promise<ProviderListResult> {
    const configured = await this.configuredProviders()
    const connected = configured.map((p) => p.id)
    // Static catalogue fills the "More" list with providers pi supports but
    // that aren't configured yet.
    const rest = PI_PROVIDERS.filter((p) => !connected.includes(p.id)).map((p) => ({
      id: p.id,
      name: p.name,
      env: [p.env],
    }))
    return { all: [...configured, ...rest], connected, default: {} }
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.getProviderList()
    if (result.connected.length > 0) return result.all.filter((p) => result.connected.includes(p.id))
    return result.all
  }

  // pi has no RPC to enumerate skills; it discovers them by scanning the
  // `skills` directories in settings.json for SKILL.md files. We mirror that
  // scan directly so the Skills tab shows what pi will actually load.
  async listSkills(): Promise<SkillInfo[]> {
    return scanSkills(this.settingsSkillsDirs())
  }

  private settingsSkillsDirs(): string[] {
    const path = this.settingsPath()
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
      const skills = (parsed as { skills?: unknown }).skills
      if (!Array.isArray(skills)) return []
      return skills.filter((s): s is string => typeof s === "string").map((s) => s.replace(/^~(?=\/|$)/, homedir()))
    } catch {
      return []
    }
  }

  private settingsPath(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR
    if (envDir) return join(envDir.replace(/^~(?=\/|$)/, homedir()), "settings.json")
    return join(homedir(), ".pi", "agent", "settings.json")
  }

  // pi has no MCP runtime RPC (no connect/disconnect/status), but it reads
  // server definitions from mcp.json. List them statically so the MCP tab
  // shows what's configured; the webview renders pi servers as "configured"
  // with no enable/disable controls.
  async getMcpStatus(): Promise<Record<string, McpStatus>> {
    const path = this.mcpPath()
    if (!existsSync(path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      const servers = (parsed as { mcpServers?: unknown }).mcpServers
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {}
      const out: Record<string, McpStatus> = {}
      for (const name of Object.keys(servers as Record<string, unknown>)) out[name] = { status: "configured" }
      return out
    } catch {
      return {}
    }
  }

  private mcpPath(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR
    if (envDir) return join(envDir.replace(/^~(?=\/|$)/, homedir()), "mcp.json")
    return join(homedir(), ".pi", "agent", "mcp.json")
  }

  // Reconstruct configured providers from get_available_models: pi groups its
  // models by provider, so each distinct provider value is one configured
  // provider with its models attached. Falls back to [] when pi isn't running.
  private async configuredProviders(): Promise<ProviderInfo[]> {
    try {
      const res = await this.command("get_available_models", {})
      const models = (res.data as { models?: PiModel[] } | undefined)?.models ?? []
      const grouped = new Map<string, PiModel[]>()
      for (const m of models) {
        const list = grouped.get(m.provider) ?? []
        list.push(m)
        grouped.set(m.provider, list)
      }
      return [...grouped.entries()].map(([id, ms]) => ({
        id,
        name: id,
        models: Object.fromEntries(ms.map((m) => [m.id, { id: m.id, name: m.name ?? m.id }])),
        source: "config" as const,
      }))
    } catch {
      return []
    }
  }

  subscribe(handlers: Handlers): () => void {
    this.handlers = handlers
    return () => {
      if (this.handlers === handlers) this.handlers = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // JSONL plumbing
  // ---------------------------------------------------------------------------

  private command(type: string, params: Record<string, unknown>): Promise<PiCommandResponse> {
    const id = `req_${++this.nextRequestId}`
    const line = JSON.stringify({ id, type, ...params })
    this.child?.stdin?.write(line + "\n")
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`pi request timeout: ${type}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  private onStdout(text: string): void {
    this.stdoutBuffer += text
    let index
    while ((index = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (!line) continue
      let record: { type?: string; id?: string; [key: string]: unknown }
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.type === "response" && record.id) {
        const pending = this.pending.get(record.id)
        if (pending) {
          this.pending.delete(record.id)
          if (record.success === false) pending.reject(new Error(String(record.error ?? "pi request failed")))
          else pending.resolve(record as unknown as PiCommandResponse)
        }
        continue
      }
      this.handleEvent(record as unknown as PiEvent)
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  // ---------------------------------------------------------------------------
  // event -> neutral mapping
  // ---------------------------------------------------------------------------

  private handleEvent(event: PiEvent): void {
    switch (event.type) {
      case "message_start":
        this.handleMessageStart(event)
        return
      case "message_update":
        this.handleMessageUpdate(event)
        return
      case "message_end":
        this.handleMessageEnd(event)
        return
      case "tool_execution_start":
        this.handleToolExecutionStart(event)
        return
      case "tool_execution_end":
        this.handleToolExecutionEnd(event)
        return
      case "agent_settled":
        this.emit({ kind: "session.status", sessionID: this.sessionId, status: "idle" })
        return
      default:
        return
    }
  }

  private handleMessageStart(event: PiEvent): void {
    const message = event.message
    if (!message || message.role !== "assistant") return
    this.currentAssistantId = makeMessageID()
    const info: MessageInfo = {
      id: this.currentAssistantId,
      role: "assistant",
      time: { created: (message as PiAssistantMessage).timestamp ?? Date.now() },
      model: modelOf(message as PiAssistantMessage),
    }
    this.messages.set(this.currentAssistantId, { ...info, parts: [] })
    this.contentParts.clear()
    this.emit({ kind: "message.upsert", message: info })
  }

  private handleMessageUpdate(event: PiEvent): void {
    const id = this.ensureAssistantMessage()
    const update = event.assistantMessageEvent
    if (!update) return

    switch (update.type) {
      case "text_start":
      case "thinking_start":
        this.contentParts.set(update.contentIndex, { partID: makePartID(), text: "" })
        return
      case "text_delta":
        this.appendDelta(id, update.contentIndex, update.delta, "text")
        return
      case "text_end":
        this.finishContent(id, update.contentIndex, update.content, "text")
        return
      case "thinking_delta":
        this.appendDelta(id, update.contentIndex, update.delta, "reasoning")
        return
      case "thinking_end":
        this.finishContent(id, update.contentIndex, update.content, "reasoning")
        return
      case "toolcall_start": {
        const part = this.newToolPart(id, update.id, update.toolName)
        this.toolParts.set(update.id, { messageID: id, partID: part.id })
        return
      }
      case "toolcall_end": {
        const existing = this.toolParts.get(update.toolCall.id)
        if (existing) this.patchToolPart(existing, { input: update.toolCall.arguments })
        return
      }
      default:
        return
    }
  }

  private handleMessageEnd(event: PiEvent): void {
    const message = event.message
    if (!message || message.role !== "assistant") return
    const id = this.currentAssistantId
    if (id) {
      const assistant = message as PiAssistantMessage
      const tokens = usageOf(assistant.usage)
      const error = assistant.errorMessage
        ? { name: assistant.stopReason ?? "error", message: assistant.errorMessage }
        : undefined
      this.emit({ kind: "message.upsert", message: this.messageInfo(id, tokens, error) })
      const existing = this.messages.get(id)
      if (existing) {
        existing.tokens = tokens
        existing.error = error
      }
    }
    this.currentAssistantId = undefined
    this.contentParts.clear()
  }

  private handleToolExecutionStart(event: PiEvent): void {
    const target = event.toolCallId ? this.toolParts.get(event.toolCallId) : undefined
    if (!target) return
    this.patchToolPart(target, {
      status: "running",
      input: event.args,
      time: { start: Date.now() },
    })
  }

  private handleToolExecutionEnd(event: PiEvent): void {
    const target = event.toolCallId ? this.toolParts.get(event.toolCallId) : undefined
    if (!target) return
    const output = resultText(event.result)
    const existing = this.partOf(target)
    this.patchToolPart(target, {
      status: event.isError ? "error" : "completed",
      ...(event.isError ? { error: output || "tool failed" } : { output }),
      time: { start: existing?.time?.start ?? Date.now(), end: Date.now() },
    })
  }

  // ---------------------------------------------------------------------------
  // part/message helpers
  // ---------------------------------------------------------------------------

  private ensureAssistantMessage(): string {
    if (this.currentAssistantId) return this.currentAssistantId
    this.currentAssistantId = makeMessageID()
    const info: MessageInfo = {
      id: this.currentAssistantId,
      role: "assistant",
      time: { created: Date.now() },
    }
    this.messages.set(this.currentAssistantId, { ...info, parts: [] })
    this.emit({ kind: "message.upsert", message: info })
    return this.currentAssistantId
  }

  private appendDelta(messageID: string, contentIndex: number, delta: string, type: "text" | "reasoning"): void {
    let slot = this.contentParts.get(contentIndex)
    if (!slot) {
      slot = { partID: makePartID(), text: "" }
      this.contentParts.set(contentIndex, slot)
    }
    slot.text += delta
    const part =
      type === "reasoning"
        ? { id: slot.partID, type: "reasoning" as const, text: slot.text }
        : { id: slot.partID, type: "text" as const, text: slot.text }
    this.appendPart(messageID, part)
  }

  private finishContent(messageID: string, contentIndex: number, content: string, type: "text" | "reasoning"): void {
    let slot = this.contentParts.get(contentIndex)
    if (!slot) {
      slot = { partID: makePartID(), text: "" }
      this.contentParts.set(contentIndex, slot)
    }
    slot.text = content
    const part =
      type === "reasoning"
        ? { id: slot.partID, type: "reasoning" as const, text: content }
        : { id: slot.partID, type: "text" as const, text: content }
    this.appendPart(messageID, part)
  }

  private newToolPart(messageID: string, callID: string, tool: string): ToolPart {
    const part: ToolPart = {
      id: makePartID(),
      type: "tool",
      callID,
      tool,
      title: tool,
      status: "pending",
      time: { start: Date.now() },
    }
    this.appendPart(messageID, part)
    return part
  }

  private patchToolPart(target: { messageID: string; partID: string }, patch: Partial<ToolPart>): void {
    const message = this.messages.get(target.messageID)
    if (!message) return
    const existing = message.parts.find((p): p is ToolPart => p.type === "tool" && p.id === target.partID)
    if (!existing) return
    const next: ToolPart = { ...existing, ...patch }
    message.parts = message.parts.map((p) => (p.id === existing.id ? next : p))
    this.emit({ kind: "part.upsert", sessionID: this.sessionId ?? "", messageID: target.messageID, part: next })
  }

  private partOf(target: { messageID: string; partID: string }): ToolPart | undefined {
    return this.messages
      .get(target.messageID)
      ?.parts.find((p): p is ToolPart => p.type === "tool" && p.id === target.partID)
  }

  private appendPart(messageID: string, part: Part): void {
    const message = this.messages.get(messageID)
    if (!message) return
    const existingIndex = message.parts.findIndex((p) => p.id === part.id)
    if (existingIndex >= 0) message.parts[existingIndex] = part
    else message.parts.push(part)
    this.emit({ kind: "part.upsert", sessionID: this.sessionId ?? "", messageID, part })
  }

  private messageInfo(id: string, tokens?: TokenUsage, error?: Message["error"]): MessageInfo {
    const message = this.messages.get(id)
    return {
      id,
      role: "assistant",
      time: message?.time ?? { created: Date.now() },
      model: message?.model,
      tokens,
      error,
    }
  }

  /** Map a historical pi message into zero or more neutral messages. */
  private recordMessage(message: PiMessage): Message[] {
    if (message.role === "user") {
      const id = makeMessageID()
      const text = userText(message as PiUserMessage)
      const part = { id: makePartID(), type: "text" as const, text }
      const record: Message = { id, role: "user", time: { created: (message as PiUserMessage).timestamp ?? Date.now() }, parts: [part] }
      this.messages.set(id, record)
      return [record]
    }
    if (message.role === "assistant") {
      const assistant = message as PiAssistantMessage
      const id = makeMessageID()
      const parts = assistant.content.map((block) => {
        if (block.type === "text") return { id: makePartID(), type: "text" as const, text: block.text }
        if (block.type === "thinking") return { id: makePartID(), type: "reasoning" as const, text: block.thinking }
        return {
          id: makePartID(),
          type: "tool" as const,
          callID: block.id,
          tool: block.name,
          title: block.name,
          status: "completed" as const,
          input: block.arguments,
        }
      })
      const record: Message = {
        id,
        role: "assistant",
        time: { created: assistant.timestamp ?? Date.now() },
        model: modelOf(assistant),
        tokens: usageOf(assistant.usage),
        parts,
      }
      this.messages.set(id, record)
      return [record]
    }
    return []
  }

  private emit(u: NeutralUpdate): void {
    this.handlers?.onUpdate(u)
  }

  private setStatus(s: BackendStatus): void {
    this.handlers?.onStatus(s)
  }
}

function modelOf(message: PiAssistantMessage): Message["model"] {
  if (!message.provider || !message.model) return undefined
  return { providerID: message.provider, modelID: message.model }
}

function usageOf(usage: PiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    cache: { read: usage.cacheRead ?? 0, write: usage.cacheWrite ?? 0 },
  }
}

function userText(message: PiUserMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content.filter((c) => c.type === "text").map((c) => (c as PiTextContent).text).join("")
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content
    if (Array.isArray(content)) {
      return content.filter((c) => c && typeof c === "object" && (c as PiTextContent).type === "text")
        .map((c) => (c as PiTextContent).text)
        .join("")
    }
    if (typeof content === "string") return content
  }
  return JSON.stringify(result ?? "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

