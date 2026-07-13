// Settings overlay: tab-based full-panel view rendered inside the chat
// webview. Backing chat DOM (messages, composer, session state) stays
// intact — we only toggle the overlay's `hidden` attribute. Every open
// reloads the current tab so status counts / server states stay fresh.
//
// Kept in its own module so main.ts stays focused on chat/streaming.
// Depends on the host `vscode.postMessage` bridge (for opening the config
// file editor and skill contents) plus an OpencodeClient (for HTTP calls
// against the running server). Both are injected through `initSettings`.

import type { McpStatus, OpencodeClient, ProviderInfo, SkillInfo } from "./sdk"

export type SettingsTab = "mcp" | "skills" | "plugins" | "providers" | "settings"

type PostMessage = (msg: unknown) => void
type StatusSetter = (text: string) => void

// Module-scoped bindings written once via initSettings(). Every render
// function reads these; we keep them mutable so the client reference can
// update across bootstraps (e.g. after "OpenCode: Restart Server").
let overlayEl: HTMLElement | null = null
let bodyEl: HTMLElement | null = null
let currentTab: SettingsTab | null = null
let clientRef: OpencodeClient | undefined
let postMessage: PostMessage = () => {}
let setStatus: StatusSetter = () => {}

/**
 * Wire the overlay DOM (tabs + close button) and remember dependencies.
 * Call once from setup(). Safe to call again if the DOM is re-rendered —
 * event listeners get re-attached because we key off IDs each time.
 */
export function initSettings(deps: {
  overlay: HTMLElement | null
  body: HTMLElement | null
  postMessage: PostMessage
  setStatus: StatusSetter
}) {
  overlayEl = deps.overlay
  bodyEl = deps.body
  postMessage = deps.postMessage
  setStatus = deps.setStatus

  const closeBtn = document.getElementById("settings-close")
  closeBtn?.addEventListener("click", closeSettings)
  for (const tabEl of document.querySelectorAll<HTMLElement>(".settings-tab")) {
    tabEl.addEventListener("click", () => {
      const tab = tabEl.dataset.tab as SettingsTab | undefined
      if (tab) void switchSettingsTab(tab)
    })
  }
}

/** Called after `new OpencodeClient(...)` in bootstrap. */
export function setSettingsClient(c: OpencodeClient | undefined) {
  clientRef = c
}

export function isSettingsOpen(): boolean {
  return !!overlayEl && !overlayEl.hidden
}

// One-shot "intent" flag consumed by renderProvidersTab. When true, the tab
// auto-expands the add-provider form as soon as it renders. Reset after use
// so a subsequent plain openSettings("providers") doesn't spuriously expand
// the form again.
let pendingOpenAddForm = false

export type OpenSettingsOptions = {
  /** For the Providers tab: auto-expand the "+ Add custom provider" form. */
  openAddForm?: boolean
}

export function openSettings(tab: SettingsTab, opts?: OpenSettingsOptions) {
  if (!overlayEl) return
  overlayEl.hidden = false
  if (opts?.openAddForm) pendingOpenAddForm = true
  void switchSettingsTab(tab)
}

export function closeSettings() {
  if (!overlayEl) return
  overlayEl.hidden = true
  currentTab = null
}

async function switchSettingsTab(tab: SettingsTab) {
  currentTab = tab
  for (const el of document.querySelectorAll<HTMLElement>(".settings-tab")) {
    el.classList.toggle("active", el.dataset.tab === tab)
  }
  if (!bodyEl) return
  bodyEl.innerHTML = `<div class="settings-status">Loading…</div>`
  if (tab === "providers") await renderProvidersTab()
  else if (tab === "mcp") await renderMcpTab()
  else if (tab === "skills") await renderSkillsTab()
  else if (tab === "plugins") await renderPluginsTab()
  else if (tab === "settings") renderSettingsSubTab()
}

// ---- Settings tab (general extension settings) ----
//
// Currently exposes a single option: Debug logging. When enabled, the
// extension host writes every request/response the webview exchanges with
// the opencode server (including SSE frames) into the "OpenCode" output
// channel — useful when a model gets stuck in a loop or a tool call
// misbehaves and you need to inspect the raw traffic.
//
// The flag lives in the extension host (context.globalState); this render
// only draws the checkbox and asks for the current value via
// postMessage `getDebug`. The host answers with `debugState { enabled }`,
// which the webview forwards here via `applyDebugState`.

let debugCheckbox: HTMLInputElement | null = null

export function applyDebugState(enabled: boolean) {
  if (debugCheckbox) debugCheckbox.checked = enabled
}

function renderSettingsSubTab() {
  if (!bodyEl) return
  const root = bodyEl
  root.innerHTML = ""

  // ---- Section 1: Server connection --------------------------------
  root.appendChild(renderServerConnectionSection())

  // ---- Section 2: Debug --------------------------------------------
  const section = document.createElement("div")
  section.className = "settings-section"

  const heading = document.createElement("div")
  heading.className = "settings-heading"
  heading.textContent = "Debug"
  section.appendChild(heading)

  const row = document.createElement("label")
  row.className = "settings-row"
  const cb = document.createElement("input")
  cb.type = "checkbox"
  cb.id = "settings-debug-log"
  debugCheckbox = cb
  const label = document.createElement("span")
  label.textContent = "Log request & response to OpenCode output"
  row.appendChild(cb)
  row.appendChild(label)
  section.appendChild(row)

  const desc = document.createElement("div")
  desc.className = "settings-hint"
  desc.textContent =
    "Writes every HTTP call and SSE frame between this webview and the opencode server (including prompt payloads and streaming events) into the “OpenCode” output channel. Turn on when the model gets stuck or a tool call misbehaves, so you can share the log."
  section.appendChild(desc)

  const actions = document.createElement("div")
  actions.className = "settings-actions"
  const openBtn = document.createElement("button")
  openBtn.className = "pill"
  openBtn.textContent = "Open output log"
  openBtn.addEventListener("click", () => postMessage({ type: "openDebugLog" }))
  actions.appendChild(openBtn)
  section.appendChild(actions)

  root.appendChild(section)

  cb.addEventListener("change", () => {
    postMessage({ type: "setDebug", enabled: cb.checked })
  })

  // Ask the host for the current value; response arrives via debugState
  // handled in main.ts, which calls applyDebugState.
  postMessage({ type: "getDebug" })
}

