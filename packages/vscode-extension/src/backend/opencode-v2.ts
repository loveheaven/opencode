// opencode backend over its v2 HTTP API.
//
// v2 replaced the old `packages/opencode` server (`/session`, `/event`,
// `/session/:id/prompt_async`, unauthenticated) with an Effect-based server
// (see packages/server) whose surface differs in three ways this file bridges:
//
//   1. Auth: every route requires `Authorization: Basic base64("opencode:<pw>")`
//      (or `?auth_token=`) unless the server was started with no password.
//   2. Routes: everything moved under `/api/`, the response bodies are wrapped
//      in `{ data: ... }`, and several endpoints were renamed (prompt is now
//      POST /api/session/:id/prompt, abort → /interrupt, compact → /compact,
//      events → /api/event).
//   3. Model: messages are a tagged union (user / synthetic / assistant /
//      compaction / idle / system / skill / shell / agent-switched / …), the
//      assistant "parts" are inline `content: [{type:text|reasoning|tool}]`
//      without stable ids for text/reasoning, and streaming arrives as
//      granular `session.{step,text,reasoning,tool}.*` events rather than
//      `message.part.updated`.
//
// This backend translates all of that into the neutral model (model.ts) the
// webview already renders, synthesising stable part ids for text/reasoning so
// `part.upsert` / `part.delta` reconciliation keeps working.

import * as http from "node:http"
import type { Backend, BackendCapabilities, BackendStatus, OpencodeConfig, PromptInput } from "./index"
import {
  type Message,
  type MessageInfo,
  type NeutralUpdate,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type TokenUsage,
} from "../model"
import type {
  AgentInfo,
  CommandInfo,
  McpStatus,
  ProviderInfo,
  ProviderListResult,
  RunCommandInput,
  SkillInfo,
} from "../types"

// ---------------------------------------------------------------------------
// v2 wire shapes (loosely typed — only the fields this backend reads).
// ---------------------------------------------------------------------------

type OpenModelRef = { providerID: string; id: string; variant?: string }

type OpenSessionInfo = {
  id: string
  parentID?: string
  title?: string
  agent?: string
  model?: OpenModelRef
  time?: { created?: number; updated?: number }
  location?: { directory?: string }
}

type OpenTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

type OpenMessageBase = {
  id: string
  type: string
  time?: { created?: number }
  metadata?: Record<string, unknown>
}

type OpenUserMessage = OpenMessageBase & {
  type: "user"
  text?: string
  files?: Array<{ uri: string; name?: string; description?: string }>
}

type OpenToolContent =
  | { type: "text"; text: string }
  | { type: "file"; uri?: string; name?: string; mime?: string }

type OpenToolState = {
  status: "streaming" | "running" | "completed" | "error"
  input?: unknown
  content?: OpenToolContent[]
  error?: { type?: string; message?: string }
  metadata?: Record<string, unknown>
}

type OpenAssistantContent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: OpenToolState }

type OpenAssistantMessage = OpenMessageBase & {
  type: "assistant"
  agent?: string
  model?: OpenModelRef
  content?: OpenAssistantContent[]
  tokens?: OpenTokens
  cost?: number
  error?: { type?: string; message?: string }
}

type OpenCompactionMessage = OpenMessageBase & {
  type: "compaction"
  status: "running" | "completed" | "failed"
  summary?: string
  recent?: string
}

type OpenMessage = OpenUserMessage | OpenAssistantMessage | OpenCompactionMessage | OpenMessageBase

// POST /api/session/:id/prompt returns the *admitted inbox item*, not the flat
// message shape getMessages returns. Its user text/files live under `payload`.
type OpenPromptItem = {
  id: string
  sessionID?: string
  time?: { created?: number }
  type: string
  payload?: {
    text?: string
    files?: Array<{
      data?: string
      mime?: string
      source?: { type: string; uri?: string }
      name?: string
      description?: string
    }>
  }
  delivery?: string
}

type OpenAgentInfo = {
  id?: string
  name?: string
  description?: string
  mode?: "primary" | "subagent" | "all"
  hidden?: boolean
}

