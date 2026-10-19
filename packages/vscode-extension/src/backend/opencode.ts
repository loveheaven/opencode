// opencode backend over its private HTTP API.
//
// This backend owns the HTTP calls and the /event SSE stream that the webview
// previously reached through the extension-host proxy (proxyHttp / proxySseOpen
// in extension.ts). It translates opencode's Part objects and event stream into
// the neutral model (model.ts), so the webview no longer talks to opencode's
// URLs directly.
//
// The opencode Part vocabulary maps almost 1:1 onto the neutral model — that is
// deliberate: the neutral model was shaped on opencode's types, with dsh's ACP
// folded in as the narrower peer.

import * as http from "node:http"
import type { Backend, BackendCapabilities, BackendStatus, PromptInput } from "./index"
import { type Message, type MessageInfo, type NeutralUpdate, type Part, type PermissionRequest, type QuestionRequest, type Session } from "../model"
import type {
  AgentInfo,
  CommandInfo,
  McpStatus,
  ProviderInfo,
  ProviderListResult,
  RunCommandInput,
  SkillInfo,
} from "../types"

export type OpencodeConfig = {
  baseUrl: string
  directory: string
}

// opencode's wire types for the HTTP API. Kept local to this backend now that
// the webview no longer talks to opencode directly (sdk.ts was removed).
type OpenSessionInfo = {
  id: string
  parentID?: string
  directory: string
  title?: string
  version?: string
  time?: { created?: number; updated?: number }
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  metadata?: Record<string, unknown>
}

type OpenTextPart = {
  id: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}
type OpenReasoningPart = { id: string; type: "reasoning"; text: string }
type OpenFilePart = { id: string; type: "file"; mime: string; filename?: string; url: string }
type OpenToolPart = {
  id: string
  type: "tool"
  callID: string
  tool: string
  state: OpenToolState
}
type OpenToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
    }
  | { status: "error"; input: Record<string, unknown>; error: string; time: { start: number; end: number } }
type OpenStepPart = { id: string; type: "step-start" | "step-finish" }
type OpenPart =
  | OpenTextPart
  | OpenReasoningPart
  | OpenFilePart
  | OpenToolPart
  | OpenStepPart
  | { id: string; type: string; [key: string]: unknown }

type Handlers = {
  onUpdate: (u: NeutralUpdate) => void
  onStatus: (s: BackendStatus) => void
}

export class OpencodeBackend implements Backend {
  readonly kind = "opencode" as const
  readonly capabilities: BackendCapabilities = {
    providers: true,
    agents: true,
    skills: true,
    mcp: true,
    commands: true,
  }

  private handlers?: Handlers
  private sseReq?: http.ClientRequest
  private started = false

