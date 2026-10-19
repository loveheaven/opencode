// Backend abstraction. The extension host picks one backend (opencode over
// HTTP, or deepseek-harness over ACP) and drives it through this single
// interface; the webview only ever sees the neutral model from model.ts.
//
// Keep this file free of `vscode` imports — the BackendKind / BackendCapabilities
// types are shared with the webview (to decide which settings tabs to show).

import type { Message, NeutralUpdate, PermissionRequest, QuestionRequest, Session } from "../model"
import type {
  AgentInfo,
  CommandInfo,
  McpStatus,
  ProviderInfo,
  ProviderListResult,
  RunCommandInput,
  SkillInfo,
} from "../types"

export type BackendKind = "opencode" | "dsh" | "pi"

// Which product-level configuration surfaces a backend exposes. These drive
// which settings tabs the webview renders; a backend that cannot enumerate or
// mutate a surface reports false and the tab is hidden. This is a capability
// of the *integration*, not of the underlying product — dsh has skills and MCP,
// but its ACP surface does not expose them for browsing.
export type BackendCapabilities = {
  providers: boolean
  agents: boolean
  skills: boolean
  mcp: boolean
  commands: boolean
}

export type PromptInput = {
  sessionID: string
  text: string
  attachments?: Array<{ mime: string; url: string; filename?: string }>
  agent?: string
  model?: { providerID: string; modelID: string }
}

export type BackendStatus =
  | { state: "starting" }
  | { state: "ready" }
  | { state: "error"; message: string }

export interface Backend {
  readonly kind: BackendKind
  readonly capabilities: BackendCapabilities

  /**
   * PID of the process this backend spawned, if any. Undefined while not
   * started or when attaching to an already-running process. Used to filter
   * the Settings backend list down to processes this window actually owns
   * (pi/dsh are stdio children that can't be reattached, unlike opencode).
   */
  readonly pid?: number

  /** Spawn or attach to the underlying process. Idempotent. */
  start(): Promise<void>

  /** Tear the process down. Idempotent. */
  stop(): Promise<void>

  listSessions(): Promise<Session[]>
  createSession(input?: { title?: string }): Promise<Session>
  getMessages(sessionID: string): Promise<Message[]>
  prompt(input: PromptInput): Promise<void>
  abort(sessionID: string): Promise<void>

  /**
   * Subscribe to the backend's event stream. Returns an unsubscribe function.
   * The backend must translate its native stream into NeutralUpdate.
   */
  subscribe(handlers: {
    onUpdate: (u: NeutralUpdate) => void
    onStatus: (s: BackendStatus) => void
  }): () => void

  // ---- opencode management surface. Optional: dsh does not implement any of
  // these (its capabilities are all false and the webview hides the tabs). ----

  deleteSession?(sessionID: string): Promise<boolean>
  updateSession?(sessionID: string, patch: { title?: string }): Promise<Session>
  compactSession?(sessionID: string, providerID: string, modelID: string): Promise<boolean>
  respondPermission?(permissionID: string, response: "once" | "always" | "reject"): Promise<boolean>
  listPermissions?(): Promise<PermissionRequest[]>
  listQuestions?(): Promise<QuestionRequest[]>
  replyQuestion?(requestID: string, answers: string[][]): Promise<boolean>
  rejectQuestion?(requestID: string): Promise<boolean>
  listAgents?(): Promise<AgentInfo[]>
  listCommands?(): Promise<CommandInfo[]>
  listSkills?(): Promise<SkillInfo[]>
  getMcpStatus?(): Promise<Record<string, McpStatus>>
  mcpConnect?(name: string): Promise<void>
  mcpDisconnect?(name: string): Promise<void>
  listProviders?(): Promise<ProviderInfo[]>
  getProviderList?(): Promise<ProviderListResult>
  runCommand?(input: RunCommandInput): Promise<void>
}