// ---- Server connection section ----
//
// User story: someone launched `opencode serve --port <n>` in a terminal
// (typically to inherit HTTPS_PROXY / NODE_EXTRA_CA_CERTS for mitmproxy
// interception) and wants this VSCode instance to attach to it instead of
// spawning a fresh child. Rather than making them figure out
// `serverMode=external` + `serverUrl` inside settings.json manually, we
// expose a simple hostname + port form here that writes those settings for
// them.
//
// Preload: on render we ask the host for the current mode/url via
// `getServerConfig`. Host answers with `serverConfig { mode, url }`, which
// main.ts forwards to `applyServerConfig` below to fill the form.
//
// Commit: pressing Attach sends `applyServerConfig { mode: "external",
// url }`. The host writes both keys to Global config and the existing
// `onDidChangeConfiguration("opencode")` listener triggers reload() —
// no need for the webview to force a reload itself.

// DOM handles for the section, so applyServerConfig() (called from main.ts
// with the host's reply) can update them without re-querying.
let serverModeStatusEl: HTMLElement | null = null
let serverHostInput: HTMLInputElement | null = null
let serverPortInput: HTMLInputElement | null = null

function renderServerConnectionSection(): HTMLElement {
  const section = document.createElement("div")
  section.className = "settings-section"

  const heading = document.createElement("div")
  heading.className = "settings-heading"
  heading.textContent = "Server connection"
  section.appendChild(heading)

  const desc = document.createElement("div")
  desc.className = "settings-hint"
  desc.textContent =
    "Attach this VSCode instance to an already-running opencode server (e.g. one you launched in a terminal with `opencode serve --port 4096`, so it inherits HTTPS_PROXY / NODE_EXTRA_CA_CERTS). Leave in spawn mode to let the extension start its own server."
  section.appendChild(desc)

  // Current status line — filled in by applyServerConfig().
  serverModeStatusEl = document.createElement("div")
  serverModeStatusEl.className = "settings-status"
  serverModeStatusEl.style.margin = "6px 0"
  serverModeStatusEl.textContent = "Loading current settings…"
  section.appendChild(serverModeStatusEl)

  // Host + port inputs. Small inline grid to keep them next to each other.
  const grid = document.createElement("div")
  grid.style.display = "flex"
  grid.style.gap = "8px"
  grid.style.alignItems = "flex-end"
  grid.style.flexWrap = "wrap"
  grid.style.marginTop = "6px"

  const hostField = document.createElement("label")
  hostField.className = "provider-form-field"
  hostField.style.flex = "1 1 200px"
  const hostLabel = document.createElement("span")
  hostLabel.className = "provider-form-label"
  hostLabel.textContent = "Hostname"
  hostField.appendChild(hostLabel)
  serverHostInput = document.createElement("input")
  serverHostInput.type = "text"
  serverHostInput.className = "provider-form-input"
  serverHostInput.placeholder = "127.0.0.1"
  serverHostInput.value = "127.0.0.1"
  serverHostInput.spellcheck = false
  hostField.appendChild(serverHostInput)
  grid.appendChild(hostField)

  const portField = document.createElement("label")
  portField.className = "provider-form-field"
  portField.style.flex = "0 0 120px"
  const portLabel = document.createElement("span")
  portLabel.className = "provider-form-label"
  portLabel.textContent = "Port"
  portField.appendChild(portLabel)
  serverPortInput = document.createElement("input")
  serverPortInput.type = "number"
  serverPortInput.className = "provider-form-input"
  serverPortInput.placeholder = "4096"
  serverPortInput.value = "4096"
  serverPortInput.min = "1"
  serverPortInput.max = "65535"
  portField.appendChild(serverPortInput)
  grid.appendChild(portField)

  section.appendChild(grid)

  const actions = document.createElement("div")
  actions.className = "settings-actions"
  actions.style.marginTop = "10px"

  const attachBtn = document.createElement("button")
  attachBtn.className = "pill"
  attachBtn.textContent = "Attach to external server"
  attachBtn.addEventListener("click", () => submitAttachExternal())
  actions.appendChild(attachBtn)

  const spawnBtn = document.createElement("button")
  spawnBtn.className = "pill"
  spawnBtn.textContent = "Revert to spawn mode"
  spawnBtn.addEventListener("click", () => {
    postMessage({ type: "applyServerConfig", mode: "spawn" })
    setStatus("Reverting to spawn mode…")
  })
  actions.appendChild(spawnBtn)

  section.appendChild(actions)

  // Fire off the request for current config; response goes through
  // main.ts → applyServerConfig(). If we never get a reply (e.g. because
  // the host lives in a different extension host process) the form still
  // works with the built-in defaults (127.0.0.1:4096).
  postMessage({ type: "getServerConfig" })

  return section
}