  constructor(private readonly config: OpencodeConfig) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.setStatus({ state: "ready" })
  }

  async stop(): Promise<void> {
    this.started = false
    this.closeSse()
  }

  private url(path: string, extra?: Record<string, string>): string {
    const u = new URL(path, this.config.baseUrl)
    if (this.config.directory) u.searchParams.set("directory", this.config.directory)
    if (extra) for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
    return u.toString()
  }

  private async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetch(this.url(path), {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  async listSessions(): Promise<Session[]> {
    const sessions = await this.json<OpenSessionInfo[]>("/session")
    return sessions.map((s) => ({
      id: s.id,
      directory: s.directory,
      title: s.title,
      time: s.time,
    }))
  }

  async createSession(input?: { title?: string }): Promise<Session> {
    const s = await this.json<OpenSessionInfo>("/session", { method: "POST", body: input ?? {} })
    return { id: s.id, directory: s.directory, title: s.title, time: s.time }
  }

  async getMessages(sessionID: string): Promise<Message[]> {
    const messages = await this.json<Array<{ info: OpenMessageInfo; parts: OpenPart[] }>>(
      `/session/${encodeURIComponent(sessionID)}/message`,
    )
    return messages.map((m) => ({
      id: m.info.id,
      role: m.info.role,
      sessionID: m.info.sessionID,
      time: m.info.time,
      agent: m.info.agent,
      model: m.info.model,
      tokens: m.info.tokens,
      error: m.info.error,
      parts: (m.parts ?? []).map((p) => translatePart(p)),
    }))
  }

  async prompt(input: PromptInput): Promise<void> {
    const parts: Record<string, unknown>[] = []
    if (input.text) parts.push({ type: "text", text: input.text })
    for (const att of input.attachments ?? []) {
      parts.push({ type: "file", mime: att.mime, url: att.url, filename: att.filename })
    }
    const body: Record<string, unknown> = { parts }
    if (input.agent) body.agent = input.agent
    if (input.model) body.model = input.model
    await this.json<void>(`/session/${encodeURIComponent(input.sessionID)}/prompt_async`, {
      method: "POST",
      body,
    })
  }

  async abort(sessionID: string): Promise<void> {
    await this.json<void>(`/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" })
  }

  // ---- opencode management surface ----

  async deleteSession(sessionID: string): Promise<boolean> {
    return this.json<boolean>(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
  }

  async updateSession(sessionID: string, patch: { title?: string }): Promise<Session> {
    const s = await this.json<OpenSessionInfo>(`/session/${encodeURIComponent(sessionID)}`, {
      method: "PATCH",
      body: patch,
    })
    return { id: s.id, directory: s.directory, title: s.title, time: s.time }
  }

  async compactSession(sessionID: string, providerID: string, modelID: string): Promise<boolean> {
    return this.json<boolean>(`/session/${encodeURIComponent(sessionID)}/summarize`, {
      method: "POST",
      body: { providerID, modelID },
    })
  }

  async respondPermission(
    permissionID: string,
    response: "once" | "always" | "reject",
  ): Promise<boolean> {
    return this.json<boolean>(`/permission/${encodeURIComponent(permissionID)}/reply`, {
      method: "POST",
      body: { reply: response },
    })
  }

  async listPermissions(): Promise<PermissionRequest[]> {
    return this.json<PermissionRequest[]>(`/permission`)
  }

  async listQuestions(): Promise<QuestionRequest[]> {
    return this.json<QuestionRequest[]>(`/question`)
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    return this.json<boolean>(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: "POST",
      body: { answers },
    })
  }

  async rejectQuestion(requestID: string): Promise<boolean> {
    return this.json<boolean>(`/question/${encodeURIComponent(requestID)}/reject`, { method: "POST" })
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.json<AgentInfo[]>(`/agent`)
  }

  async listCommands(): Promise<CommandInfo[]> {
    return this.json<CommandInfo[]>(`/command`)
  }

  async listSkills(): Promise<SkillInfo[]> {
    return this.json<SkillInfo[]>(`/skill`)
  }

  async getMcpStatus(): Promise<Record<string, McpStatus>> {
    return this.json<Record<string, McpStatus>>(`/mcp`)
  }

  async mcpConnect(name: string): Promise<void> {
    await this.json<void>(`/mcp/${encodeURIComponent(name)}/connect`, { method: "POST", body: "" })
  }

  async mcpDisconnect(name: string): Promise<void> {
    await this.json<void>(`/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST", body: "" })
  }

  async getProviderList(): Promise<ProviderListResult> {
    const raw = await this.json<ProviderListResult>(`/provider`)
    return raw
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.getProviderList()
    if (result.connected.length > 0) return result.all.filter((p) => result.connected.includes(p.id))
    return result.all
  }

  async runCommand(input: RunCommandInput): Promise<void> {
    const payload: Record<string, unknown> = {
      command: input.command,
      arguments: input.arguments,
    }
    if (input.messageID) payload.messageID = input.messageID
    if (input.agent) payload.agent = input.agent
    if (input.model) payload.model = input.model
    await this.json<void>(`/session/${encodeURIComponent(input.sessionID)}/command`, {
      method: "POST",
      body: payload,
    })
  }

  subscribe(handlers: Handlers): () => void {
    this.handlers = handlers
    this.openSse()
    return () => {
      if (this.handlers === handlers) this.handlers = undefined
      this.closeSse()
    }
  }

  private openSse(): void {
    this.closeSse()
    const url = new URL(this.url("/event"))
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers: { accept: "text/event-stream" },
      },
      (res) => {
        res.setEncoding("utf8")
        let buffer = ""
        res.on("data", (chunk: string) => {
          buffer += chunk
          let idx: number
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue
              const data = line.slice(5).trimStart()
              if (!data) continue
              try {
                this.handleEvent(JSON.parse(data) as OpenEvent)
              } catch {
                // malformed frame; skip
              }
            }
          }
        })
      },
    )
    req.on("error", () => this.closeSse())
    req.end()
    this.sseReq = req
  }

  private closeSse(): void {
    this.sseReq?.destroy()
    this.sseReq = undefined
  }

  private handleEvent(evt: OpenEvent): void {
    switch (evt.type) {
      case "session.created":
      case "session.updated": {
        const info = evt.properties.info as OpenSessionInfo
        this.emit({
          kind: "session.upsert",
          session: { id: info.id, directory: info.directory, title: info.title, time: info.time },
        })
        return
      }
      case "session.deleted":
        this.emit({ kind: "session.deleted", sessionID: evt.properties.sessionID as string })
        return
      case "message.updated":
        this.emit({ kind: "message.upsert", message: messageInfo(evt.properties.info as OpenMessageInfo) })
        return
      case "message.removed":
        this.emit({
          kind: "message.removed",
          sessionID: evt.properties.sessionID as string,
          messageID: evt.properties.messageID as string,
        })
        return
      case "message.part.updated": {
        const part = evt.properties.part as OpenPart & { sessionID?: string; messageID?: string }
        this.emit({
          kind: "part.upsert",
          sessionID: part.sessionID ?? (evt.properties.sessionID as string),
          messageID: part.messageID ?? "",
          part: translatePart(part),
        })
        return
      }
      case "message.part.removed":
        this.emit({
          kind: "part.removed",
          sessionID: evt.properties.sessionID as string,
          messageID: evt.properties.messageID as string,
          partID: evt.properties.partID as string,
        })
        return
      case "message.part.delta":
        this.emit({
          kind: "part.delta",
          sessionID: evt.properties.sessionID as string,
          messageID: evt.properties.messageID as string,
          partID: evt.properties.partID as string,
          field: "text",
          delta: evt.properties.delta as string,
        })
        return
      case "session.status":
        this.emit({
          kind: "session.status",
          sessionID: evt.properties.sessionID as string | undefined,
          status: (evt.properties.status as { type?: string })?.type === "busy" ? "busy" : "idle",
        })
        return
      case "session.idle":
        this.emit({
          kind: "session.status",
          sessionID: evt.properties.sessionID as string | undefined,
          status: "idle",
        })
        return
      case "session.error":
        this.emit({
          kind: "session.error",
          sessionID: evt.properties.sessionID as string | undefined,
          error: evt.properties.error as { name: string; message?: string },
        })
        return
      case "permission.asked":
        this.emit({ kind: "permission.asked", request: evt.properties as unknown as PermissionRequest })
        return
      case "permission.replied":
      case "permission.rejected":
        this.emit({
          kind: "permission.resolved",
          id: (evt.properties.id ?? evt.properties.permissionID) as string,
        })
        return
      case "question.asked":
        this.emit({ kind: "question.asked", request: evt.properties as unknown as QuestionRequest })
        return
      case "question.replied":
      case "question.rejected":
        this.emit({ kind: "question.resolved", id: evt.properties.requestID as string })
        return
      default:
        return
    }
  }

  private emit(u: NeutralUpdate): void {
    this.handlers?.onUpdate(u)
  }

  private setStatus(s: BackendStatus): void {
    this.handlers?.onStatus(s)
  }
}

