// Sessions drawer.
//
// UI-only module for the slide-in sessions list. Session data (loading,
// selecting, creating) still lives in main.ts because it drives the whole
// chat state — the drawer just renders that data and forwards user actions
// through the injected handlers.

import type { OpencodeClient, SessionInfo } from "./sdk"

type Deps = {
  drawer: HTMLElement
  list: HTMLElement
  getClient: () => OpencodeClient | undefined
  getSessions: () => SessionInfo[]
  setSessions: (list: SessionInfo[]) => void
  getCurrentSessionID: () => string | undefined
  onSelect: (id: string) => Promise<void> | void
  onNewSessionNeeded: () => Promise<void> | void
  loadSessions: () => Promise<void>
  updateSessionLabel: () => void
  askInput: (prompt: string, defaultValue?: string) => Promise<string | undefined>
  askConfirm: (message: string, destructive?: boolean) => Promise<boolean>
  postMessage: (msg: unknown) => void
  log: (...args: unknown[]) => void
}

let deps: Deps | null = null

export function initSessionsDrawer(d: Deps) {
  deps = d
  const close = document.getElementById("sessions-close")
  close?.addEventListener("click", () => hideDrawer())
}

export function isDrawerOpen(): boolean {
  return !!deps && !deps.drawer.hidden
}

export async function showDrawer() {
  if (!deps) return
  deps.drawer.hidden = false
  renderDrawer() // show whatever we currently have immediately
  try {
    await deps.loadSessions()
  } catch (err) {
    deps.log("loadSessions failed", err)
  }
  renderDrawer()
}

export function hideDrawer() {
  if (!deps) return
  deps.drawer.hidden = true
}

/** Callable from main.ts after e.g. session creation, so the row highlights. */
export function renderDrawer() {
  if (!deps) return
  deps.list.innerHTML = ""
  const sessions = deps.getSessions()
  if (sessions.length === 0) {
    const empty = document.createElement("div")
    empty.className = "empty"
    empty.innerHTML = `<div style="font-size:14px;margin-bottom:6px;color:var(--vscode-foreground)">No sessions yet</div><div>Click <strong>+</strong> above to start one.</div>`
    deps.list.appendChild(empty)
    return
  }
  const currentID = deps.getCurrentSessionID()
  for (const s of sessions) {
    const item = document.createElement("div")
    item.className = "session-item"
    if (s.id === currentID) item.classList.add("active")
    const title = document.createElement("div")
    title.className = "title"
    title.textContent = s.title?.trim() || "Untitled session"
    const subtitle = document.createElement("div")
    subtitle.className = "subtitle"
    subtitle.textContent = new Date(s.time?.updated ?? s.time?.created ?? Date.now()).toLocaleString()

    const actions = document.createElement("div")
    actions.className = "actions"
    const renameBtn = document.createElement("button")
    renameBtn.textContent = "Rename"
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      void renameSession(s.id, s.title ?? "")
    })
    const deleteBtn = document.createElement("button")
    deleteBtn.textContent = "Delete"
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      void deleteSession(s.id)
    })
    actions.appendChild(renameBtn)
    actions.appendChild(deleteBtn)

    item.appendChild(title)
    item.appendChild(subtitle)
    item.appendChild(actions)
    item.addEventListener("click", () => {
      hideDrawer()
      void deps!.onSelect(s.id)
    })
    deps.list.appendChild(item)
  }
}

async function renameSession(id: string, currentTitle: string) {
  if (!deps) return
  const title = await deps.askInput("New session title", currentTitle)
  if (title === undefined) return
  const client = deps.getClient()
  if (!client) return
  try {
    const updated = await client.updateSession(id, { title })
    const sessions = deps.getSessions().slice()
    const idx = sessions.findIndex((s) => s.id === id)
    if (idx >= 0) sessions[idx] = updated
    deps.setSessions(sessions)
    if (deps.getCurrentSessionID() === id) deps.updateSessionLabel()
    renderDrawer()
  } catch (err) {
    deps.postMessage({ type: "showMessage", level: "error", message: `Rename failed: ${(err as Error).message}` })
  }
}

async function deleteSession(id: string) {
  if (!deps) return
  const client = deps.getClient()
  if (!client) return
  const ok = await deps.askConfirm("Delete this session? This cannot be undone.", true)
  if (!ok) return
  try {
    await client.deleteSession(id)
    deps.setSessions(deps.getSessions().filter((s) => s.id !== id))
    if (deps.getCurrentSessionID() === id) {
      const remaining = deps.getSessions()
      if (remaining.length > 0) await deps.onSelect(remaining[0].id)
      else await deps.onNewSessionNeeded()
    }
    renderDrawer()
  } catch (err) {
    deps.postMessage({ type: "showMessage", level: "error", message: `Delete failed: ${(err as Error).message}` })
  }
}