function submitAttachExternal() {
  if (!serverHostInput || !serverPortInput) return
  const host = serverHostInput.value.trim() || "127.0.0.1"
  const portStr = serverPortInput.value.trim()
  const port = parseInt(portStr, 10)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    setStatus("Port must be a number between 1 and 65535.")
    serverPortInput.focus()
    return
  }
  // Basic hostname sanity check — reject spaces / slashes / schemes so the
  // resulting URL is well-formed. IPv6 hosts must already be wrapped in [].
  if (/[\s/]/.test(host) || /^https?:/i.test(host)) {
    setStatus("Enter a plain hostname (e.g. 127.0.0.1), no scheme or path.")
    serverHostInput.focus()
    return
  }
  const url = `http://${host}:${port}`
  postMessage({ type: "applyServerConfig", mode: "external", url })
  setStatus(`Attaching to ${url}…`)
}

/** Called from main.ts when the host replies with `serverConfig`. Preloads
 *  the form with the currently-persisted mode/url (or, in spawn mode, with
 *  the actual URL of the server the extension spawned) and updates the
 *  status line. Safe to call multiple times — inputs are updated in place.
 *
 *  Prefill strategy:
 *    • external mode → parse `url` (persisted opencode.serverUrl).
 *    • spawn mode + spawnUrl given → parse spawnUrl. The user then sees
 *      the real hostname/port of the child opencode server, and hitting
 *      Attach re-targets this VSCode instance at that same address (which
 *      is exactly what makes sense when they've launched their own
 *      `opencode serve --port <p>` in a terminal).
 *    • spawn mode + no spawnUrl (server not yet running) → parse `url`
 *      as a last-resort fallback.
 */
export function applyServerConfig(
  mode: "spawn" | "external",
  url: string,
  spawnUrl?: string,
) {
  // Which URL do we prefill the inputs from?
  const prefillUrl = mode === "spawn" && spawnUrl ? spawnUrl : url

  let host = "127.0.0.1"
  let port = "4096"
  try {
    const u = new URL(prefillUrl)
    if (u.hostname) host = u.hostname
    if (u.port) port = u.port
    else if (u.protocol === "https:") port = "443"
    else if (u.protocol === "http:") port = "80"
  } catch {
    /* keep defaults */
  }
  if (serverHostInput) serverHostInput.value = host
  if (serverPortInput) serverPortInput.value = port
  if (serverModeStatusEl) {
    if (mode === "external") {
      serverModeStatusEl.textContent = `Currently: attached to external server ${url}`
    } else if (spawnUrl) {
      serverModeStatusEl.textContent = `Currently: spawn mode — extension spawned server at ${spawnUrl}`
    } else {
      serverModeStatusEl.textContent = `Currently: spawn mode (extension manages its own server)`
    }
  }
}

// ---- MCP tab ----

async function renderMcpTab() {
  if (!bodyEl || !clientRef) return
  const root = bodyEl
  const statuses = await clientRef.getMcpStatus()
  root.innerHTML = ""

  const toolbar = document.createElement("div")
  toolbar.className = "settings-toolbar"
  const addBtn = document.createElement("button")
  addBtn.className = "pill"
  addBtn.textContent = "＋ Add MCP Server"
  addBtn.addEventListener("click", () => postMessage({ type: "openMcpConfig" }))
  toolbar.appendChild(addBtn)
  const refreshBtn = document.createElement("button")
  refreshBtn.className = "pill"
  refreshBtn.textContent = "↻ Refresh"
  refreshBtn.addEventListener("click", () => void renderMcpTab())
  toolbar.appendChild(refreshBtn)
  root.appendChild(toolbar)

  const names = Object.keys(statuses).sort()
  const statusLine = document.createElement("div")
  statusLine.className = "settings-status"
  statusLine.textContent = `${names.length} server${names.length === 1 ? "" : "s"}`
  root.appendChild(statusLine)

  if (names.length === 0) {
    const empty = document.createElement("div")
    empty.className = "settings-empty"
    empty.innerHTML = `No MCP servers configured. Click <strong>+ Add MCP Server</strong> to edit opencode.jsonc.`
    root.appendChild(empty)
    return
  }

  for (const name of names) {
    root.appendChild(renderMcpCard(name, statuses[name]))
  }
}

function renderMcpCard(name: string, s: McpStatus): HTMLElement {
  const card = document.createElement("div")
  card.className = `mcp-card mcp-${s.status}`

  const head = document.createElement("div")
  head.className = "mcp-head"

  const dot = document.createElement("span")
  dot.className = `mcp-dot mcp-${s.status}`
  head.appendChild(dot)

  const nameEl = document.createElement("span")
  nameEl.className = "mcp-name"
  nameEl.textContent = name
  head.appendChild(nameEl)

  const badge = document.createElement("span")
  badge.className = `mcp-badge mcp-${s.status}`
  badge.textContent = mcpStatusLabel(s)
  head.appendChild(badge)

  const actions = document.createElement("div")
  actions.className = "mcp-actions"
  const isConnected = s.status === "connected"
  const isFailed = s.status === "failed" || s.status === "needs_client_registration"

  actions.appendChild(
    mcpIconBtn(isConnected ? "↻" : isFailed ? "↻" : "▶", isConnected ? "Reconnect" : isFailed ? "Retry" : "Enable (runtime)", async () => {
      try {
        await clientRef!.mcpConnect(name)
        await renderMcpTab()
      } catch (err) {
        setStatus(`MCP ${name}: ${(err as Error).message}`)
      }
    }),
  )
  if (isConnected) {
    actions.appendChild(
      mcpIconBtn("◼", "Disable (runtime)", async () => {
        try {
          await clientRef!.mcpDisconnect(name)
          await renderMcpTab()
        } catch (err) {
          setStatus(`MCP ${name}: ${(err as Error).message}`)
        }
      }),
    )
  }
  actions.appendChild(
    mcpIconBtn("✎", "Edit in opencode.jsonc", () =>
      postMessage({ type: "openMcpConfig", name }),
    ),
  )
  head.appendChild(actions)
  card.appendChild(head)

  if ((s.status === "failed" || s.status === "needs_client_registration") && s.error) {
    const err = document.createElement("pre")
    err.className = "mcp-error"
    err.textContent = s.error
    card.appendChild(err)
  }
  return card
}

