// Cross-client session sync via periodic polling.
//
// Why this module exists:
//   The opencode /event SSE bus is a per-PROCESS EventBus. Messages produced
//   inside a different opencode process — e.g. a mobile client whose upstream
//   is boxclaw daemon, which spawns a short-lived opencode child that writes
//   into the SAME `opencode-<channel>.db` SQLite file — never reach our
//   long-running server's in-memory bus, so the vscode-extension's SSE
//   subscription cannot see them.
//
//   But the /session HTTP endpoint reads the DB directly on every request, and
//   `time.updated` on each SessionInfo is bumped whenever any process writes
//   to that session. That gives us a cheap "did anything change?" signal we
//   can poll without depending on SSE.
//
// Strategy:
//   • Every POLL_INTERVAL_MS the poll fetches /session (one request; already
//     lists everything and is what the drawer refresh uses too), finds the
//     currently-selected session, and compares its `time.updated` to what we
//     last observed. If it advanced, we reload the message list and full-
//     rerender. Otherwise we do nothing.
//   • The user's own sendPrompt() calls `syncNow()` first, so a locally
//     initiated send never races against a stale local view of history.
//   • Poll skips itself while `state.busy` is true: during an active local
//     turn the SSE stream already delivers deltas, and a full reload mid-turn
//     would wipe streaming text.
//
// The reload path reuses selectSession-style plumbing (clear, get, record,
// render). We keep it here as a small helper instead of exporting internals
// from main.ts.

import { getClient, state, log } from "./shared"
import { clearMessagesRender, recordMessage, renderAllMessages } from "./messages-view"

const POLL_INTERVAL_MS = 3000

// Latest `time.updated` we've applied to state.messages for each session.
// Keyed by sessionID so switching sessions doesn't lose track of the previous
// baseline (we reset on select via `noteObservedUpdated`).
const lastObserved = new Map<string, number>()

// One in-flight sync at a time — reload is a full GET + rerender, and while
// it's running new poll ticks would just contend on state.messages.
let syncing: Promise<void> | undefined
let timer: ReturnType<typeof setInterval> | undefined

/**
 * Reset the observed baseline for a session. Call this right after
 * selectSession loads messages so we don't immediately re-reload on the
 * next tick.
 */
export function noteObservedUpdated(sessionID: string, updated: number | undefined) {
  if (!sessionID || updated === undefined) return
  lastObserved.set(sessionID, updated)
}

/**
 * Run one sync cycle now and await it. Idempotent under concurrent calls —
 * a second call while one is already running joins the same promise.
 *
 * Called by sendPrompt() before dispatching, so the user's message lands on
 * top of any remote messages (from mobile/boxclaw) instead of overwriting them.
 */
export function syncNow(): Promise<void> {
  if (syncing) return syncing
  syncing = runOnce().finally(() => {
    syncing = undefined
  })
  return syncing
}

async function runOnce(): Promise<void> {
  const client = getClient()
  const sid = state.sessionID
  if (!client || !sid) return

  // Skip while a local turn is streaming — SSE deltas own state.messages
  // during that window and a full reload would flicker/wipe partial text.
  if (state.busy) return

  let sessions
  try {
    sessions = await client.listSessions()
  } catch (err) {
    // Transient network / server hiccup; try again on the next tick.
    log("[sync] listSessions failed", err)
    return
  }

  // Refresh the sidebar list too, so titles/order stay current across
  // remote-side updates. Cheap since we already have the data.
  state.sessions = sessions.slice().sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))

  const current = sessions.find((s) => s.id === sid)
  if (!current) return

  const updated = current.time?.updated
  if (updated === undefined) return

  const seen = lastObserved.get(sid) ?? 0
  if (updated <= seen) return

  // Something wrote to this session while we were idle. Reload the whole
  // message list — it's cheap and avoids reconstructing incremental deltas
  // for parts we didn't stream ourselves.
  try {
    const messages = await client.getMessages(sid)
    // Guard: session may have been switched by the user during the fetch.
    if (state.sessionID !== sid) return
    clearMessagesRender()
    for (const m of messages) recordMessage(m)
    renderAllMessages()
    lastObserved.set(sid, updated)
    log(`[sync] reloaded ${sid} (${messages.length} msgs, updated=${updated})`)
  } catch (err) {
    log("[sync] getMessages failed", err)
  }
}

/**
 * Start the 3s polling loop. Safe to call more than once — additional calls
 * are no-ops. Returns a stop function for tests / disposal.
 */
export function startSyncPoll(): () => void {
  if (timer) return () => stopSyncPoll()
  timer = setInterval(() => {
    void syncNow()
  }, POLL_INTERVAL_MS)
  return () => stopSyncPoll()
}

export function stopSyncPoll() {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
}
