// Shared types used by both extension host and webview bundle. Keep this
// file free of vscode imports so the webview bundler can consume it too.

export type BootstrapMessage = {
  type: "bootstrap"
  serverUrl: string
  directory: string
  defaultAgent: string
  defaultModel: string
  themeKind: "light" | "dark" | "high-contrast"
}

export type OpenFileRequest = {
  type: "openFile"
  path: string
  line?: number
  column?: number
}

export type ShowDiffRequest = {
  type: "showDiff"
  path: string
  original: string
  modified: string
  title?: string
}

export type ShowMessageRequest = {
  type: "showMessage"
  level: "info" | "warn" | "error"
  message: string
}

// Native modal replacements — window.confirm/prompt are disabled in VSCode webviews.
export type ConfirmRequest = {
  type: "confirm"
  id: string
  message: string
  destructive?: boolean
}
export type InputRequest = {
  type: "input"
  id: string
  prompt: string
  defaultValue?: string
}

// Network proxy: the webview cannot talk to the opencode server directly
// because loopback origins reject the vscode-webview:// scheme via CORS, and
// we can't reconfigure the server side (main-repo code is off-limits). So the
// webview sends every fetch/SSE via postMessage and the extension host — a
// plain Node process not subject to CORS — makes the actual HTTP calls and
// streams results back.
export type HttpRequestMessage = {
  type: "httpRequest"
  id: string
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}
export type SseOpenMessage = {
  type: "sseOpen"
  id: string
  url: string
  headers?: Record<string, string>
}
export type SseCloseMessage = { type: "sseClose"; id: string }

export type OpenProviderConfigRequest = { type: "openProviderConfig" }
export type OpenMcpConfigRequest = { type: "openMcpConfig"; name?: string }
export type OpenPluginConfigRequest = { type: "openPluginConfig" }
export type OpenSkillsConfigRequest = { type: "openSkillsConfig" }
// Draft a custom provider entry from the Providers tab form. The extension
// host injects the JSON into ~/.config/opencode/opencode.jsonc under
// `provider.<id>` (creating the block if missing) and reveals the file so
// the user can review before saving. Values are already stringified into a
// ready-to-insert JSON object; the webview owns the schema so we don't have
// to keep two type definitions in sync.
export type InsertProviderConfigRequest = {
  type: "insertProviderConfig"
  id: string
  entry: Record<string, unknown>
}
// Store a plaintext API key in ~/.local/share/opencode/auth.json under the
// given provider ID. Mirrors what `opencode auth login <provider>` does but
// without shelling out. We keep this on the extension host (not the webview)
// so the file operation runs in Node with normal FS permissions and honours
// the 0600 mode opencode itself uses.
//
// The webview never writes the API key into any other file — see the
// intentionally security-focused sanitize step in insertProviderIntoConfig.
export type SaveProviderAuthRequest = {
  type: "saveProviderAuth"
  providerID: string
  apiKey: string
}
// Skills whose location is "<built-in>" have no file on disk. Webview asks
// the host to materialise their content into an untitled markdown buffer.
export type OpenSkillContentRequest = {
  type: "openSkillContent"
  name: string
  content: string
}

export type WebviewRequest =
  | OpenFileRequest
  | ShowDiffRequest
  | ShowMessageRequest
  | ConfirmRequest
  | InputRequest
  | OpenProviderConfigRequest
  | OpenMcpConfigRequest
  | OpenPluginConfigRequest
  | OpenSkillsConfigRequest
  | InsertProviderConfigRequest
  | SaveProviderAuthRequest
  | OpenSkillContentRequest
  | HttpRequestMessage
  | SseOpenMessage
  | SseCloseMessage
  | WebviewReadyRequest
  | GetDebugRequest
  | SetDebugRequest
  | OpenDebugLogRequest
  | GetServerConfigRequest
  | AttachToServerRequest

export type ConfirmResponse = { type: "confirmResponse"; id: string; result: boolean }
export type InputResponse = { type: "inputResponse"; id: string; value: string | undefined }

