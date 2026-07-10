// Inline permission cards.
//
// The opencode server sends a `permission.asked` SSE event whenever a tool
// wants to do something the user might want to gate (bash, write, edit,
// webfetch, …). We route each ask through this module, which either
// silently auto-approves it (read-only classes) or renders an inline card
// at the bottom of the message list — same UX as the `question` tool, no
// modal covering the chat.
//
// Two entry points:
//   • `handlePermissionAsk` — called from the SSE branch AND rehydrate.
//   • `rehydratePermissions` — polls /permission after bootstrap / session
//      switch to catch anything that fired before the webview subscribed.
//
// Previously this was a queue + full-screen modal; users complained the
// modal hijacked focus and hid the chat behind it. Now every pending ask
// is a card pinned above the composer, ordered by arrival — the user can
// scan them, approve/deny in whatever order they like, and keep typing.

import type { OpencodeClient } from "./sdk"
import { refs } from "./shared"

export type PermissionAsk = {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  // Server sends `tool: { messageID, callID }` (see schema/src/v1/permission.ts).
  tool?: { messageID: string; callID: string }
}

type Deps = {
  getClient: () => OpencodeClient | undefined
  getCurrentSessionID: () => string | undefined
  setStatus: (text: string) => void
  log: (...args: unknown[]) => void
}

let deps: Deps | null = null

// Pending asks the user still needs to confirm. Rendered as cards in
// arrival order. Auto-approved asks never touch this list.
const pendingPermissions: PermissionAsk[] = []
const respondedPermissions = new Set<string>()

// scrollToBottom is injected by main.ts (via messages-view) so we can pull
// a fresh card into view without hard-depending on messages-view here.
let scrollToBottom: () => void = () => {}

export function initPermissions(d: Deps & { scrollToBottom?: () => void }) {
  deps = { getClient: d.getClient, getCurrentSessionID: d.getCurrentSessionID, setStatus: d.setStatus, log: d.log }
  if (d.scrollToBottom) scrollToBottom = d.scrollToBottom
}

/** True when at least one permission card is currently on screen. */
export function isPermissionModalOpen(): boolean {
  // Kept under the old name so main.ts's Escape handler doesn't need to
  // change signature. Semantically it's now "are there pending inline
  // permission cards" — Escape still does the right thing (rejects the
  // oldest one).
  return pendingPermissions.length > 0
}

/**
 * Route a permission ask into the queue-or-auto-approve pipeline. Called from
 * both the `permission.asked` SSE branch AND the startup rehydrate path so we
 * handle events that fired before the webview finished loading — otherwise
 * they hang the tool forever.
 */
export function handlePermissionAsk(info: PermissionAsk) {
  if (!deps || !info?.id) return
  const sessionID = info.sessionID ?? deps.getCurrentSessionID()
  const client = deps.getClient()
  if (!client || !sessionID) {
    deps.log("permission.asked ignored: client or sessionID missing", { hasClient: !!client, sessionID })
    return
  }
  // Skip re-processing if we already have this ask queued or already responded.
  if (respondedPermissions.has(info.id)) return
  if (pendingPermissions.some((p) => p.id === info.id)) return
  deps.log("permission.asked", { id: info.id, permission: info.permission, tool: info.tool, patterns: info.patterns, metadata: info.metadata })
  if (needsUserConfirmation(info)) {
    pendingPermissions.push({ ...info, sessionID })
    renderPermissions()
    return
  }
  void autoApprove(sessionID, info.id)
}

/**
 * Fetch any pending permissions from the server and feed them through the
 * same handler as SSE events. Closes the timing window between server-side
 * emit and webview subscription.
 */
export async function rehydratePermissions() {
  if (!deps) return
  const client = deps.getClient()
  if (!client) return
  try {
    const list = await client.listPermissions()
    for (const p of list) {
      handlePermissionAsk({
        id: p.id,
        sessionID: p.sessionID,
        permission: p.permission,
        patterns: p.patterns as string[] | undefined,
        metadata: p.metadata,
        tool: p.tool as { messageID: string; callID: string } | undefined,
      })
    }
  } catch (err) {
    deps.log("listPermissions failed", err)
  }
}

