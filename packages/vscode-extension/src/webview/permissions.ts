// Permission modal + queue.
//
// The opencode server sends a `permission.asked` SSE event whenever a tool
// wants to do something the user might want to gate (bash, write, edit,
// webfetch, …). We route each ask through this module, which either
// silently auto-approves it (read-only classes) or queues it for the modal.
//
// Two entry points:
//   • `handlePermissionAsk` — called from the SSE branch AND rehydrate.
//   • `rehydratePermissions` — polls /permission after bootstrap / session
//      switch to catch anything that fired before the webview subscribed.
//
// The module owns its own queue + responded-set + modal DOM references.
// External code only needs to call `initPermissions` once and forward SSE
// events; `respondPermission("reject")` is exposed for the Escape key.

import type { OpencodeClient } from "./sdk"

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
  modal: HTMLElement
  titleEl: HTMLElement
  summaryEl: HTMLElement
  detailEl: HTMLElement
  getClient: () => OpencodeClient | undefined
  getCurrentSessionID: () => string | undefined
  setStatus: (text: string) => void
  log: (...args: unknown[]) => void
}

let deps: Deps | null = null

// Queued permission asks we've decided the user should confirm (git/rm/etc).
// Anything not queued has already been auto-approved via respondPermission.
const pendingPermissions: PermissionAsk[] = []
const respondedPermissions = new Set<string>()

export function initPermissions(d: Deps) {
  deps = d
  document.getElementById("permission-deny")?.addEventListener("click", () => void respondPermission("reject"))
  document.getElementById("permission-once")?.addEventListener("click", () => void respondPermission("once"))
  document.getElementById("permission-always")?.addEventListener("click", () => void respondPermission("always"))
}

/** True when the modal is currently on screen. */
export function isPermissionModalOpen(): boolean {
  return !!deps && !deps.modal.hidden
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
  if (deps.modal.dataset.currentId === info.id) return
  deps.log("permission.asked", { id: info.id, permission: info.permission, tool: info.tool, patterns: info.patterns, metadata: info.metadata })
  if (needsUserConfirmation(info)) {
    pendingPermissions.push({ ...info, sessionID })
    if (deps.modal.hidden) showNextPermission()
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
 * SSE handler for `permission.replied` / `permission.rejected`. Removes the
 * matching ask from the queue and, if it's the one currently on screen,
 * advances to the next pending ask (or closes the modal if none).
 */
export function handlePermissionResolved(id: string) {
  if (!deps) return
  const idx = pendingPermissions.findIndex((p) => p.id === id)
  if (idx >= 0) pendingPermissions.splice(idx, 1)
  if (deps.modal.dataset.currentId === id) {
    hidePermission()
    showNextPermission()
  }
}

/**
 * Respond to the current front-of-queue ask. Escape key handler in main.ts
 * calls this with "reject" so it's exported.
 */
export async function respondPermission(response: "once" | "always" | "reject") {
  if (!deps) return
  const current = pendingPermissions.shift()
  hidePermission()
  showNextPermission()
  if (!current) return
  deps.log("respondPermission", { id: current.id, response, hasClient: !!deps.getClient() })
  await sendPermissionResponse(current.sessionID, current.id, response)
}

// Decide whether a permission request should interrupt the user.
//
// Default is "yes, ask" — the model is about to change something on the
// user's machine and they deserve to see exactly what. We only auto-approve
// permission classes that are provably read-only (glob/grep/read/list_dir/
// webfetch info retrieval): those pop up dozens of times per turn and would
// bury the user in modals for no safety gain.
//
// Previous heuristic (only ask for `bash` + destructive command) was wrong:
// it silently rubber-stamped `write`/`edit`/`patch` and hid what the model
// was doing. Confirmed to be the direct cause of the "stuck on write pending"
// reports — the auto-approve POST would race the tool call and if the reply
// endpoint changed schema (as it did between server versions) the ask would
// never get answered.
function needsUserConfirmation(info: PermissionAsk): boolean {
  return !isReadOnlyPermission(info.permission)
}

// Permission classes considered safe enough to auto-approve. Everything not
// on this list falls through to a modal — better a friction-y prompt than a
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

function showNextPermission() {
  if (!deps) return
  const next = pendingPermissions[0]
  if (!next) {
    hidePermission()
    return
  }
  const view = describePermission(next)
  deps.titleEl.textContent = view.title
  deps.summaryEl.textContent = view.summary
  deps.detailEl.textContent = view.detail
  deps.detailEl.hidden = view.detail.length === 0
  deps.modal.dataset.currentId = next.id
  deps.modal.hidden = false
}

function hidePermission() {
  if (!deps) return
  deps.modal.hidden = true
  delete deps.modal.dataset.currentId
}

// Turn a raw permission request into "title / summary / detail" strings for
// the modal. Different permission kinds carry different useful payload —
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

// Trim long payloads so the modal stays scannable; users can still read the
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