function mcpIconBtn(glyph: string, title: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement("button")
  b.className = "mcp-icon-btn"
  b.textContent = glyph
  b.title = title
  b.setAttribute("aria-label", title)
  b.addEventListener("click", (ev) => {
    ev.stopPropagation()
    void onClick()
  })
  return b
}

function mcpStatusLabel(s: McpStatus): string {
  switch (s.status) {
    case "connected": return "connected"
    case "disabled": return "disabled"
    case "failed": return "failed"
    case "needs_auth": return "needs auth"
    case "needs_client_registration": return "needs client registration"
  }
}

// ---- Skills tab ----

async function renderSkillsTab() {
  if (!bodyEl || !clientRef) return
  const root = bodyEl
  const skills = await clientRef.listSkills()
  root.innerHTML = ""

  const toolbar = document.createElement("div")
  toolbar.className = "settings-toolbar"
  const editBtn = document.createElement("button")
  editBtn.className = "pill"
  editBtn.textContent = "✎ Edit skills config"
  editBtn.addEventListener("click", () => postMessage({ type: "openSkillsConfig" }))
  toolbar.appendChild(editBtn)
  const refreshBtn = document.createElement("button")
  refreshBtn.className = "pill"
  refreshBtn.textContent = "↻ Refresh"
  refreshBtn.addEventListener("click", () => void renderSkillsTab())
  toolbar.appendChild(refreshBtn)
  root.appendChild(toolbar)

  // Sort: user skills alphabetical first, built-ins at the end.
  skills.sort((a, b) => {
    const ab = a.location === "<built-in>"
    const bb = b.location === "<built-in>"
    if (ab !== bb) return ab ? 1 : -1
    return a.name.localeCompare(b.name)
  })

  const statusLine = document.createElement("div")
  statusLine.className = "settings-status"
  statusLine.textContent = `${skills.length} skill${skills.length === 1 ? "" : "s"}`
  root.appendChild(statusLine)

  if (skills.length === 0) {
    const empty = document.createElement("div")
    empty.className = "settings-empty"
    empty.textContent = "No skills discovered."
    root.appendChild(empty)
    return
  }

  for (const skill of skills) {
    const row = document.createElement("div")
    row.className = "skill-row"
    row.title = "Click to open SKILL.md"

    const head = document.createElement("div")
    const nameEl = document.createElement("span")
    nameEl.className = "skill-name"
    nameEl.textContent = skill.name
    head.appendChild(nameEl)
    const src = document.createElement("span")
    src.className = "skill-source"
    src.textContent = skillSourceLabel(skill.location)
    head.appendChild(src)
    row.appendChild(head)

    if (skill.description) {
      const desc = document.createElement("div")
      desc.className = "skill-desc"
      desc.textContent = skill.description
      row.appendChild(desc)
    }

    row.addEventListener("click", () => openSkill(skill))
    root.appendChild(row)
  }
}

function skillSourceLabel(location: string): string {
  if (location === "<built-in>") return "Built-in"
  if (location.includes("/.claude/")) return "Claude"
  if (location.includes("/.agents/")) return "Agents"
  if (location.includes("/.config/opencode/")) return "Global"
  if (location.includes("/.opencode/")) return "Project"
  return "Custom"
}

function openSkill(skill: SkillInfo) {
  if (skill.location === "<built-in>") {
    postMessage({ type: "openSkillContent", name: skill.name, content: skill.content })
  } else {
    postMessage({ type: "openFile", path: skill.location })
  }
}

// ---- Plugins tab ----
//
// opencode doesn't expose plugin runtime status via HTTP, so this tab just
// lists whatever `plugin: [...]` array is declared in opencode.jsonc. Users
// see what's configured; edits go through the config file.

async function renderPluginsTab() {
  if (!bodyEl) return
  const root = bodyEl
  root.innerHTML = ""

  const toolbar = document.createElement("div")
  toolbar.className = "settings-toolbar"
  const editBtn = document.createElement("button")
  editBtn.className = "pill"
  editBtn.textContent = "✎ Edit plugin config"
  editBtn.addEventListener("click", () => postMessage({ type: "openPluginConfig" }))
  toolbar.appendChild(editBtn)
  root.appendChild(toolbar)

  const info = document.createElement("div")
  info.className = "settings-empty"
  info.innerHTML =
    `<div style="font-size:13px;margin-bottom:6px">Plugins are configured in <code>~/.config/opencode/opencode.jsonc</code></div>` +
    `<div style="font-size:12px;opacity:0.85">Under the top-level <code>"plugin": []</code> array, list npm package names or absolute paths. Restart the opencode server after editing.</div>` +
    `<div style="font-size:11px;opacity:0.7;margin-top:12px">opencode currently has no HTTP endpoint reporting per-plugin runtime status — this tab is a shortcut to the config; check the Output panel for load errors.</div>`
  root.appendChild(info)
}

// ---- Providers tab ----
//
// Two sections:
//   • "Available"  — providers opencode can talk to right now (has a working
//                    env var / oauth token / opencode.jsonc entry).
//   • "More"       — catalogue entries opencode knows about but has no
//                    credentials for; expandable so it doesn't drown the
//                    Available list (models.dev ships ~40 providers).
//
// Naming note: the server-side field is `connected: string[]` but users
// found "Connected" ambiguous ("connected to what?"). "Available" reads
// as "you can pick a model from these right now", which matches the model
// picker's semantics.
//
// Each card carries a source badge summarising how opencode learned about
// it: env var, oauth, config file, or builtin. See `sourceLabel()` for the
// mapping from server-side source enum to the user-facing string.