/**
 * SSE handler for `permission.replied` / `permission.rejected`. Drops the
 * matching ask from the queue and rerenders. Safe to call for asks we
 * never queued (e.g. auto-approved ones).
 */
export function handlePermissionResolved(id: string) {
  const idx = pendingPermissions.findIndex((p) => p.id === id)
  if (idx < 0) return
  pendingPermissions.splice(idx, 1)
  renderPermissions()
}

/**
 * Reject the oldest pending ask. Called by Escape key handler in main.ts.
 * If no cards are pending, does nothing.
 */
export async function respondPermission(response: "once" | "always" | "reject") {
  if (!deps) return
  const current = pendingPermissions.shift()
  renderPermissions()
  if (!current) return
  deps.log("respondPermission", { id: current.id, response, hasClient: !!deps.getClient() })
  await sendPermissionResponse(current.sessionID, current.id, response)
}

// Full rerender of pending permission cards. Cheap because the list is tiny
// (usually 0-1 asks, occasionally 2-3). Cards live in the messages list so
// they scroll with the chat and stay near the composer.
export function renderPermissions() {
  for (const el of Array.from(refs.messages.querySelectorAll(".permission-card"))) el.remove()
  for (const ask of pendingPermissions) {
    refs.messages.appendChild(renderPermissionCard(ask))
  }
  if (pendingPermissions.length > 0) scrollToBottom()
}

function renderPermissionCard(info: PermissionAsk): HTMLElement {
  const view = describePermission(info)
  const card = document.createElement("div")
  card.className = "permission-card"
  card.dataset.permissionId = info.id

  const header = document.createElement("div")
  header.className = "permission-header"
  header.textContent = view.title
  card.appendChild(header)

  const summary = document.createElement("div")
  summary.className = "permission-summary"
  summary.textContent = view.summary
  card.appendChild(summary)

  if (view.detail) {
    const detail = document.createElement("pre")
    detail.className = "permission-detail"
    detail.textContent = view.detail
    card.appendChild(detail)
  }

  const actions = document.createElement("div")
  actions.className = "permission-actions"
  const denyBtn = document.createElement("button")
  denyBtn.className = "question-btn secondary"
  denyBtn.textContent = "Deny"
  const onceBtn = document.createElement("button")
  onceBtn.className = "question-btn primary"
  onceBtn.textContent = "Allow once"
  const alwaysBtn = document.createElement("button")
  alwaysBtn.className = "question-btn primary"
  alwaysBtn.textContent = "Always allow"

  const answer = async (response: "reject" | "once" | "always") => {
    denyBtn.disabled = onceBtn.disabled = alwaysBtn.disabled = true
    const idx = pendingPermissions.findIndex((p) => p.id === info.id)
    if (idx >= 0) pendingPermissions.splice(idx, 1)
    renderPermissions()
    await sendPermissionResponse(info.sessionID, info.id, response)
  }
  denyBtn.addEventListener("click", () => void answer("reject"))
  onceBtn.addEventListener("click", () => void answer("once"))
  alwaysBtn.addEventListener("click", () => void answer("always"))

  actions.appendChild(denyBtn)
  actions.appendChild(onceBtn)
  actions.appendChild(alwaysBtn)
  card.appendChild(actions)

  return card
}

// Decide whether a permission request should interrupt the user.
//
// Default is "yes, ask" — the model is about to change something on the
// user's machine and they deserve to see exactly what. We only auto-approve
// permission classes that are provably read-only (glob/grep/read/list_dir/
// webfetch info retrieval): those pop up dozens of times per turn and would
// bury the user in cards for no safety gain.
function needsUserConfirmation(info: PermissionAsk): boolean {
  return !isReadOnlyPermission(info.permission)
}

// Permission classes considered safe enough to auto-approve. Everything not
// on this list falls through to a card — better a friction-y prompt than a
// silent write.
function isReadOnlyPermission(perm: string): boolean {
  switch (perm) {
    case "read":
    case "glob":
    case "grep":
    case "list":
    case "list_dir":
    case "ls":
    case "webfetch":
    case "web_fetch":
    case "task":
      return true
    default:
      return false
  }
}

