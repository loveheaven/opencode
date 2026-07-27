// Webview entry point.
//
// Only the "glue" lives here now — bootstrap, session lifecycle, sendPrompt,
// composer resizer, the extension-host message bridge, and DOM wiring in
// setup(). Everything else has been peeled into focused sibling modules
// (messages-view, events, questions, permissions, settings, attachments,
// slash-commands, sessions-drawer, lightbox, agent-model). Shared state
// and DOM refs live in shared.ts so those modules don't need to receive
// them as init params.

import {
  OpencodeClient,
  type HostBridge,
} from "./sdk"
import {
  applyDebugState,
  applyServerConfig,
  closeSettings,
  initSettings,
  isSettingsOpen,
  openSettings,
  setSettingsClient,
  type SettingsTab,
} from "./settings"
import { closeLightbox, isLightboxOpen, setupLightbox } from "./lightbox"
import {
  clearAttachments,
  handleAddAttachments,
  initAttachments,
  listAttachments,
  restoreAttachments,
} from "./attachments"
import { hideCommandPalette, initSlashCommands, setSlashCommands } from "./slash-commands"
import { hideDrawer, initSessionsDrawer, isDrawerOpen, showDrawer } from "./sessions-drawer"
import {
  initPermissions,
  isPermissionModalOpen,
  rehydratePermissions,
  respondPermission,
} from "./permissions"
import {
  firstProviderModel,
  initAgentModel,
  isUserSelectableAgent,
  renderAgentModel,
} from "./agent-model"
import {
  clearMessagesRender,
  initMessagesView,
  recordMessage,
  renderAllMessages,
  renderEmptyState,
  renderIncremental,
  scrollToBottom,
} from "./messages-view"
import { initQuestions, renderQuestions } from "./questions"
import { initEvents, subscribeEvents } from "./events"
import { getClient, initSharedRefs, log, refs, setClient, setStatus, state } from "./shared"

// Extension-host bridge (webview → vscode)
declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void
  getState: () => unknown
  setState: (state: unknown) => void
}
const vscode = acquireVsCodeApi()