export type HttpResponseMessage = {
  type: "httpResponse"
  id: string
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}
export type HttpErrorMessage = {
  type: "httpError"
  id: string
  message: string
}
export type SseEventMessage = { type: "sseEvent"; id: string; data: string }
export type SseErrorMessage = { type: "sseError"; id: string; message: string }
export type SseEndMessage = { type: "sseEnd"; id: string }

// One file/directory/selection to attach to the composer. Server interprets
// the `url` field: `file:///abs/path` for whole files, `?start=N&end=M` for
// line ranges, mime `application/x-directory` for folders. See
// packages/opencode/src/session/prompt.ts resolvePart for the parsing rules.
export type AttachmentPayload = {
  filename: string
  mime: string
  url: string
  // Free-form label the webview appends to the composer so the user can see
  // what was added (e.g. "foo.ts:12-30"). Purely cosmetic; not sent to server.
  hint: string
}
export type AddAttachmentsMessage = {
  type: "addAttachments"
  attachments: AttachmentPayload[]
}

// Which settings tab to open when the overlay is shown.
export type SettingsTab = "mcp" | "skills" | "plugins" | "providers" | "settings"
export type ShowSettingsMessage = { type: "showSettings"; tab: SettingsTab }

// Debug flag round-trips. Owned by the extension host (persisted via
// `context.globalState`) so it survives webview reloads and is visible to
// the http/sse proxy without needing a message on every request. Webview
// asks for the current value on bootstrap and toggles it from the Settings
// tab.
/** Sent once by the webview iife right after it wires its `message`
 *  event listener. Host replies with a fresh `bootstrap` (and re-sends
 *  any late messages queued during startup). Fixes the race where under
 *  remote-ssh / dev-containers the host posts bootstrap *before* the
 *  webview has attached its listener — that message is dropped and the
 *  panel sits at "Waiting for opencode server…" forever. */
export type WebviewReadyRequest = { type: "webviewReady" }

export type GetDebugRequest = { type: "getDebug" }
export type SetDebugRequest = { type: "setDebug"; enabled: boolean }
export type OpenDebugLogRequest = { type: "openDebugLog" }
export type DebugStateMessage = { type: "debugState"; enabled: boolean }

// -----------------------------------------------------------------------
// Server connection settings
// -----------------------------------------------------------------------
// The Settings tab has a small hostname+port form that pins the URL the
// extension prefers to talk to. On startup / on Attach the host probes
// that URL, verifies it's opencode (identifyOpencode), and either
// reattaches or spawns a fresh local server as a fallback.
//
// Two messages: `getServerConfig` fetches the currently-live URL so the
// form can preload it; `attachToServer` commits a new preferred URL.

/** Webview asks host for the currently-connected URL so the form and the
 *  live-connection banner can preload correctly. Host replies with
 *  `serverConfig`. */
export type GetServerConfigRequest = { type: "getServerConfig" }
export type ServerConfigMessage = {
  type: "serverConfig"
  /** The URL the webview is *actually* connected to right now (spawned,
   *  reattached, or user-attached). Undefined only during early bootstrap
   *  before the first successful connection. */
  activeUrl?: string
  /** How we ended up on `activeUrl` this session. Drives the small
   *  parenthetical badge next to the URL in Settings. */
  activeSource?: "spawned" | "reattached" | "external"
}

/** User wants the extension to prefer this URL from now on. Host verifies
 *  it's an opencode server (identifyOpencode) and records it as the
 *  remembered last-server URL in globalState, then reloads the webview so
 *  it rebinds against that URL. If the URL isn't reachable / isn't
 *  opencode, the host falls back to spawning a fresh local server. */
export type AttachToServerRequest = {
  type: "attachToServer"
  url: string
}

export type ExtensionMessage =
  | BootstrapMessage
  | { type: "themeChanged"; themeKind: BootstrapMessage["themeKind"] }
  | { type: "serverError"; message: string }
  | { type: "newSession" }
  | { type: "showSessions" }
  | AddAttachmentsMessage
  | ShowSettingsMessage
  | HttpResponseMessage
  | HttpErrorMessage
  | SseEventMessage
  | SseErrorMessage
  | SseEndMessage
  | ConfirmResponse
  | InputResponse
  | DebugStateMessage
  | ServerConfigMessage