// Turn a raw permission request into "title / summary / detail" strings for
// the card. Different permission kinds carry different useful payload —
// bash has metadata.command, write/edit have metadata.filePath + content,
// webfetch has metadata.url, etc. When we don't recognise the kind we just
// dump the metadata as JSON so nothing surprising gets hidden.
function describePermission(info: PermissionAsk): { title: string; summary: string; detail: string } {
  const meta = (info.metadata ?? {}) as Record<string, unknown>
  const perm = info.permission
  const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : undefined)

  const detailLines: string[] = []
  if (info.patterns?.length) detailLines.push(`patterns:\n  ${info.patterns.join("\n  ")}`)
  const otherMeta = { ...meta }
  // Strip fields we'll show in title/summary so detail doesn't repeat them.
  for (const k of ["command", "filePath", "path", "file", "url", "oldString", "newString", "content"]) {
    delete otherMeta[k]
  }
  if (Object.keys(otherMeta).length > 0) detailLines.push(JSON.stringify(otherMeta, null, 2))
  const detail = detailLines.join("\n\n")

  if (perm === "bash" || perm === "shell") {
    const cmd = str("command") ?? (info.patterns ?? []).find((p) => typeof p === "string") ?? ""
    return { title: "Run shell command?", summary: cmd || "(no command in payload)", detail }
  }
  if (perm === "write") {
    const file = str("filePath") ?? str("path") ?? str("file") ?? "(no path)"
    const content = str("content") ?? ""
    const preview = content ? `\n${clipText(content, 800)}` : ""
    return { title: "Write file?", summary: `${file}${preview}`, detail }
  }
  if (perm === "edit" || perm === "patch" || perm === "apply_patch") {
    const file = str("filePath") ?? str("path") ?? str("file") ?? "(no path)"
    const oldStr = str("oldString")
    const newStr = str("newString")
    const preview =
      oldStr !== undefined && newStr !== undefined
        ? `\n─── before ───\n${clipText(oldStr, 400)}\n─── after ───\n${clipText(newStr, 400)}`
        : ""
    return { title: "Edit file?", summary: `${file}${preview}`, detail }
  }
  if (perm === "webfetch" || perm === "web_fetch") {
    const url = str("url") ?? "(no url)"
    return { title: "Fetch URL?", summary: url, detail }
  }
  // Fallback: show whatever seems useful.
  const guessTarget = str("filePath") ?? str("path") ?? str("file") ?? str("command") ?? str("url") ?? ""
  return {
    title: `Permission: ${perm}`,
    summary: guessTarget || "(no summary)",
    detail,
  }
}

// Trim long payloads so the card stays scannable; users can still read the
// full picture in the Output channel where we log the raw ask.
function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (+${text.length - max} chars)`
}

// Auto-approve helper with the same retry semantics as manual responses so a
// slow bootstrap never leaves the server hanging on a pending ask.
async function autoApprove(sessionID: string, permissionID: string) {
  await sendPermissionResponse(sessionID, permissionID, "always")
}

// Fire the /permissions/{id} POST. If the client isn't ready yet or the call
// fails, retry a few times with backoff so the server never gets stuck on an
// unanswered ask — that would loop back into another permission.asked event.
async function sendPermissionResponse(sessionID: string, permissionID: string, response: "once" | "always" | "reject") {
  if (!deps) return
  if (respondedPermissions.has(permissionID)) {
    deps.log("permission already responded, skip", permissionID)
    return
  }
  respondedPermissions.add(permissionID)
  const delays = [0, 250, 750, 1500, 3000]
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    const client = deps.getClient()
    if (!client) continue
    try {
      await client.respondPermission(sessionID, permissionID, response)
      return
    } catch (err) {
      deps.log("respondPermission attempt failed", { permissionID, err })
    }
  }
  deps.setStatus(`Permission response gave up for ${permissionID}`)
}