type OpenProviderInfo = {
  id: string
  name?: string
  activation?: string
}

type OpenModelInfo = {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
}

type OpenCommandInfo = { name: string; description?: string }
type OpenSkillInfo = { id?: string; name?: string; description?: string; path?: string; content?: string }
type OpenMcpServer = {
  name: string
  status: { status: "connected" | "pending" | "disabled" | "failed" | "needs_auth"; error?: string }
}

type OpenPermissionRequest = {
  id: string
  sessionID: string
  action?: string
  resources?: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: string; messageID?: string; id?: string }
}

type OpenFormField = {
  key: string
  type: string
  title?: string
  description?: string
  custom?: boolean
  options?: Array<{ value: string; label: string; description?: string }>
}

type OpenFormInfo = {
  id: string
  sessionID: string
  title: string
  fields?: OpenFormField[]
  // Set by the `question` tool (packages/core/src/tool/plugin/question.ts)
  // so the webview can bind a pending request back to the running tool part.
  metadata?: { kind?: string; tool?: { messageID?: string; id?: string } }
}

type OpenEvent = {
  type: string
  created?: number
  data?: Record<string, unknown> & {
    sessionID?: string
    assistantMessageID?: string
    id?: string
    [key: string]: unknown
  }
}

type Handlers = {
  onUpdate: (u: NeutralUpdate) => void
  onStatus: (s: BackendStatus) => void
}

const MESSAGE_PAGE_LIMIT = 200
const MAX_MESSAGE_PAGES = 500 // safety bound: 100k messages

