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
//   • `getClient()` returns the current OpencodeClient (may be undefined
//     during boot / after server restart). We keep it behind a getter so
//     modules always see the latest reference after `setClient` reassigns.
//   • `log` / `setStatus` are cheap logging helpers; they exist here so
//     modules don't each need to receive them as init params.

import type {
  AgentInfo,
  CommandInfo,
  Message,
  OpencodeClient,
  Part,
  ProviderInfo,
  QuestionRequest,
  SessionInfo,
} from "./sdk"

export type MessageEntry = { info: Message; parts: Map<string, Part>; partOrder: string[] }

export type State = {
  serverUrl: string
  directory: string
  defaultAgent: string
  defaultModel: string
  sessionID?: string
  sessions: SessionInfo[]
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

// Client is set once bootstrap finishes; a module reading it before that
// gets `undefined` and should bail. Kept behind a getter so subsequent
// bootstraps (server restart) don't leave stale references behind.
let clientRef: OpencodeClient | undefined
export function getClient(): OpencodeClient | undefined {
  return clientRef
}
export function setClient(c: OpencodeClient | undefined) {
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