async function renderProvidersTab() {
  if (!bodyEl || !clientRef) return
  const root = bodyEl
  const listing = await clientRef.getProviderList()
  root.innerHTML = ""

  const toolbar = document.createElement("div")
  toolbar.className = "settings-toolbar"

  const addBtn = document.createElement("button")
  addBtn.className = "pill"
  addBtn.textContent = "＋ Add custom provider"
  toolbar.appendChild(addBtn)

  const editBtn = document.createElement("button")
  editBtn.className = "pill"
  editBtn.textContent = "✎ Edit provider config"
  editBtn.addEventListener("click", () => postMessage({ type: "openProviderConfig" }))
  toolbar.appendChild(editBtn)

  const refreshBtn = document.createElement("button")
  refreshBtn.className = "pill"
  refreshBtn.textContent = "↻ Refresh"
  refreshBtn.addEventListener("click", () => void renderProvidersTab())
  toolbar.appendChild(refreshBtn)

  root.appendChild(toolbar)

  // Inline form; hidden by default, revealed when the user clicks Add or
  // when the caller opened us with `openAddForm: true` (e.g. from the model
  // menu's "+ Add custom provider" shortcut).
  const formHost = document.createElement("div")
  formHost.className = "provider-form-host"
  formHost.hidden = true
  root.appendChild(formHost)
  const expandForm = () => {
    formHost.hidden = false
    mountProviderForm(formHost, () => {
      formHost.hidden = true
      formHost.innerHTML = ""
    })
    // Scroll into view so the user actually sees the form on narrow panels.
    formHost.scrollIntoView({ behavior: "smooth", block: "start" })
  }
  addBtn.addEventListener("click", () => {
    if (formHost.hidden) expandForm()
    else {
      formHost.hidden = true
      formHost.innerHTML = ""
    }
  })
  if (pendingOpenAddForm) {
    pendingOpenAddForm = false
    // Defer to next tick so the DOM has fully mounted before we scroll.
    setTimeout(expandForm, 0)
  }

  const usableIDs = new Set(listing.connected)
  const usable = listing.all
    .filter((p) => usableIDs.has(p.id))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
  const catalogue = listing.all
    .filter((p) => !usableIDs.has(p.id))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))

  if (usable.length === 0 && catalogue.length === 0) {
    const empty = document.createElement("div")
    empty.className = "settings-empty"
    empty.innerHTML =
      `No providers detected. Set an API key env var (e.g. <code>ANTHROPIC_API_KEY</code>) or click <strong>+ Add custom provider</strong>.`
    root.appendChild(empty)
    return
  }

  if (usable.length > 0) {
    const heading = document.createElement("div")
    heading.className = "provider-section-heading"
    // Count next to the label so users can eyeball how many providers are
    // wired up without needing the redundant status line above.
    heading.textContent = `Available (${usable.length})`
    root.appendChild(heading)
    for (const p of usable) root.appendChild(renderProviderCard(p, true))
  }

  if (catalogue.length > 0) {
    const heading = document.createElement("div")
    heading.className = "provider-section-heading"
    heading.textContent = `More (${catalogue.length})`
    // Hide the catalogue behind a toggle by default — it's usually 30+ entries
    // and would push the Available list out of view. Users only care about
    // these when they're shopping around for a new provider to try.
    const toggleBtn = document.createElement("button")
    toggleBtn.className = "pill"
    toggleBtn.style.marginLeft = "8px"
    toggleBtn.textContent = "Show"
    heading.appendChild(toggleBtn)
    root.appendChild(heading)

    const catalogueWrap = document.createElement("div")
    catalogueWrap.hidden = true
    for (const p of catalogue) catalogueWrap.appendChild(renderProviderCard(p, false))
    root.appendChild(catalogueWrap)

    toggleBtn.addEventListener("click", () => {
      catalogueWrap.hidden = !catalogueWrap.hidden
      toggleBtn.textContent = catalogueWrap.hidden ? "Show" : "Hide"
    })
  }
}

function renderProviderCard(p: ProviderInfo, isUsable: boolean): HTMLElement {
  const card = document.createElement("div")
  // `provider-usable` = has working creds (in the "Available" list);
  // `provider-catalogue` = catalogue-only entry (in the "More" list).
  // The old class names `provider-connected` / `provider-available` were
  // renamed alongside the section rename to keep CSS and JS in sync.
  card.className = `provider-card ${isUsable ? "provider-usable" : "provider-catalogue"}`

  const head = document.createElement("div")
  head.className = "provider-head"

  const dot = document.createElement("span")
  dot.className = `provider-dot ${isUsable ? "provider-dot-on" : "provider-dot-off"}`
  head.appendChild(dot)

  const name = document.createElement("span")
  name.className = "provider-name"
  name.textContent = p.name ?? p.id
  head.appendChild(name)

  const idBadge = document.createElement("span")
  idBadge.className = "provider-id"
  idBadge.textContent = p.id
  head.appendChild(idBadge)

  if (p.source) {
    const src = document.createElement("span")
    src.className = `provider-source provider-source-${p.source}`
    src.textContent = sourceLabel(p.source)
    src.title = sourceTooltip(p.source)
    head.appendChild(src)
  }

  const modelCount = p.models ? Object.keys(p.models).length : 0
  const models = document.createElement("span")
  models.className = "provider-model-count"
  models.textContent = `${modelCount} model${modelCount === 1 ? "" : "s"}`
  head.appendChild(models)

  card.appendChild(head)

  // Expandable body — click header to toggle.
  const body = document.createElement("div")
  body.className = "provider-body"
  body.hidden = true
  card.appendChild(body)

  head.style.cursor = "pointer"
  let built = false
  head.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).tagName === "BUTTON") return
    body.hidden = !body.hidden
    if (!body.hidden && !built) {
      built = true
      fillProviderBody(body, p)
    }
  })

  return card
}

