// Slim opencode client used by the webview.
//
// All network I/O is proxied through the extension host via postMessage:
// the vscode-webview:// origin is rejected by the opencode server's CORS
// allow-list, so direct fetch/EventSource from here hits ERR_FAILED. The
// extension host is a Node process not subject to CORS, so it makes the
// actual HTTP calls and streams SSE frames back over postMessage.
//
// The instance is workspace-scoped: WorkspaceRouting middleware reads
// ?directory=<path> off every request (see packages/opencode/src/server/routes/
// instance/httpapi/middleware/workspace-routing.ts), so we append it once
// centrally instead of at every call site.

export type SessionInfo = {
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

export type TextPart = {
  id: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}
export type ReasoningPart = {
  id: string
  type: "reasoning"
  text: string
}
export type FilePart = {
  id: string
  type: "file"
  mime: string
  filename?: string
  url: string
}
export type ToolStatePending = { status: "pending"; input: Record<string, unknown>; raw: string }
export type ToolStateRunning = {
  status: "running"
  input: Record<string, unknown>
  title?: string
  metadata?: Record<string, unknown>
  time: { start: number }
}
export type ToolStateCompleted = {
  status: "completed"
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number }
}
export type ToolStateError = {
  status: "error"
  input: Record<string, unknown>
  error: string
  time: { start: number; end: number }
}
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = {
  id: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState
}

export type StepStartPart = { id: string; type: "step-start" }
export type StepFinishPart = { id: string; type: "step-finish" }
export type PatchPart = { id: string; type: "patch"; [key: string]: unknown }
export type AgentPart = { id: string; type: "agent"; [key: string]: unknown }
export type SubtaskPart = { id: string; type: "subtask"; [key: string]: unknown }
export type SnapshotPart = { id: string; type: "snapshot"; [key: string]: unknown }
export type CompactionPart = { id: string; type: "compaction"; [key: string]: unknown }
export type RetryPart = { id: string; type: "retry"; [key: string]: unknown }

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | PatchPart
  | AgentPart
  | SubtaskPart
  | SnapshotPart
  | CompactionPart
  | RetryPart
  | { id: string; type: string; [key: string]: unknown }

export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
}

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  parentID?: string
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  finish?: string
  error?: { name: string; message?: string; [key: string]: unknown }
  cost?: number
  tokens?: TokenUsage
}

export type Message = UserMessage | AssistantMessage
export type MessageWithParts = { info: Message; parts: Part[] }

export type ProviderInfo = {
  id: string
  name?: string
  models?: Record<string, { id: string; name?: string }>
  // Where the provider entry came from (server-side):
  //   env    — auto-detected via env-var (e.g. ANTHROPIC_API_KEY set).
  //   config — declared explicitly in opencode.jsonc under `provider.<id>`.
  //   custom — user-added custom provider (models.dev catalog override).
  //   api    — models.dev catalog entry authorised through OAuth or API auth.
  // The Providers settings tab uses this to render source badges.
  source?: "env" | "config" | "custom" | "api"
  // Names of env vars this provider recognises (e.g. ["ANTHROPIC_API_KEY"]).
  env?: readonly string[]
  // Raw option bag echoed back from opencode's Provider.Info (see
  // `toPublicInfo` in packages/opencode/src/provider/provider.ts). Contains
  // fields like `baseURL` for config-declared providers; empty `{}` for
  // most others. NB: apiKey does NOT live here — opencode stores it as a
  // top-level `key` field instead. See `key` below.
  options?: Record<string, unknown>
  // Resolved API key, populated by opencode from one of three sources:
  //   • env var (source="env")            — value of e.g. ANTHROPIC_API_KEY
  //   • auth.json (source="api" / "config" that also has an auth entry) —
  //     the token stored by `opencode auth login`
  //   • never populated for oauth-only providers whose auth uses opaque
  //     tokens the client doesn't need to see
  // We surface this in the Providers tab as the "apiKey:" row (masked by
  // default). Note: opencode intentionally omits this field for some cases
  // (e.g. multi-env providers with disambiguation) — code must tolerate
  // undefined.
  key?: string
}

