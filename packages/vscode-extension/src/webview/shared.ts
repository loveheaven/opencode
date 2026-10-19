// Shared state, DOM refs, and tiny utilities used across webview modules.
//
// Kept intentionally small: it's the module every UI module imports, so we
// don't want it to grow into a "everything.ts". Only put things here that
// (a) are genuinely shared by 3+ modules and (b) have no reasonable place
// as an injected dependency.
//
// Ownership:
//   • `state` is the single source of truth for chat state (messages,
//     sessions, current agent/model, busy flag, pending questions).
//   • DOM refs (`refs.*`) are wired once by main.ts's setup(); modules read
//     them but never re-query the DOM.
//   • `getClient()` returns the current BackendClient (may be undefined
//     during boot / after server restart). We keep it behind a getter so
//     modules always see the latest reference after `setClient` reassigns.
//   • `log` / `setStatus` are cheap logging helpers; they exist here so
//     modules don't each need to receive them as init params.

import type { MessageInfo, Part, QuestionRequest, Session } from "../model"
import type { AgentInfo, CommandInfo, ProviderInfo } from "../types"
import type { BackendClient } from "./client"

export type MessageEntry = { info: MessageInfo; parts: Map<string, Part>; partOrder: string[] }

export type State = {
  serverUrl: string
  directory: string
  defaultAgent: string
  defaultModel: string
  /**
   * Which backend the host is currently driving ("opencode" | "dsh" | "pi").
   * Mirrors `BackendKind`, kept as a plain string so this file stays free of
   * backend/ imports. Chat-surface copy that names the agent reads this so a
   * backend switch doesn't leave "Ask opencode…" sitting in front of a pi
   * session. Set from the host's bootstrap message; see applyBackendIdentity
   * in main.ts.
   */
  backendKind: string
  sessionID?: string
  sessions: Session[]
  messages: Map<string, MessageEntry>
  messageOrder: string[]
  agents: AgentInfo[]
  providers: ProviderInfo[]
  commands: CommandInfo[]
  agent: string
  model: string // "providerID/modelID"
  busy: boolean
  pendingQuestions: Map<string, QuestionRequest>
}

export const state: State = {
  serverUrl: "",
  directory: "",
  defaultAgent: "",
  defaultModel: "",
  backendKind: "opencode",
  sessions: [],
  messages: new Map(),
  messageOrder: [],
  agents: [],
  providers: [],
  commands: [],
  agent: "",
  model: "",
  busy: false,
  pendingQuestions: new Map(),
}

// Display name for the active backend, used anywhere the UI addresses the
// agent by name. Separate from settings.ts's BACKEND_LABELS (which labels the
// process-picker rows) because this one is read on the chat surface and needs
// a sane fallback for an unknown kind rather than an empty cell.
const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  opencode: "opencode",
  dsh: "dsh",
  pi: "pi",
}

export function backendLabel(): string {
  return BACKEND_DISPLAY_NAMES[state.backendKind] ?? (state.backendKind || "the agent")
}

// Client is set once bootstrap finishes; a module reading it before that
// gets `undefined` and should bail. Kept behind a getter so subsequent
// bootstraps (server restart) don't leave stale references behind.
let clientRef: BackendClient | undefined
export function getClient(): BackendClient | undefined {
  return clientRef
}
export function setClient(c: BackendClient | undefined) {
  clientRef = c
}

// DOM refs. Populated by main.ts's setup(); readers should assume they're
// non-null after setup runs but should still tolerate missing elements
// during hot-reload edge cases.
export const refs: {
  messages: HTMLElement
  status: HTMLElement
  sessionLabel: HTMLElement
  agentModel: HTMLElement
  input: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
  stopBtn: HTMLButtonElement
  sessionUsage: HTMLElement
} = {
  messages: null as unknown as HTMLElement,
  status: null as unknown as HTMLElement,
  sessionLabel: null as unknown as HTMLElement,
  agentModel: null as unknown as HTMLElement,
  input: null as unknown as HTMLTextAreaElement,
  sendBtn: null as unknown as HTMLButtonElement,
  stopBtn: null as unknown as HTMLButtonElement,
  sessionUsage: null as unknown as HTMLElement,
}

export function initSharedRefs(r: Partial<typeof refs>) {
  Object.assign(refs, r)
}

/** Best-effort console.log wrapper; never throws. */
export function log(...args: unknown[]) {
  try {
    console.log("[opencode-webview]", ...args)
  } catch {
    // ignore
  }
}

/** Update the status line at the bottom of the composer. */
export function setStatus(text: string) {
  if (refs.status) refs.status.textContent = text
}