function fillProviderBody(body: HTMLElement, p: ProviderInfo) {
  // baseURL lives inside `options` (opencode echoes opencode.jsonc options
  // through `toPublicInfo`). apiKey does NOT — opencode resolves it from
  // three sources (env var, auth.json, or config) and stashes the resolved
  // value in a top-level `key` field. We also fall back to `options.apiKey`
  // in case a future opencode version reshapes this — cheap safety net.
  const opts = (p.options ?? {}) as Record<string, unknown>
  const baseURL = typeof opts.baseURL === "string" ? opts.baseURL : undefined
  const apiKey =
    (typeof p.key === "string" && p.key) ||
    (typeof opts.apiKey === "string" ? opts.apiKey : undefined) ||
    undefined

  if (baseURL) {
    const line = document.createElement("div")
    line.className = "provider-kv"
    line.innerHTML = `<span class="provider-kv-key">baseURL:</span> <code>${escapeText(baseURL)}</code>`
    body.appendChild(line)
  }

  if (apiKey) {
    body.appendChild(renderApiKeyRow(apiKey))
  }

  if (p.env && p.env.length > 0) {
    const line = document.createElement("div")
    line.className = "provider-kv"
    // Server-side field is `env: string[]` — the names of env vars this
    // provider will read an API key from. Renaming just the label so the
    // meaning is obvious ("set one of these in your shell to authenticate").
    const label = p.env.length === 1 ? "API key env var:" : "API key env vars:"
    line.innerHTML = `<span class="provider-kv-key">${label}</span> ${p.env.map((e) => `<code>${escapeText(e)}</code>`).join(", ")}`
    body.appendChild(line)
  }

  const models = p.models ?? {}
  const ids = Object.keys(models).sort()
  if (ids.length === 0) {
    const empty = document.createElement("div")
    empty.className = "provider-kv"
    empty.style.opacity = "0.6"
    empty.textContent = "No models exposed."
    body.appendChild(empty)
    return
  }
  const list = document.createElement("div")
  list.className = "provider-model-list"
  for (const id of ids) {
    const m = models[id]
    const row = document.createElement("div")
    row.className = "provider-model-row"
    const idEl = document.createElement("code")
    idEl.textContent = id
    row.appendChild(idEl)
    if (m.name && m.name !== id) {
      const nameEl = document.createElement("span")
      nameEl.className = "provider-model-name"
      nameEl.textContent = m.name
      row.appendChild(nameEl)
    }
    list.appendChild(row)
  }
  body.appendChild(list)
}

// Render an api-key row with a mask/reveal toggle. Default is masked so a
// casual glance / screen-share doesn't leak the key. The eye button toggles
// between mask and reveal; a copy button is offered on hover to save the
// user from having to reveal-then-select-then-copy.
//
// If the value looks like an `{env:NAME}` template we short-circuit the mask
// — that syntax deliberately points at a shell variable rather than the key
// itself, so it's already safe to show.
function renderApiKeyRow(raw: string): HTMLElement {
  const line = document.createElement("div")
  line.className = "provider-kv provider-apikey"

  const key = document.createElement("span")
  key.className = "provider-kv-key"
  key.textContent = "apiKey:"
  line.appendChild(key)

  const isEnvRef = /^\{env:[^}]+\}$/.test(raw.trim())
  const val = document.createElement("code")
  val.className = "provider-apikey-value"
  const masked = maskSecret(raw)
  val.textContent = isEnvRef ? raw : masked
  line.appendChild(val)

  if (!isEnvRef) {
    // Eye toggle. Two glyphs (open eye / closed eye) chosen for legibility at
    // small size; using text rather than SVG to stay dependency-free.
    const eye = document.createElement("button")
    eye.className = "provider-apikey-eye"
    eye.type = "button"
    eye.setAttribute("aria-label", "Show / hide API key")
    eye.title = "Show / hide"
    eye.textContent = "👁"
    let revealed = false
    eye.addEventListener("click", (e) => {
      e.stopPropagation() // don't toggle card body collapse
      revealed = !revealed
      val.textContent = revealed ? raw : masked
      eye.textContent = revealed ? "⊘" : "👁"
    })
    line.appendChild(eye)
  }

  return line
}

// Mask everything except the first 2 and last 2 characters, so users can
// still visually identify which key is which without exposing enough to
// use it. Very short strings get fully masked.
function maskSecret(s: string): string {
  const trimmed = s.trim()
  if (trimmed.length <= 6) return "•".repeat(Math.max(trimmed.length, 4))
  const head = trimmed.slice(0, 2)
  const tail = trimmed.slice(-2)
  return `${head}${"•".repeat(Math.min(trimmed.length - 4, 12))}${tail}`
}

// Convert the server-side source enum into a short, user-facing label. The
// raw enum values (`env` / `api` / `config` / `custom`) leaked implementation
// vocabulary that users found opaque — see the discussion that led to this
// renaming.
function sourceLabel(src: NonNullable<ProviderInfo["source"]>): string {
  switch (src) {
    case "env":
      return "env var"
    case "api":
      return "oauth"
    case "config":
      return "config file"
    case "custom":
      // Server calls this `custom` but it's actually opencode's built-in
      // loader for special providers (Copilot / GitLab / plugin auth). It
      // has nothing to do with user-defined providers — those show up as
      // "config file" because they live in opencode.jsonc.
      return "builtin"
  }
}