// Full response payload of GET /provider. `all` is every provider available
// (models.dev catalogue + user-configured overrides, minus disabled entries);
// `connected` lists IDs the user has actually authenticated; `default` maps
// providerID to the recommended modelID.
export type ProviderListResult = {
  all: ProviderInfo[]
  connected: string[]
  default: Record<string, string>
}

export type AgentInfo = {
  name: string
  description?: string
  builtIn?: boolean
}

export type CommandInfo = {
  name: string
  description?: string
  source?: string
  template?: string
  hints?: string[]
}

// GET /skill → array of skills discovered across all configured roots.
// location is either an absolute path to SKILL.md or "<built-in>" for
// skills baked into the opencode binary.
export type SkillInfo = {
  name: string
  description?: string
  location: string
  content: string
}

// GET /mcp → map of server name → status. See packages/opencode/src/mcp/index.ts.
export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

// Pending permission ask — payload of `permission.asked` SSE event and
// entries returned by GET /permission. See packages/schema/src/v1/permission.ts.
export type PermissionRequestInfo = {
  id: string
  sessionID: string
  permission: string
  patterns?: readonly string[]
  metadata?: Record<string, unknown>
  always?: readonly string[]
  tool?: { messageID: string; callID: string }
}

// `question` tool ask — server pauses execution and waits for the user to
// answer via POST /question/:id/reply or /reject. Payload comes from the
// question.asked SSE event (see packages/schema/src/v1/question.ts).
export type QuestionOption = { label: string; description: string }
export type QuestionInfo = {
  question: string
  header: string
  options: readonly QuestionOption[]
  multiple?: boolean
  custom?: boolean
}
export type QuestionRequest = {
  id: string
  sessionID: string
  questions: readonly QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

// SSE payload shape (see packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts)
export type EventPayload = { id: string; type: string; properties: Record<string, unknown> }

// Extension-host bridge injected by main.ts.
export type HostBridge = {
  request: (
    method: string,
    url: string,
    body?: string,
    headers?: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; body: string; headers: Record<string, string> }>
  openSse: (
    url: string,
    onData: (data: string) => void,
    onError: (message: string) => void,
    onEnd: () => void,
  ) => () => void
}

export class OpencodeClient {
  constructor(private baseUrl: string, private directory: string, private bridge: HostBridge) {}

  private url(path: string, extra?: Record<string, string>): string {
    const u = new URL(path, this.baseUrl)
    if (this.directory) u.searchParams.set("directory", this.directory)
    if (extra) for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
    return u.toString()
  }

  private async json<T>(
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
    query?: Record<string, string>,
  ): Promise<T> {
    const method = init?.method ?? "GET"
    const res = await this.bridge.request(method, this.url(path, query), init?.body, {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    })
    if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${res.body || "(no body)"}`)
    if (res.status === 204 || !res.body) return undefined as T
    const ct = (res.headers["content-type"] ?? "").toLowerCase()
    if (ct.includes("application/json")) return JSON.parse(res.body) as T
    // some endpoints stream a single JSON line
    return JSON.parse(res.body) as T
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.json<SessionInfo[]>("/session")
  }

  createSession(input?: { title?: string; parentID?: string }): Promise<SessionInfo> {
    return this.json<SessionInfo>("/session", { method: "POST", body: JSON.stringify(input ?? {}) })
  }

  getSession(sessionID: string): Promise<SessionInfo> {
    return this.json<SessionInfo>(`/session/${encodeURIComponent(sessionID)}`)
  }

  getMessages(sessionID: string): Promise<MessageWithParts[]> {
    return this.json<MessageWithParts[]>(`/session/${encodeURIComponent(sessionID)}/message`)
  }

  deleteSession(sessionID: string): Promise<boolean> {
    return this.json<boolean>(`/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" })
  }

  updateSession(sessionID: string, patch: { title?: string }): Promise<SessionInfo> {
    return this.json<SessionInfo>(`/session/${encodeURIComponent(sessionID)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  }

  abort(sessionID: string): Promise<boolean> {
    return this.json<boolean>(`/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" })
  }

  status(): Promise<Record<string, { type: string }>> {
    return this.json(`/session/status`)
  }

  promptAsync(input: {
    sessionID: string
    messageID?: string
    text: string
    // Attachments carry image/PDF/etc. as data URLs. opencode server accepts
    // `type: "file"` parts with mime + url and turns them into multimodal
    // provider inputs when the target model supports it.
    attachments?: Array<{ mime: string; url: string; filename?: string }>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }): Promise<void> {
    const parts: Array<Record<string, unknown>> = []
    if (input.text) parts.push({ id: makePartID(), type: "text", text: input.text })
    for (const att of input.attachments ?? []) {
      parts.push({ id: makePartID(), type: "file", mime: att.mime, url: att.url, filename: att.filename })
    }
    const payload: Record<string, unknown> = { parts }
    if (input.messageID) payload.messageID = input.messageID
    if (input.agent) payload.agent = input.agent
    if (input.model) payload.model = input.model
    if (input.variant) payload.variant = input.variant
    return this.json<void>(`/session/${encodeURIComponent(input.sessionID)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  // Reply to a permission ask. Uses the modern `/permission/:id/reply` route
  // (payload: `{ reply, message? }`); the legacy `/session/:sid/permissions/:pid`
  // route with `{ response }` is deprecated and observed to silently fail on
  // recent opencode server builds, which is what stuck `write` tools in
  // pending forever. sessionID kept in the signature for API symmetry / logs
  // but no longer used on the wire.
  respondPermission(_sessionID: string, permissionID: string, response: "once" | "always" | "reject"): Promise<boolean> {
    return this.json<boolean>(`/permission/${encodeURIComponent(permissionID)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply: response }),
    })
  }

  // Pending permission requests across all sessions. Used on startup /
  // session-switch to rehydrate any ask that happened while the webview was
  // dead or reloading — the SSE stream only replays events, not the pending
  // set, so without this we can miss an ask entirely and hang the tool
  // forever waiting on `permission.asked` we never saw.
  async listPermissions(): Promise<PermissionRequestInfo[]> {
    try {
      return await this.json<PermissionRequestInfo[]>(`/permission`)
    } catch {
      return []
    }
  }

  // Return currently-pending questions across all sessions. Used on webview
  // load / reload so the UI recovers state — the SSE stream only replays
  // recent events, not the pending set.
  async listQuestions(): Promise<QuestionRequest[]> {
    try {
      return await this.json<QuestionRequest[]>(`/question`)
    } catch {
      return []
    }
  }

  // `answers` is one entry per question in order, each entry is a string[]
  // of the picked option labels (or a single custom string). Server unblocks
  // the paused `question` tool call once received.
  replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    return this.json<boolean>(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    })
  }

  rejectQuestion(requestID: string): Promise<boolean> {
    return this.json<boolean>(`/question/${encodeURIComponent(requestID)}/reject`, {
      method: "POST",
    })
  }

  async listAgents(): Promise<AgentInfo[]> {
    try {
      return await this.json<AgentInfo[]>(`/agent`)
    } catch {
      return []
    }
  }

  // /command returns the full list of slash commands available in this
  // workspace: built-in (init, etc.) + user-defined from opencode.jsonc's
  // `command` block. Returns [] when the endpoint errors so the UI stays quiet.
  async listCommands(): Promise<CommandInfo[]> {
    try {
      return await this.json<CommandInfo[]>(`/command`)
    } catch {
      return []
    }
  }

  // /skill returns the discovered skills across all configured sources
  // (~/.claude/skills, project .opencode/skills, config skills.paths, built-ins).
  async listSkills(): Promise<SkillInfo[]> {
    try {
      return await this.json<SkillInfo[]>(`/skill`)
    } catch {
      return []
    }
  }

  // /mcp returns a map of server name → status. status.status is one of
  // "connected" / "disabled" / "failed" / "needs_auth" / "needs_client_registration".
  async getMcpStatus(): Promise<Record<string, McpStatus>> {
    try {
      return await this.json<Record<string, McpStatus>>(`/mcp`)
    } catch {
      return {}
    }
  }

  // POST /mcp/:name/connect — reconnect or enable a server. Server closes
  // any existing client for the same name before recreating, so this doubles
  // as the "refresh" action.
  async mcpConnect(name: string): Promise<void> {
    await this.json<void>(`/mcp/${encodeURIComponent(name)}/connect`, { method: "POST", body: "" })
  }

  // POST /mcp/:name/disconnect — runtime-only disable. opencode.jsonc `enabled`
  // is the source of truth on next server start.
  async mcpDisconnect(name: string): Promise<void> {
    await this.json<void>(`/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST", body: "" })
  }

  // POST /session/{id}/command runs a slash command with the given arguments.
  // opencode's server materializes the command template into a synthetic user
  // message, so behaviorally this looks like the user typed the whole prompt.
  runCommand(input: {
    sessionID: string
    command: string
    arguments: string
    messageID?: string
    agent?: string
    model?: string
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      command: input.command,
      arguments: input.arguments,
    }
    if (input.messageID) payload.messageID = input.messageID
    if (input.agent) payload.agent = input.agent
    if (input.model) payload.model = input.model
    return this.json<void>(`/session/${encodeURIComponent(input.sessionID)}/command`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  // Raw /provider response. Used by the Providers settings tab which needs
  // the full picture (all + connected + default), unlike the composer's
  // model menu which is fine with just the filtered `listProviders()` list.
  async getProviderList(): Promise<ProviderListResult> {
    try {
      const raw = await this.json<
        | ProviderInfo[]
        | { providers?: ProviderInfo[] }
        | { all?: ProviderInfo[]; connected?: string[]; default?: Record<string, string> }
      >(`/provider`)
      if (Array.isArray(raw)) return { all: raw, connected: raw.map((p) => p.id), default: {} }
      if ("providers" in raw && raw.providers) {
        return { all: raw.providers, connected: raw.providers.map((p) => p.id), default: {} }
      }
      if ("all" in raw && Array.isArray(raw.all)) {
        return {
          all: raw.all,
          connected: (raw as { connected?: string[] }).connected ?? [],
          default: (raw as { default?: Record<string, string> }).default ?? {},
        }
      }
      return { all: [], connected: [], default: {} }
    } catch {
      return { all: [], connected: [], default: {} }
    }
  }

  // /provider returns { all, default, connected } where `all` is the full
  // provider catalogue (hundreds of entries), `connected` is the array of
  // provider IDs the user has actually authenticated, and `default` is a
  // map of providerID -> default modelID. We only surface connected ones.
  async listProviders(): Promise<ProviderInfo[]> {
    try {
      const raw = await this.json<
        | ProviderInfo[]
        | { providers?: ProviderInfo[] }
        | { all?: ProviderInfo[]; connected?: string[]; default?: Record<string, string> }
      >(`/provider`)
      if (Array.isArray(raw)) return raw
      if ("providers" in raw && raw.providers) return raw.providers
      if ("all" in raw && Array.isArray(raw.all)) {
        const connected = new Set((raw as { connected?: string[] }).connected ?? [])
        if (connected.size === 0) return raw.all
        return raw.all.filter((p) => connected.has(p.id))
      }
      return []
    } catch {
      return []
    }
  }

  // SSE subscription proxied through the extension host. Auto-reconnects when
  // the host reports a clean end or transient error.
  subscribeEvents(onEvent: (e: EventPayload) => void, onError?: (e: unknown) => void): () => void {
    let stopped = false
    let disposeCurrent: (() => void) | undefined

    const open = () => {
      if (stopped) return
      disposeCurrent = this.bridge.openSse(
        this.url("/event"),
        (data) => {
          try {
            onEvent(JSON.parse(data) as EventPayload)
          } catch (err) {
            onError?.(err)
          }
        },
        (message) => {
          onError?.(new Error(message))
          if (!stopped) setTimeout(open, 1000)
        },
        () => {
          if (!stopped) setTimeout(open, 500)
        },
      )
    }
    open()

    return () => {
      stopped = true
      disposeCurrent?.()
    }
  }
}

// Client-generated part id. The server assigns real IDs on save; this is fine
// for optimistic parts sent in prompt_async payloads.
export function makePartID(): string {
  return `prt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function makeMessageID(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