// opencode's ToolPart carries a discriminated `state`; the neutral model uses a
// flat status + output/error. Everything else maps field-for-field.
function translatePart(p: OpenPart): Part {
  if (p.type === "tool") {
    const state = (p as { state: ToolState }).state
    return {
      id: p.id,
      type: "tool",
      callID: p.callID,
      tool: p.tool,
      title: "title" in state ? state.title : undefined,
      status: state.status === "error" ? "error" : state.status === "completed" ? "completed" : state.status === "running" ? "running" : "pending",
      input: "input" in state ? state.input : undefined,
      output: "output" in state ? state.output : undefined,
      error: "error" in state ? state.error : undefined,
      metadata: "metadata" in state ? state.metadata : undefined,
      time: "time" in state ? state.time : undefined,
    }
  }
  if (p.type === "text" || p.type === "reasoning" || p.type === "file") return p as unknown as Part
  return p as unknown as Part
}

type ToolState = {
  status: "pending" | "running" | "completed" | "error"
  title?: string
  input?: unknown
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

type OpenEvent = { type: string; properties: Record<string, unknown> }

type OpenMessageInfo = {
  id: string
  role: "user" | "assistant"
  sessionID?: string
  time: { created: number }
  agent?: string
  model?: { providerID: string; modelID: string }
  tokens?: { input: number; output: number; reasoning: number }
  error?: { name: string; message?: string }
}

function messageInfo(info: OpenMessageInfo): MessageInfo {
  return {
    id: info.id,
    role: info.role,
    sessionID: info.sessionID,
    time: info.time,
    agent: info.agent,
    model: info.model,
    tokens: info.tokens,
    error: info.error,
  }
}