function sourceTooltip(src: NonNullable<ProviderInfo["source"]>): string {
  switch (src) {
    case "env":
      return "opencode detected an API key env var in your shell (e.g. ANTHROPIC_API_KEY)."
    case "api":
      return "Authenticated through opencode auth login (OAuth or API token stored in ~/.local/share/opencode/auth.json)."
    case "config":
      return "Declared in ~/.config/opencode/opencode.jsonc under provider.<id>."
    case "custom":
      return "Registered by opencode's built-in loader (Copilot / GitLab / plugin auth). Not the same as a user-defined custom provider — those show as 'config file'."
  }
}

// Inline "Add custom provider" form. Kept simple: five fields matching the
// most common opencode custom provider shape (an OpenAI-compatible API).
// On submit we build the entry object and postMessage it to the extension
// host, which merges it into ~/.config/opencode/opencode.jsonc.
//
// Security note: this form never accepts a plaintext API key. Users must
// either (a) name an env var opencode will read at startup, or (b) leave
// it blank and later run `opencode auth login <id>` to have opencode
// stash the key in ~/.local/share/opencode/auth.json (still plaintext on
// disk, but at least not tracked by the workspace's config file which
// often ends up in source control).
function mountProviderForm(host: HTMLElement, onDone: () => void) {
  host.innerHTML = ""

  const wrap = document.createElement("div")
  wrap.className = "provider-form"

  const intro = document.createElement("div")
  intro.className = "provider-form-intro"
  intro.innerHTML =
    `Custom providers are typed as OpenAI-compatible endpoints. Configuration goes into <code>~/.config/opencode/opencode.jsonc</code>. API keys go to <code>~/.local/share/opencode/auth.json</code> (0600) — <strong>never into the config file</strong>, since that file often ends up in source control.`
  wrap.appendChild(intro)

  const grid = document.createElement("div")
  grid.className = "provider-form-grid"

  const idInput = formField(grid, "Provider ID", "my-provider", "kebab-case identifier; used as the JSON key")
  const nameInput = formField(grid, "Display name", "My Provider", "shown in the model picker")
  const npmInput = formField(grid, "npm package", "@ai-sdk/openai-compatible", "AI SDK adapter; defaults to openai-compatible")
  npmInput.value = "@ai-sdk/openai-compatible"
  const baseUrlInput = formField(grid, "baseURL", "https://api.example.com/v1", "API base URL")

  // Single api-key field with a radio switch between two storage modes.
  // Auto-detect would work (env-var-name-looking string → env; long random
  // string → auth.json) but has enough failure modes (short keys, all-caps
  // keys) that explicit selection is safer.
  const apiKeyWrap = document.createElement("div")
  apiKeyWrap.className = "provider-form-field"
  const apiKeyLabel = document.createElement("span")
  apiKeyLabel.className = "provider-form-label"
  apiKeyLabel.textContent = "API key"
  apiKeyWrap.appendChild(apiKeyLabel)

  const modeRow = document.createElement("div")
  modeRow.className = "provider-form-modes"
  const modePlaintextRadio = document.createElement("input")
  modePlaintextRadio.type = "radio"
  modePlaintextRadio.name = "apikey-mode"
  modePlaintextRadio.value = "plaintext"
  modePlaintextRadio.id = "apikey-mode-plaintext"
  modePlaintextRadio.checked = true
  const modePlaintextLabel = document.createElement("label")
  modePlaintextLabel.htmlFor = "apikey-mode-plaintext"
  modePlaintextLabel.textContent = "Paste key (stored in auth.json)"
  const modeEnvRadio = document.createElement("input")
  modeEnvRadio.type = "radio"
  modeEnvRadio.name = "apikey-mode"
  modeEnvRadio.value = "env"
  modeEnvRadio.id = "apikey-mode-env"
  const modeEnvLabel = document.createElement("label")
  modeEnvLabel.htmlFor = "apikey-mode-env"
  modeEnvLabel.textContent = "Env var name"
  const modeSkipRadio = document.createElement("input")
  modeSkipRadio.type = "radio"
  modeSkipRadio.name = "apikey-mode"
  modeSkipRadio.value = "skip"
  modeSkipRadio.id = "apikey-mode-skip"
  const modeSkipLabel = document.createElement("label")
  modeSkipLabel.htmlFor = "apikey-mode-skip"
  modeSkipLabel.textContent = "Skip (configure later)"
  modeRow.append(modePlaintextRadio, modePlaintextLabel, modeEnvRadio, modeEnvLabel, modeSkipRadio, modeSkipLabel)
  apiKeyWrap.appendChild(modeRow)

  const apiKeyInput = document.createElement("input")
  apiKeyInput.type = "password" // covers the plaintext-paste case; toggled below
  apiKeyInput.className = "provider-form-input"
  apiKeyInput.placeholder = "sk-... (your API key)"
  apiKeyInput.spellcheck = false
  apiKeyInput.autocomplete = "off"
  apiKeyWrap.appendChild(apiKeyInput)

  const apiKeyHint = document.createElement("span")
  apiKeyHint.className = "provider-form-hint"
  apiKeyHint.textContent =
    "Pasted keys go to ~/.local/share/opencode/auth.json (never into opencode.jsonc)."
  apiKeyWrap.appendChild(apiKeyHint)

  const updateApiKeyFieldForMode = () => {
    const mode = modePlaintextRadio.checked ? "plaintext" : modeEnvRadio.checked ? "env" : "skip"
    if (mode === "plaintext") {
      apiKeyInput.type = "password"
      apiKeyInput.placeholder = "sk-... (your API key)"
      apiKeyHint.textContent =
        "Pasted keys go to ~/.local/share/opencode/auth.json (never into opencode.jsonc)."
      apiKeyInput.disabled = false
    } else if (mode === "env") {
      apiKeyInput.type = "text"
      apiKeyInput.placeholder = "MY_PROVIDER_API_KEY"
      apiKeyHint.textContent =
        "Enter just the env var NAME. opencode reads process.env[NAME] at startup."
      apiKeyInput.disabled = false
    } else {
      apiKeyInput.type = "text"
      apiKeyInput.placeholder = "—"
      apiKeyHint.textContent = "You can add the key later via this form or `opencode auth login`."
      apiKeyInput.disabled = true
    }
  }
  modePlaintextRadio.addEventListener("change", updateApiKeyFieldForMode)
  modeEnvRadio.addEventListener("change", updateApiKeyFieldForMode)
  modeSkipRadio.addEventListener("change", updateApiKeyFieldForMode)
  updateApiKeyFieldForMode()

  grid.appendChild(apiKeyWrap)

  const modelIdInput = formField(grid, "Default model ID", "my-model-id", "at least one model must be declared")
  const modelNameInput = formField(grid, "Default model name", "My Model", "shown in the model picker")

  wrap.appendChild(grid)

  const actions = document.createElement("div")
  actions.className = "provider-form-actions"

  const cancelBtn = document.createElement("button")
  cancelBtn.className = "question-btn secondary"
  cancelBtn.textContent = "Cancel"
  cancelBtn.addEventListener("click", onDone)

  const submitBtn = document.createElement("button")
  submitBtn.className = "question-btn primary"
  submitBtn.textContent = "Save"
  submitBtn.addEventListener("click", () => {
    const id = idInput.value.trim()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setStatus("Provider ID must be lowercase kebab-case (e.g. my-provider).")
      idInput.focus()
      return
    }
    const baseURL = baseUrlInput.value.trim()
    if (!baseURL) {
      setStatus("baseURL is required.")
      baseUrlInput.focus()
      return
    }
    const modelID = modelIdInput.value.trim()
    if (!modelID) {
      setStatus("At least one model ID is required.")
      modelIdInput.focus()
      return
    }

    // Two-storage strategy:
    //   • env  → write `{env:NAME}` template into opencode.jsonc options.apiKey.
    //   • plaintext → write to auth.json via extension host (0600). Never
    //     let a plaintext key touch opencode.jsonc — the sanitizer on the
    //     extension side would strip it, but we should not even send it.
    //   • skip → neither; user completes auth later.
    const mode = modePlaintextRadio.checked ? "plaintext" : modeEnvRadio.checked ? "env" : "skip"
    const apiKeyRaw = apiKeyInput.value.trim()

    let apiKeyClause: Record<string, string> = {}
    let plaintextToSave: string | undefined
    if (mode === "env") {
      if (!apiKeyRaw) {
        setStatus("Enter the env var name (e.g. MY_PROVIDER_API_KEY).")
        apiKeyInput.focus()
        return
      }
      const cleaned = apiKeyRaw.replace(/^\{env:/, "").replace(/\}$/, "").replace(/^\$/, "").trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
        setStatus(
          "Env var name must match [A-Za-z_][A-Za-z0-9_]* (e.g. MY_PROVIDER_API_KEY). If you meant to paste the key itself, switch mode to \"Paste key\".",
        )
        apiKeyInput.focus()
        return
      }
      apiKeyClause = { apiKey: `{env:${cleaned}}` }
    } else if (mode === "plaintext") {
      if (!apiKeyRaw) {
        setStatus("Paste the API key (or switch to \"Skip\" to configure later).")
        apiKeyInput.focus()
        return
      }
      plaintextToSave = apiKeyRaw
    }

    const entry: Record<string, unknown> = {
      name: nameInput.value.trim() || id,
      npm: npmInput.value.trim() || "@ai-sdk/openai-compatible",
      options: {
        baseURL,
        ...apiKeyClause,
      },
      models: {
        [modelID]: { name: modelNameInput.value.trim() || modelID },
      },
    }
    postMessage({ type: "insertProviderConfig", id, entry })
    if (plaintextToSave) {
      postMessage({ type: "saveProviderAuth", providerID: id, apiKey: plaintextToSave })
    }
    const followUp =
      mode === "plaintext"
        ? "Key saved to auth.json. Restart the server to activate."
        : mode === "env"
          ? "Env var reference written. Set the env var in your shell (or launch env), then restart the server."
          : `Skipped API key. Configure later via this form or \`opencode auth login ${id}\`, then restart the server.`
    setStatus(`Saved provider "${id}". ${followUp}`)
    onDone()
  })

  actions.appendChild(cancelBtn)
  actions.appendChild(submitBtn)
  wrap.appendChild(actions)

  host.appendChild(wrap)
  idInput.focus()
}

function formField(host: HTMLElement, label: string, placeholder: string, hint?: string): HTMLInputElement {
  const wrap = document.createElement("label")
  wrap.className = "provider-form-field"
  const l = document.createElement("span")
  l.className = "provider-form-label"
  l.textContent = label
  wrap.appendChild(l)
  const input = document.createElement("input")
  input.type = "text"
  input.className = "provider-form-input"
  input.placeholder = placeholder
  input.spellcheck = false
  wrap.appendChild(input)
  if (hint) {
    const h = document.createElement("span")
    h.className = "provider-form-hint"
    h.textContent = hint
    wrap.appendChild(h)
  }
  host.appendChild(wrap)
  return input
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Suppress "unused variable" warnings for currentTab: it's kept for future
// features (e.g. remembering last active tab across re-opens).
export function _debugCurrentTab(): SettingsTab | null {
  return currentTab
}
