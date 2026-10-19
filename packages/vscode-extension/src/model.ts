// Backend-neutral message model shared by the extension host and the webview.
//
// Both backends (opencode over its HTTP API, deepseek-harness over ACP) fold
// their native streams into this single shape. The webview renders only this
// model, so it never sees opencode Part objects or ACP SessionUpdate objects
// directly — the host-side backends are responsible for the translation.
//
// Like api.ts, keep this file free of `vscode` imports so the webview bundler
// can consume it. Keep it free of `@agentclientprotocol/sdk` imports too —
// that package only exists in the extension host build, not the browser build.

export type PartID = string
export type MessageID = string

// ---------------------------------------------------------------------------
// Parts — the intersection of both backends, plus opencode-only extension slots.
// ---------------------------------------------------------------------------

export type TextPart = {
  id: PartID
  type: "text"
  text: string
  synthetic?: boolean
}

export type ReasoningPart = {
  id: PartID
  type: "reasoning"
  text: string
}

export type FilePart = {
  id: PartID
  type: "file"
  mime: string
  filename?: string
  url: string
}

/** A structured file edit. opencode emits these; dsh over ACP does not. */
export type ToolDiff = {
  path: string
  oldText?: string
  newText: string
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export type ToolPart = {
  id: PartID
  type: "tool"
  callID: string
  tool: string
  title?: string
  status: ToolStatus
  input?: unknown
  output?: string
  error?: string
  diff?: ToolDiff[]
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

// opencode-only extension slots. dsh never produces these; renderers treat
// them as optional and simply skip a part type they do not recognise.
export type StepStartPart = { id: PartID; type: "step-start" }
export type StepFinishPart = { id: PartID; type: "step-finish" }
export type SnapshotPart = { id: PartID; type: "snapshot"; [key: string]: unknown }
export type SubtaskPart = { id: PartID; type: "subtask"; [key: string]: unknown }
export type CompactionPart = { id: PartID; type: "compaction"; [key: string]: unknown }

// Backend-specific part types (opencode patch/agent/retry, future dsh kinds)
// pass through untouched; renderers skip a type they do not recognise.
export type UnknownPart = { id: PartID; type: string; [key: string]: unknown }

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | SubtaskPart
  | CompactionPart
  | UnknownPart

// ---------------------------------------------------------------------------
// Messages and sessions
// ---------------------------------------------------------------------------

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache?: { read: number; write: number }
}

export type Message = {
  id: MessageID
  role: "user" | "assistant"
  sessionID?: string
  time: { created: number }
  agent?: string
  model?: { providerID: string; modelID: string }
  tokens?: TokenUsage
  cost?: number
  error?: { name: string; message?: string }
  parts: Part[]
}

/** Message metadata without its parts — what `message.upsert` and the
 *  webview's MessageEntry.info carry. */
export type MessageInfo = Omit<Message, "parts">

export type Session = {
  id: string
  directory: string
  title?: string
  time?: { created?: number; updated?: number }
}

// ---------------------------------------------------------------------------
// Incremental updates — the only granularity the renderer consumes.
// ---------------------------------------------------------------------------

export type PermissionRequest = {
  id: string
  sessionID: string
  // opencode: permission class ("bash" / "write" / "edit" / "webfetch" / …).
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  tool?: { messageID: string; callID: string }
  always?: string[]
  // dsh ACP: the agent enumerates the outcomes the client may select.
  options?: { optionId: string; label: string }[]
}

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

export type NeutralUpdate =
  | { kind: "session.status"; sessionID?: string; status: "busy" | "idle" }
  | { kind: "session.error"; sessionID?: string; error: { name: string; message?: string } }
  | { kind: "session.upsert"; session: Session }
  | { kind: "session.deleted"; sessionID: string }
  | { kind: "message.upsert"; message: MessageInfo }
  | { kind: "message.removed"; sessionID: string; messageID: string }
  | { kind: "part.upsert"; sessionID: string; messageID: string; part: Part }
  | { kind: "part.delta"; sessionID: string; messageID: string; partID: string; field: "text"; delta: string }
  | { kind: "part.removed"; sessionID: string; messageID: string; partID: string }
  | { kind: "permission.asked"; request: PermissionRequest }
  | { kind: "permission.resolved"; id: string }
  | { kind: "question.asked"; request: QuestionRequest }
  | { kind: "question.resolved"; id: string }

// ---------------------------------------------------------------------------
// Client-generated ids. The server mints real ids on save; these are for
// optimistic parts sent with a prompt.
// ---------------------------------------------------------------------------

export function makePartID(): PartID {
  return `prt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function makeMessageID(): MessageID {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