// -------- Host bridge: routes fetch/SSE via postMessage to the extension host --------
type HttpResolver = (value: { ok: boolean; status: number; body: string; headers: Record<string, string> }) => void
type HttpRejector = (reason: Error) => void
const pendingHttp = new Map<string, { resolve: HttpResolver; reject: HttpRejector }>()
type SseHandlers = { onData: (data: string) => void; onError: (message: string) => void; onEnd: () => void }
const pendingSse = new Map<string, SseHandlers>()
let bridgeSeq = 0
function nextBridgeId(prefix: string): string {
  bridgeSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${bridgeSeq}`
}
// window.confirm/prompt are disabled in VSCode webviews. Route through the
// extension host, which uses native VSCode modals.
const pendingConfirm = new Map<string, (result: boolean) => void>()
const pendingInput = new Map<string, (value: string | undefined) => void>()
function askConfirm(message: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    const id = nextBridgeId("cfm")
    pendingConfirm.set(id, resolve)
    vscode.postMessage({ type: "confirm", id, message, destructive })
  })
}
function askInput(prompt: string, defaultValue = ""): Promise<string | undefined> {
  return new Promise((resolve) => {
    const id = nextBridgeId("inp")
    pendingInput.set(id, resolve)
    vscode.postMessage({ type: "input", id, prompt, defaultValue })
  })
}

const hostBridge: HostBridge = {
  request(method, url, body, headers) {
    return new Promise((resolve, reject) => {
      const id = nextBridgeId("http")
      pendingHttp.set(id, { resolve, reject })
      vscode.postMessage({ type: "httpRequest", id, method, url, headers, body })
    })
  },
  openSse(url, onData, onError, onEnd) {
    const id = nextBridgeId("sse")
    pendingSse.set(id, { onData, onError, onEnd })
    vscode.postMessage({ type: "sseOpen", id, url })
    return () => {
      pendingSse.delete(id)
      vscode.postMessage({ type: "sseClose", id })
    }
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const persisted = restorePersisted()

window.addEventListener("DOMContentLoaded", setup)

function setup() {
  const inputEl = $("input") as HTMLTextAreaElement
  initSharedRefs({
    messages: $("messages"),
    status: $("status-text"),
    sessionLabel: $("session-label"),
    agentModel: $("agent-model"),
    input: inputEl,
    sendBtn: $("send-btn") as HTMLButtonElement,
    stopBtn: $("stop-btn") as HTMLButtonElement,
    sessionUsage: $("session-usage"),
  })

  // Wire every sibling module. Order is chosen so downstream modules can
  // reference their peers via imports — no circular init required.
  initMessagesView({
    renderQuestions,
    postMessage: (m) => vscode.postMessage(m),
    onNewSession: () => newSession(),
  })
  initQuestions({ scrollToBottom, rerenderMessage: renderIncremental })
  initEvents({
    updateSessionLabel,
    onCurrentSessionDeleted: () => newSession(),
    setBusy,
  })
  initPermissions({
    getClient,
    getCurrentSessionID: () => state.sessionID,
    setStatus,
    log,
    scrollToBottom,
  })
  initSettings({
    overlay: document.getElementById("settings-overlay"),
    body: document.getElementById("settings-body"),
    postMessage: (m) => vscode.postMessage(m),
    setStatus,
  })
  initAttachments({
    strip: $("attachments-strip"),
    input: inputEl,
    composer: $("composer"),
    setStatus,
  })
  initSessionsDrawer({
    drawer: $("sessions-drawer"),
    list: $("sessions-list"),
    getClient,
    getSessions: () => state.sessions,
    setSessions: (list) => (state.sessions = list),
    getCurrentSessionID: () => state.sessionID,
    onSelect: (id) => selectSession(id),
    onNewSessionNeeded: () => newSession(),
    loadSessions,
    updateSessionLabel,
    askInput,
    askConfirm,
    postMessage: (m) => vscode.postMessage(m),
    log,
  })
  initAgentModel({
    persisted,
    onRefreshProviders: refreshProviders,
  })

  refs.sendBtn.addEventListener("click", () => void sendPrompt())
  refs.stopBtn.addEventListener("click", () => void abortCurrent())
  initSlashCommands({ input: inputEl, onSubmit: () => void sendPrompt() })
  inputEl.addEventListener("blur", () => {
    // Give a click on the palette a chance to land first.
    setTimeout(() => hideCommandPalette(), 120)
  })

  // Escape closes the topmost overlay so users are never trapped. Order:
  // lightbox → permission modal → settings overlay → sessions drawer.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    if (isLightboxOpen()) {
      closeLightbox()
      return
    }
    if (isPermissionModalOpen()) {
      // Deny is the safer default when the user hits Escape on a permission modal.
      void respondPermission("reject")
    } else if (isSettingsOpen()) {
      closeSettings()
    } else if (isDrawerOpen()) {
      hideDrawer()
    }
  })
  setupLightbox()
  setupComposerResizer()

  refs.messages.addEventListener("click", onMessagesClick)

  window.addEventListener("message", onExtensionMessage)
  setStatus("Waiting for opencode server…")

  // Handshake: tell the host we're ready to receive messages. Under
  // remote-ssh / dev-containers the vscode-webview transport is async, so
  // any `webview.postMessage(...)` the host fires *before* this listener
  // is registered gets dropped. That was the actual cause of the sticky
  // "Waiting for opencode server…" state after Reload Window: the server
  // was already reattached in <1s, but the host's bootstrap message was
  // sent before this iife had wired its `message` listener, so we never
  // saw it. Host replies to `webviewReady` by re-sending bootstrap.
  vscode.postMessage({ type: "webviewReady" })

  // If bootstrap never arrives, surface it instead of leaving a blank panel.
  //
  // Budget notes (worst case, cold Reload Window):
  //   • identifyOpencode(lastUrl) 2s
  //   • ServerManager.start → spawn + waitForReady up to 45s
  //   • host bootstrap post-message + webview handling: sub-second
  // Total worst case ≈ 48s. We give it 60s so a slow bun cold start
  // or a filesystem hiccup during reap doesn't trip the message.
  setTimeout(() => {
    if (!getClient()) {
      setStatus("Server not ready. Run “OpenCode: Restart Server” from the command palette.")
      renderEmptyState()
    }
  }, 60000)
}

async function onExtensionMessage(event: MessageEvent) {
  const msg = event.data as { type: string } & Record<string, unknown>
  if (!msg || typeof msg !== "object") return
  switch (msg.type) {
    case "bootstrap":
      await bootstrap(msg as never)
      break
    case "themeChanged":
      // CSS variables handle it automatically; nothing to do.
      break
    case "serverError":
      setStatus(`Server error: ${msg.message}`)
      break
    case "newSession":
      await newSession()
      break
    case "showSessions":
      await showDrawer()
      break
    case "addAttachments":
      handleAddAttachments((msg as unknown as { attachments: Array<{ filename: string; mime: string; url: string; hint: string }> }).attachments)
      break
    case "showSettings":
      openSettings((msg as unknown as { tab: SettingsTab }).tab)
      break
    case "httpResponse": {
      const pending = pendingHttp.get(msg.id as string)
      if (!pending) return
      pendingHttp.delete(msg.id as string)
      pending.resolve({
        ok: msg.ok as boolean,
        status: msg.status as number,
        body: (msg.body as string) ?? "",
        headers: (msg.headers as Record<string, string>) ?? {},
      })
      return
    }
    case "httpError": {
      const pending = pendingHttp.get(msg.id as string)
      if (!pending) return
      pendingHttp.delete(msg.id as string)
      pending.reject(new Error((msg.message as string) ?? "http error"))
      return
    }
    case "sseEvent": {
      const h = pendingSse.get(msg.id as string)
      h?.onData(msg.data as string)
      return
    }
    case "sseError": {
      const h = pendingSse.get(msg.id as string)
      h?.onError((msg.message as string) ?? "sse error")
      return
    }
    case "sseEnd": {
      const h = pendingSse.get(msg.id as string)
      h?.onEnd()
      return
    }
    case "confirmResponse": {
      const cb = pendingConfirm.get(msg.id as string)
      if (!cb) return
      pendingConfirm.delete(msg.id as string)
      cb(Boolean(msg.result))
      return
    }
    case "inputResponse": {
      const cb = pendingInput.get(msg.id as string)
      if (!cb) return
      pendingInput.delete(msg.id as string)
      cb(msg.value as string | undefined)
      return
    }
    case "debugState":
      applyDebugState(Boolean(msg.enabled))
      return
    case "serverConfig": {
      const activeUrl = typeof msg.activeUrl === "string" ? (msg.activeUrl as string) : undefined
      const rawSource = typeof msg.activeSource === "string" ? (msg.activeSource as string) : undefined
      const activeSource: "spawned" | "reattached" | "external" | undefined =
        rawSource === "spawned" || rawSource === "reattached" || rawSource === "external" ? rawSource : undefined
      applyServerConfig(activeUrl, activeSource)
      return
    }
  }
}

async function bootstrap(msg: {
  serverUrl: string
  directory: string
  defaultAgent: string
  defaultModel: string
}) {
  log("bootstrap", msg)
  state.serverUrl = msg.serverUrl
  state.directory = msg.directory
  state.defaultAgent = msg.defaultAgent
  state.defaultModel = msg.defaultModel
  const client = new OpencodeClient(msg.serverUrl, msg.directory, hostBridge)
  setClient(client)
  setSettingsClient(client)

  // Never let one failing preflight call blank the UI. allSettled + log any
  // errors, then render whatever we have.
  const results = await Promise.allSettled([loadAgentsAndProviders(), loadSessions()])
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") log(`preflight[${i}] failed`, r.reason)
  }

  renderEmptyState()

  // Session selection is best-effort; if it fails we still land on the composer.
  try {
    const rememberedID = persisted.getLastSession(msg.directory)
    const remembered = rememberedID ? state.sessions.find((s) => s.id === rememberedID) : undefined
    if (remembered) await selectSession(remembered.id)
    else if (state.sessions.length > 0) await selectSession(state.sessions[0].id)
    else await newSession()
  } catch (err) {
    log("initial session failed", err)
    setStatus(`Session init failed: ${(err as Error).message}`)
  }

  subscribeEvents()
  // Second rehydrate after SSE is live. There's a tiny window between the
  // per-session rehydrate above and SSE subscribe where server-side asks
  // could slip through; a second sweep guarantees we don't miss any.
  await rehydratePermissions()
  setStatus("Ready")
}

async function loadAgentsAndProviders() {
  const client = getClient()
  if (!client) return
  const results = await Promise.allSettled([
    client.listAgents(),
    client.listProviders(),
    client.listCommands(),
  ])
  state.agents = results[0].status === "fulfilled" ? results[0].value : []
  state.providers = results[1].status === "fulfilled" ? results[1].value : []
  state.commands = results[2].status === "fulfilled" ? results[2].value : []
  setSlashCommands(state.commands)
  if (results[0].status === "rejected") log("listAgents failed", results[0].reason)
  if (results[1].status === "rejected") log("listProviders failed", results[1].reason)
  if (results[2].status === "rejected") log("listCommands failed", results[2].reason)

  const persistedAgent = persisted.getAgent(state.directory)
  const persistedModel = persisted.getModel(state.directory)
  // Fallback chain when nothing was persisted and the server didn't tell us
  // a defaultAgent: pick the first USER-SELECTABLE agent (skip hidden ones
  // like compaction/title/summary and subagent-only ones like general/
  // explore). Ultimate fallback is "build" which is always primary.
  const firstUsableAgent = state.agents.find(isUserSelectableAgent)?.name
  state.agent = persistedAgent || state.defaultAgent || firstUsableAgent || "build"
  state.model = persistedModel || state.defaultModel || firstProviderModel(state.providers) || ""
  renderAgentModel()
}

// Re-fetch providers/agents without re-running full bootstrap. Used when the
// user edits the opencode config to add a custom provider or model.
async function refreshProviders() {
  const client = getClient()
  if (!client) return
  setStatus("Reloading providers…")
  try {
    const [agents, providers, commands] = await Promise.all([
      client.listAgents(),
      client.listProviders(),
      client.listCommands(),
    ])
    state.agents = agents
    state.providers = providers
    state.commands = commands
    setSlashCommands(state.commands)
    renderAgentModel()
    setStatus(`Reloaded: ${providers.length} providers, ${commands.length} commands`)
  } catch (err) {
    setStatus(`Reload failed: ${(err as Error).message}`)
  }
}

async function loadSessions() {
  const client = getClient()
  if (!client) return
  state.sessions = await client.listSessions()
  // Order by updated desc if possible.
  state.sessions.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
}

async function selectSession(sessionID: string) {
  const client = getClient()
  if (!client) return
  state.sessionID = sessionID
  clearMessagesRender()
  state.pendingQuestions = new Map()
  updateSessionLabel()
  persisted.setLastSession(state.directory, sessionID)

  try {
    const messages = await client.getMessages(sessionID)
    for (const m of messages) recordMessage(m)
    renderAllMessages()
  } catch (err) {
    setStatus(`Failed to load messages: ${(err as Error).message}`)
  }

  // Rehydrate any question the model was waiting on. Only questions matching
  // the current session are surfaced; others belong to background sessions.
  try {
    const asks = await client.listQuestions()
    for (const q of asks) {
      if (q.sessionID === sessionID) state.pendingQuestions.set(q.id, q)
    }
    renderQuestions()
  } catch (err) {
    log("listQuestions failed", err)
  }

  // Same rehydrate story for permissions: any ask that fired before the SSE
  // subscription is otherwise lost, and the tool stays stuck in `pending`
  // on the server forever.
  await rehydratePermissions()
}

async function newSession() {
  const client = getClient()
  if (!client) return
  try {
    const session = await client.createSession()
    state.sessions.unshift(session)
    await selectSession(session.id)
  } catch (err) {
    setStatus(`Failed to create session: ${(err as Error).message}`)
  }
}

function updateSessionLabel() {
  const s = state.sessions.find((x) => x.id === state.sessionID)
  if (!s) {
    refs.sessionLabel.textContent = "New session"
    return
  }
  refs.sessionLabel.textContent = s.title?.trim() || "Untitled session"
  refs.sessionLabel.title = `${s.id}\n${s.directory}`
}

async function sendPrompt() {
  const client = getClient()
  if (!client || !state.sessionID) return
  const text = refs.input.value.trim()
  const attachments = listAttachments().slice()
  // Allow sending image-only messages ("what's in this?" + pasted image),
  // but block truly empty submits.
  if (!text && attachments.length === 0) return
  if (state.busy) return

  // Intentionally do NOT pre-generate a messageID here. The opencode server
  // mints message ids that embed a monotonically-increasing hex timestamp
  // prefix, and the prompt loop (packages/opencode/src/session/prompt.ts)
  // compares `lastUser.id < lastAssistant.id` lexicographically to decide
  // when a turn is "done". If the webview supplies its own id in a
  // different encoding, that comparison can flip and the loop will keep
  // re-invoking the model with the same history forever. Letting the
  // server assign the id keeps both sides in the same id-space.
  const model = state.model.includes("/")
    ? { providerID: state.model.split("/")[0], modelID: state.model.split("/").slice(1).join("/") }
    : undefined

  // If the user typed a recognized slash command (e.g. "/init foo bar"),
  // dispatch to /session/{id}/command so opencode's command system runs
  // the template. Otherwise fall through to promptAsync. We only treat a
  // leading "/word" as a command when the word matches state.commands —
  // typing "/idk what to do" still goes as a normal message.
  const slashMatch = text.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/)
  const commandName = slashMatch?.[1]
  const commandArgs = slashMatch?.[2] ?? ""
  const isKnownCommand = !!commandName && state.commands.some((c) => c.name === commandName)

  refs.input.value = ""
  clearAttachments()
  hideCommandPalette()
  setBusy(true)

  try {
    if (isKnownCommand && attachments.length === 0) {
      await client.runCommand({
        sessionID: state.sessionID,
        command: commandName as string,
        arguments: commandArgs,
        agent: state.agent || undefined,
        model: state.model || undefined,
      })
    } else {
      await client.promptAsync({
        sessionID: state.sessionID,
        text,
        attachments: attachments.map((a) => ({ mime: a.mime, url: a.url, filename: a.filename })),
        agent: state.agent || undefined,
        model,
      })
    }
  } catch (err) {
    setBusy(false)
    setStatus(`Send failed: ${(err as Error).message}`)
    refs.input.value = text
    // restore attachments so the user doesn't lose them on a transient error
    restoreAttachments(attachments)
  }
}

async function abortCurrent() {
  const client = getClient()
  if (!client || !state.sessionID) return
  try {
    await client.abort(state.sessionID)
  } catch (err) {
    setStatus(`Abort failed: ${(err as Error).message}`)
  }
}

function setBusy(busy: boolean) {
  state.busy = busy
  refs.sendBtn.hidden = busy
  refs.stopBtn.hidden = !busy
  refs.input.disabled = false // still let user type the next prompt while assistant works
  if (busy) setStatus("Assistant is working…")
  else setStatus("Ready")
}

// -------- composer resizer --------
//
// Horizontal splitter between the messages list and the composer, letting
// the user reshape the vertical split. Approach: on mousedown on the gutter,
// remember composer height + pointer Y; on mousemove, compute a new height
// and write it to `--composer-height` CSS var (see styles.css). We clamp to
// keep both messages and composer usable — the composer never grows past
// ~70% of the panel, and it never shrinks below ~96px (the CSS min-height).
//
// mousemove/mouseup handlers are attached to `window` while dragging so the
// pointer can leave the gutter without losing the drag (a classic gotcha).
function setupComposerResizer() {
  const gutter = document.getElementById("composer-resizer") as HTMLElement | null
  const composer = document.getElementById("composer") as HTMLElement | null
  const app = document.getElementById("app") as HTMLElement | null
  if (!gutter || !composer || !app) return

  let dragging = false
  let startY = 0
  let startComposerH = 0

  const onMove = (e: MouseEvent) => {
    if (!dragging) return
    e.preventDefault()
    const dy = e.clientY - startY
    // Dragging down should shrink the composer (moves splitter down → less
    // room below); dragging up expands it. So subtract dy from starting h.
    const appH = app.getBoundingClientRect().height
    const minH = 96
    const maxH = Math.max(minH, Math.round(appH * 0.7))
    const next = Math.max(minH, Math.min(maxH, startComposerH - dy))
    composer.style.setProperty("--composer-height", `${next}px`)
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove("opencode-dragging")
    window.removeEventListener("mousemove", onMove)
    window.removeEventListener("mouseup", onUp)
  }
  gutter.addEventListener("mousedown", (e) => {
    e.preventDefault()
    dragging = true
    startY = e.clientY
    startComposerH = composer.getBoundingClientRect().height
    document.body.classList.add("opencode-dragging")
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  })
  // Double-click resets to the CSS default (auto sizing), matching typical
  // VSCode splitter behaviour.
  gutter.addEventListener("dblclick", () => composer.style.removeProperty("--composer-height"))
}

function onMessagesClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === "A") {
    const href = (target as HTMLAnchorElement).href
    if (href && /^file:/.test(href)) {
      e.preventDefault()
      const path = decodeURIComponent(href.replace(/^file:\/\//, ""))
      vscode.postMessage({ type: "openFile", path })
    }
  }
}

// -------- persistence --------
//
// Store agent/model/lastSession per workspace path. We save into the extension
// host via setState, so it survives webview reloads; but ultimately the source
// of truth for cross-restart persistence is the opencode server itself (for
// sessions) and the config defaults (for agent/model).
function restorePersisted() {
  const saved = (vscode.getState() as Record<string, WorkspacePrefs> | undefined) ?? {}
  return {
    getLastSession(dir: string) {
      return saved[dir]?.lastSession
    },
    setLastSession(dir: string, id: string) {
      saved[dir] = { ...(saved[dir] ?? {}), lastSession: id }
      vscode.setState(saved)
    },
    getAgent(dir: string) {
      return saved[dir]?.agent
    },
    setAgent(dir: string, agent: string) {
      saved[dir] = { ...(saved[dir] ?? {}), agent }
      vscode.setState(saved)
    },
    getModel(dir: string) {
      return saved[dir]?.model
    },
    setModel(dir: string, model: string) {
      saved[dir] = { ...(saved[dir] ?? {}), model }
      vscode.setState(saved)
    },
  }
}
type WorkspacePrefs = { lastSession?: string; agent?: string; model?: string }