export class OpencodeV2Backend implements Backend {
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
  // tool input.started announces the tool name; later events reference the tool
  // only by id, so remember the name to keep part.upsert tool names stable.
  private toolNames = new Map<string, string>()
  // Message ids already surfaced through message.upsert. Used by emitNewMessages
  // (the /command path) to avoid re-emitting history the webview already has.
  private knownMessages = new Set<string>()

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

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", ...(extra ?? {}) }
    if (this.config.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${this.config.password}`).toString("base64")}`
    }
    return headers
  }

  private url(path: string, extra?: Record<string, string>): string {
    const u = new URL(path, this.config.baseUrl)
    if (extra) for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
    return u.toString()
  }

  // `location[directory]=…` deepObject query used by the management endpoints
  // (agent/provider/command/skill/mcp). Brackets stay literal in the URL.
  private locationQuery(): Record<string, string> {
    if (!this.config.directory) return {}
    return { "location[directory]": this.config.directory }
  }

  private async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    // `path` may be a relative route ("/api/session/...") or an absolute URL
    // (call sites that already applied this.url() with a query). this.url() is
    // idempotent — an absolute URL passes through unchanged — so routing through
    // it is safe either way and guarantees Node's fetch gets an absolute URL.
    const res = await fetch(this.url(path), {
      method: init?.method ?? "GET",
      headers: this.authHeaders(),
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions(): Promise<Session[]> {
    const query: Record<string, string> = {}
    if (this.config.directory) query.directory = this.config.directory
    const res = await this.json<{ data?: OpenSessionInfo[] }>(this.url("/api/session", query))
    return (res.data ?? []).map(toSession)
  }

  async createSession(input?: { title?: string }): Promise<Session> {
    const body: Record<string, unknown> = {}
    if (input?.title) body.title = input.title
    if (this.config.directory) body.location = { directory: this.config.directory }
    const res = await this.json<{ data?: OpenSessionInfo }>("/api/session", { method: "POST", body })
    return toSession(res.data ?? { id: "" })
  }

  async deleteSession(sessionID: string): Promise<boolean> {
    await this.json<void>(`/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
    return true
  }

  async updateSession(sessionID: string, patch: { title?: string }): Promise<Session> {
    await this.json<void>(`/api/session/${encodeURIComponent(sessionID)}`, { method: "PATCH", body: patch })
    return { id: sessionID, directory: this.config.directory, title: patch.title }
  }

  async compactSession(_sessionID: string, _providerID: string, _modelID: string): Promise<boolean> {
    // v2 compact steers by default and uses the session's own model; the old
    // provider/model arguments no longer apply.
    await this.json<{ data?: unknown }>(`/api/session/${encodeURIComponent(_sessionID)}/compact`, { method: "POST", body: {} })
    return true
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async getMessages(sessionID: string): Promise<Message[]> {
    const out: Message[] = []
    const base = `/api/session/${encodeURIComponent(sessionID)}/message`
    let cursor: string | undefined
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const query: Record<string, string> = {}
      if (cursor) query.cursor = cursor
      else {
        query.order = "asc"
        query.limit = String(MESSAGE_PAGE_LIMIT)
      }
      const res = await this.json<{ data?: OpenMessage[]; cursor?: { next?: string; previous?: string } }>(
        this.url(base, query),
      )
      for (const m of res.data ?? []) {
        const translated = translateMessage(m)
        if (translated) out.push(translated)
      }
      cursor = res.cursor?.next
      if (!cursor) break
    }
    return out
  }

  async prompt(input: PromptInput): Promise<void> {
    const sessionPath = `/api/session/${encodeURIComponent(input.sessionID)}`
    // v2 has no `model` on the prompt payload; model selection is a separate
    // endpoint. Keep the extension's model picker working by switching first.
    if (input.model) {
      await this.json<void>(`${sessionPath}/model`, {
        method: "POST",
        body: { model: { providerID: input.model.providerID, id: input.model.modelID } },
      })
    }
    const body: Record<string, unknown> = { text: input.text }
    if (input.attachments?.length) {
      body.files = input.attachments.map((a) => ({ uri: a.url, name: a.filename }))
    }
    if (input.agent) body.agents = [{ name: input.agent }]
    if (input.skills?.length) body.skills = input.skills.map((id) => ({ id }))
    const res = await this.json<{ data?: OpenPromptItem }>(`${sessionPath}/prompt`, { method: "POST", body })
    // The v2 event stream never emits a "user message created" event (see
    // packages/schema/src/session-event.ts — every event is an assistant
    // execution event). Without this the webview only shows the user's own
    // bubble after the turn finishes and the 3s sync poll reloads the list.
    // The prompt response already carries the persisted user message, so
    // surface it immediately through the normal message/part path.
    this.emitUserMessage(input.sessionID, res.data)
  }

  async abort(sessionID: string): Promise<void> {
    await this.json<unknown>(`/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST" })
  }

  async runCommand(input: RunCommandInput): Promise<void> {
    const body: Record<string, unknown> = {
      name: input.command,
      text: input.arguments ?? "",
    }
    if (input.agent) body.agents = [{ name: input.agent }]
    await this.json<void>(`/api/session/${encodeURIComponent(input.sessionID)}/command`, { method: "POST", body })
    // /command returns 204 with no message id, unlike prompt(). The expanded
    // command message is already persisted by the time the request resolves,
    // so reload the list and emit anything new through the message/part path —
    // otherwise the user's command bubble waits for the 3s sync poll.
    await this.emitNewMessages(input.sessionID)
  }

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  async listPermissions(): Promise<PermissionRequest[]> {
    const res = await this.json<{ data?: OpenPermissionRequest[] }>(
      this.url("/api/permission/request", this.locationQuery()),
    )
    return (res.data ?? []).map(toPermissionRequest)
  }

  async respondPermission(
    sessionID: string,
    permissionID: string,
    response: "once" | "always" | "reject",
  ): Promise<boolean> {
    await this.json<void>(
      `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permissionID)}/reply`,
      { method: "POST", body: { decision: response } },
    )
    return true
  }

  // -------------------------------------------------------------------------
  // Forms (v2's replacement for the v1 `question` tool)
  // -------------------------------------------------------------------------

  async listQuestions(): Promise<QuestionRequest[]> {
    const res = await this.json<{ data?: OpenFormInfo[] }>(this.url("/api/form", this.locationQuery()))
    return (res.data ?? []).map(toQuestionRequest)
  }

  async replyQuestion(sessionID: string, requestID: string, answers: string[][]): Promise<boolean> {
    const detail = await this.json<{ data?: OpenFormInfo & { fields?: OpenFormField[] } }>(
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}`,
    )
    const fields = detail.data?.fields ?? []
    const answer: Record<string, unknown> = {}
    // `answers` is indexed per question (one entry per field). Do not flatten:
    // a multiselect field keeps its whole selection array, and a single-select
    // field takes its first value, keyed by that field's own key.
    fields.forEach((field, i) => {
      const selected = answers?.[i] ?? []
      if (selected.length === 0) return
      if (field.type === "multiselect") answer[field.key] = selected
      else answer[field.key] = selected[0]
    })
    await this.json<void>(`/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}/reply`, {
      method: "POST",
      body: { answer },
    })
    return true
  }

  async rejectQuestion(sessionID: string, requestID: string): Promise<boolean> {
    await this.json<void>(`/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}`, {
      method: "DELETE",
    })
    return true
  }

  // -------------------------------------------------------------------------
  // Management surface
  // -------------------------------------------------------------------------

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.json<{ data?: OpenAgentInfo[] }>(this.url("/api/agent", this.locationQuery()))
    return (res.data ?? []).map((a) => ({
      name: a.id ?? a.name ?? "",
      description: a.description,
      mode: a.mode,
      hidden: a.hidden,
      builtIn: false,
    }))
  }

  async listCommands(): Promise<CommandInfo[]> {
    const res = await this.json<{ data?: OpenCommandInfo[] }>(this.url("/api/command", this.locationQuery()))
    return (res.data ?? []).map((c) => ({ name: c.name, description: c.description }))
  }

  async listSkills(): Promise<SkillInfo[]> {
    const res = await this.json<{ data?: OpenSkillInfo[] }>(this.url("/api/skill", this.locationQuery()))
    return (res.data ?? []).map((s) => ({
      name: s.id ?? s.name ?? "",
      description: s.description,
      location: s.path ?? "",
      content: s.content ?? "",
    }))
  }

  async getMcpStatus(): Promise<Record<string, McpStatus>> {
    const res = await this.json<{ data?: OpenMcpServer[] }>(this.url("/api/mcp", this.locationQuery()))
    const out: Record<string, McpStatus> = {}
    for (const s of res.data ?? []) {
      out[s.name] = mcpStatus(s.status)
    }
    return out
  }

  async mcpConnect(name: string): Promise<void> {
    await this.json<void>(this.url(`/api/experimental/mcp/${encodeURIComponent(name)}/connect`, this.locationQuery()), {
      method: "POST",
      body: "",
    })
  }

  async mcpDisconnect(name: string): Promise<void> {
    await this.json<void>(
      this.url(`/api/experimental/mcp/${encodeURIComponent(name)}/disconnect`, this.locationQuery()),
      { method: "POST", body: "" },
    )
  }

  async getProviderList(): Promise<ProviderListResult> {
    const [providers, models] = await Promise.all([
      this.json<{ data?: OpenProviderInfo[] }>(this.url("/api/provider", this.locationQuery())),
      this.json<{ data?: OpenModelInfo[] }>(this.url("/api/model", this.locationQuery())),
    ])
    const modelsByProvider = groupModels(models.data ?? [])
    const all = (providers.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      models: modelsByProvider.get(p.id),
    }))
    const connected = (providers.data ?? []).filter((p) => p.activation !== "disabled").map((p) => p.id)
    const defaultResult: Record<string, string> = {}
    try {
      const def = await this.json<{ data?: OpenModelInfo }>(this.url("/api/model/default", this.locationQuery()))
      if (def.data?.providerID) {
        defaultResult[def.data.providerID] = def.data.modelID ?? def.data.id ?? ""
      }
    } catch {
      // default model lookup is best-effort
    }
    return { all, connected, default: defaultResult }
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const result = await this.getProviderList()
    if (result.connected.length > 0) return result.all.filter((p) => result.connected.includes(p.id))
    return result.all
  }

  // -------------------------------------------------------------------------
  // Event stream
  // -------------------------------------------------------------------------

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
    const url = new URL("/api/event", this.config.baseUrl)
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (this.config.password) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${this.config.password}`).toString("base64")}`
    }
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers,
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
    const d = evt.data ?? {}
    const sessionID = d.sessionID as string | undefined
    switch (evt.type) {
      case "session.created": {
        this.emit({
          kind: "session.upsert",
          session: {
            id: sessionID ?? "",
            directory: (d.location as { directory?: string } | undefined)?.directory ?? "",
            title: d.title as string | undefined,
          },
        })
        return
      }
      case "session.renamed": {
        this.emit({ kind: "session.upsert", session: { id: sessionID ?? "", directory: "", title: d.title as string } })
        return
      }
      case "session.deleted": {
        this.emit({ kind: "session.deleted", sessionID: sessionID ?? "" })
        return
      }
      case "session.execution.started": {
        this.emit({ kind: "session.status", sessionID, status: "busy" })
        return
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted": {
        this.emit({ kind: "session.status", sessionID, status: "idle" })
        return
      }
      case "session.execution.failed": {
        this.emit({
          kind: "session.error",
          sessionID,
          error: { name: "execution.failed", message: (d.error as { message?: string } | undefined)?.message },
        })
        this.emit({ kind: "session.status", sessionID, status: "idle" })
        return
      }
      case "session.step.started": {
        const assistantMessageID = d.assistantMessageID as string
        this.emitMessage({
          id: assistantMessageID,
          role: "assistant",
          sessionID,
          agent: d.agent as string | undefined,
          model: modelRef(d.model as OpenModelRef | undefined),
          time: { created: evt.created ?? Date.now() },
        })
        return
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended": {
        this.handleTextEvent(evt, sessionID ?? "", "text")
        return
      }
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended": {
        this.handleTextEvent(evt, sessionID ?? "", "reasoning")
        return
      }
      case "session.tool.input.started": {
        const id = d.id as string
        const assistantMessageID = d.assistantMessageID as string
        this.toolNames.set(id, (d.name as string) ?? id)
        this.emit({
          kind: "part.upsert",
          sessionID: sessionID ?? "",
          messageID: assistantMessageID,
          part: { id, type: "tool", callID: id, tool: (d.name as string) ?? id, status: "pending" },
        })
        return
      }
      case "session.tool.called": {
        const id = d.id as string
        this.emit({
          kind: "part.upsert",
          sessionID: sessionID ?? "",
          messageID: d.assistantMessageID as string,
          part: {
            id,
            type: "tool",
            callID: id,
            tool: this.toolNames.get(id) ?? id,
            status: "running",
            input: d.input,
            metadata: d.state as Record<string, unknown> | undefined,
          },
        })
        return
      }
      case "session.tool.progress": {
        const id = d.id as string
        this.emit({
          kind: "part.upsert",
          sessionID: sessionID ?? "",
          messageID: d.assistantMessageID as string,
          part: {
            id,
            type: "tool",
            callID: id,
            tool: this.toolNames.get(id) ?? id,
            status: "running",
            metadata: d.metadata as Record<string, unknown> | undefined,
          },
        })
        return
      }
      case "session.tool.success": {
        const id = d.id as string
        this.emit({
          kind: "part.upsert",
          sessionID: sessionID ?? "",
          messageID: d.assistantMessageID as string,
          part: {
            id,
            type: "tool",
            callID: id,
            tool: this.toolNames.get(id) ?? id,
            status: "completed",
            output: toolContentText(d.content as OpenToolContent[] | undefined),
            metadata: d.metadata as Record<string, unknown> | undefined,
          },
        })
        return
      }
      case "session.tool.failed": {
        const id = d.id as string
        this.emit({
          kind: "part.upsert",
          sessionID: sessionID ?? "",
          messageID: d.assistantMessageID as string,
          part: {
            id,
            type: "tool",
            callID: id,
            tool: this.toolNames.get(id) ?? id,
            status: "error",
            error: (d.error as { message?: string } | undefined)?.message ?? "tool failed",
            metadata: d.metadata as Record<string, unknown> | undefined,
          },
        })
        return
      }
      case "session.step.ended": {
        this.emitMessage({
          id: d.assistantMessageID as string,
          role: "assistant",
          sessionID,
          time: { created: evt.created ?? Date.now() },
          tokens: mapTokens(d.tokens as OpenTokens | undefined),
          cost: d.cost as number | undefined,
        })
        return
      }
      case "session.step.failed": {
        this.emitMessage({
          id: d.assistantMessageID as string,
          role: "assistant",
          sessionID,
          time: { created: evt.created ?? Date.now() },
          error: { name: "step.failed", message: (d.error as { message?: string } | undefined)?.message },
          tokens: mapTokens(d.tokens as OpenTokens | undefined),
          cost: d.cost as number | undefined,
        })
        return
      }
      case "permission.asked": {
        this.emit({ kind: "permission.asked", request: toPermissionRequest(d as unknown as OpenPermissionRequest) })
        return
      }
      case "permission.replied":
      case "permission.rejected": {
        this.emit({ kind: "permission.resolved", id: ((d.requestID ?? d.id) as string) ?? "" })
        return
      }
      case "form.created": {
        this.emit({ kind: "question.asked", request: toQuestionRequest((d.form ?? d) as unknown as OpenFormInfo) })
        return
      }
      case "form.replied":
      case "form.cancelled": {
        this.emit({ kind: "question.resolved", id: (d.id as string) ?? "" })
        return
      }
      default:
        return
    }
  }

  private handleTextEvent(evt: OpenEvent, sessionID: string, kind: "text" | "reasoning"): void {
    const d = evt.data ?? {}
    const messageID = d.assistantMessageID as string
    const ordinal = Number(d.ordinal ?? 0)
    const partID = textPartID(messageID, kind, ordinal)
    if (evt.type.endsWith(".started")) {
      this.emit({
        kind: "part.upsert",
        sessionID,
        messageID,
        part: { id: partID, type: kind, text: "" },
      })
    } else if (evt.type.endsWith(".delta")) {
      this.emit({
        kind: "part.delta",
        sessionID,
        messageID,
        partID,
        field: "text",
        delta: (d.delta as string) ?? "",
      })
    } else {
      this.emit({
        kind: "part.upsert",
        sessionID,
        messageID,
        part: { id: partID, type: kind, text: (d.text as string) ?? "" },
      })
    }
  }

  /**
   * Surface a just-persisted user message immediately.
   *
   * The v2 event bus has no "user message created" event, so the webview
   * would otherwise not render the user's own bubble until the turn finishes
   * and the 3s sync poll reloads. The prompt response already carries the
   * persisted message (id minted by the server), so we surface it through the
   * normal message/part path — keeping the id in the server's id-space.
   */
  private emitUserMessage(sessionID: string, item: OpenPromptItem | undefined): void {
    if (!item) return
    const text = item.payload?.text
    const files = item.payload?.files ?? []
    if (!text && files.length === 0) return
    const parts: Part[] = []
    if (text) parts.push({ id: textPartID(item.id, "text", 0), type: "text", text })
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      // materializeAttachment returns the file content as `{ data, mime, source }`
      // (base64), not a plain `uri`. Rebuild a usable URL so image attachments
      // still render as a preview and other files keep their name badge.
      const url =
        f.source?.type === "uri" && f.source.uri
          ? f.source.uri
          : f.data && f.mime
            ? `data:${f.mime};base64,${f.data}`
            : ""
      parts.push({
        id: `${item.id}/file/${i}`,
        type: "file",
        mime: f.mime ?? "",
        url,
        filename: f.name,
      })
    }
    this.emitMessage({
      id: item.id,
      role: "user",
      sessionID,
      time: { created: item.time?.created ?? 0 },
    })
    for (const part of parts) {
      this.emit({ kind: "part.upsert", sessionID, messageID: item.id, part })
    }
  }

  /** Emit a message.upsert and remember the id so refresh paths don't re-send it. */
  private emitMessage(info: MessageInfo): void {
    this.knownMessages.add(info.id)
    this.emit({ kind: "message.upsert", message: info })
  }

  /**
   * Reload a session's messages and emit anything the webview hasn't seen yet.
   * Used by /command, whose response carries no message id.
   */
  private async emitNewMessages(sessionID: string): Promise<void> {
    const messages = await this.getMessages(sessionID)
    for (const m of messages) {
      if (this.knownMessages.has(m.id)) continue
      const { parts, ...info } = m
      this.emitMessage({ ...info, sessionID })
      for (const part of parts) {
        this.emit({ kind: "part.upsert", sessionID, messageID: m.id, part })
      }
    }
  }

  private emit(u: NeutralUpdate): void {
    this.handlers?.onUpdate(u)
  }

  private setStatus(s: BackendStatus): void {
    this.handlers?.onStatus(s)
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function toSession(s: OpenSessionInfo): Session {
  return {
    id: s.id,
    directory: s.location?.directory ?? "",
    title: s.title,
    time: { created: s.time?.created, updated: s.time?.updated },
  }
}

function modelRef(m?: OpenModelRef): { providerID: string; modelID: string } | undefined {
  if (!m?.providerID || !m.id) return undefined
  return { providerID: m.providerID, modelID: m.id }
}

function mapTokens(t?: OpenTokens): TokenUsage | undefined {
  if (!t) return undefined
  const usage: TokenUsage = {
    input: t.input ?? 0,
    output: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
  }
  if (t.cache) usage.cache = { read: t.cache.read ?? 0, write: t.cache.write ?? 0 }
  return usage
}

// Stable synthetic part id for a text/reasoning block. v2 doesn't assign ids to
// these, so we derive one from (message, kind, ordinal) that is identical in
// both the streaming path and the snapshot (getMessages) path.
function textPartID(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return `${messageID}/${kind}/${ordinal}`
}

function translateMessage(m: OpenMessage): Message | undefined {
  switch (m.type) {
    case "user": {
      const u = m as OpenUserMessage
      const parts: Part[] = []
      if (u.text) parts.push({ id: textPartID(u.id, "text", 0), type: "text", text: u.text })
      for (let i = 0; i < (u.files?.length ?? 0); i++) {
        const f = u.files![i]
        parts.push({ id: `${u.id}/file/${i}`, type: "file", mime: "", url: f.uri, filename: f.name })
      }
      return {
        id: u.id,
        role: "user",
        time: { created: u.time?.created ?? 0 },
        parts,
      }
    }
    case "synthetic": {
      const u = m as OpenUserMessage
      return {
        id: u.id,
        role: "user",
        time: { created: u.time?.created ?? 0 },
        parts: u.text ? [{ id: textPartID(u.id, "text", 0), type: "text", text: u.text, synthetic: true }] : [],
      }
    }
    case "assistant": {
      const a = m as OpenAssistantMessage
      const parts: Part[] = []
      let textOrd = 0
      let reasoningOrd = 0
      for (const c of a.content ?? []) {
        if (c.type === "text") {
          parts.push({ id: textPartID(a.id, "text", textOrd++), type: "text", text: c.text })
        } else if (c.type === "reasoning") {
          parts.push({ id: textPartID(a.id, "reasoning", reasoningOrd++), type: "reasoning", text: c.text })
        } else if (c.type === "tool") {
          parts.push({
            id: c.id,
            type: "tool",
            callID: c.id,
            tool: c.name,
            status: toolStatus(c.state.status),
            input: c.state.input,
            output: toolContentText(c.state.content),
            error: c.state.error?.message,
            metadata: c.state.metadata,
          })
        }
      }
      return {
        id: a.id,
        role: "assistant",
        time: { created: a.time?.created ?? 0 },
        agent: a.agent,
        model: modelRef(a.model),
        tokens: mapTokens(a.tokens),
        cost: a.cost,
        error: a.error ? { name: a.error.type ?? "error", message: a.error.message } : undefined,
        parts,
      }
    }
    case "compaction": {
      const c = m as OpenCompactionMessage
      return {
        id: c.id,
        role: "assistant",
        time: { created: c.time?.created ?? 0 },
        parts: [
          {
            id: `${c.id}/compaction`,
            type: "compaction",
            status: c.status,
            summary: c.summary,
            recent: c.recent,
          } as Part,
        ],
      }
    }
    case "idle": {
      const c = m as OpenMessageBase
      return {
        id: c.id,
        role: "assistant",
        time: { created: c.time?.created ?? 0 },
        parts: [{ id: `${c.id}/step-finish`, type: "step-finish" }],
      }
    }
    default:
      // agent-switched, model-switched, location-switched, system, skill, shell:
      // not user/assistant chat content; skip for now.
      return undefined
  }
}

function toolStatus(status: OpenToolState["status"]): "pending" | "running" | "completed" | "error" {
  switch (status) {
    case "streaming":
    case "running":
      return "running"
    case "completed":
      return "completed"
    case "error":
      return "error"
    default:
      return "pending"
  }
}

function toolContentText(content: OpenToolContent[] | undefined): string | undefined {
  if (!content) return undefined
  return content
    .map((c) => (c.type === "text" ? c.text : `[file${c.name ? `: ${c.name}` : ""}]`))
    .join("\n")
}

function toPermissionRequest(p: OpenPermissionRequest): PermissionRequest {
  return {
    id: p.id,
    sessionID: p.sessionID,
    permission: p.action ?? "",
    patterns: p.resources,
    metadata: p.metadata,
    tool: p.source ? { messageID: p.source.messageID ?? "", callID: p.source.id ?? "" } : undefined,
    always: p.save,
  }
}

function toQuestionRequest(f: OpenFormInfo): QuestionRequest {
  // Each form field is one question (see toField in
  // packages/core/src/tool/plugin/question.ts): field.description holds the
  // question text, field.title holds the per-question header, and
  // field.type is "multiselect" for multi-select questions. Mapping every
  // field to its own entry keeps the questions distinct instead of
  // collapsing them into a single card with every option merged together.
  const questions = (f.fields ?? [])
    .filter((field) => field.type === "string" || field.type === "multiselect")
    .map((field) => ({
      question: field.description ?? field.title ?? "",
      header: field.title ?? "",
      options: (field.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
      multiple: field.type === "multiselect",
      custom: field.custom !== false,
    }))
  const tool = f.metadata?.tool
  return {
    id: f.id,
    sessionID: f.sessionID,
    questions: questions.length > 0 ? questions : [{ question: f.title ?? "", header: f.title ?? "", options: [], multiple: false, custom: true }],
    // Bind the pending request back to the running `question` tool part via
    // (messageID, callID). Without this, findPendingQuestionForTool never
    // matches and the bubble renders the "Question (loading…)" placeholder
    // forever.
    ...(tool?.messageID && tool?.id ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
  }
}

function mcpStatus(s: OpenMcpServer["status"]): McpStatus {
  switch (s.status) {
    case "connected":
      return { status: "connected" }
    case "pending":
      return { status: "configured" }
    case "disabled":
      return { status: "disabled" }
    case "failed":
      return { status: "failed", error: s.error ?? "" }
    case "needs_auth":
      return { status: "needs_auth" }
    default:
      return { status: "configured" }
  }
}

function groupModels(models: OpenModelInfo[]): Map<string, Record<string, { id: string; name?: string }>> {
  const byProvider = new Map<string, Record<string, { id: string; name?: string }>>()
  for (const m of models) {
    const providerID = m.providerID
    if (!providerID) continue
    let map = byProvider.get(providerID)
    if (!map) {
      map = {}
      byProvider.set(providerID, map)
    }
    const id = m.modelID ?? m.id ?? ""
    if (id) map[id] = { id, name: m.name }
  }
  return byProvider
}
