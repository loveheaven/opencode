// SSE event router.
//
// Subscribes to /events on bootstrap and dispatches every event to the
// right sibling module: message updates → messages-view, permissions →
// permissions module, questions → questions module. Session lifecycle
// events feed back into main.ts via injected callbacks (session label
// refresh, new-session-when-current-deleted, busy state).
//
// The stream reconnects automatically at the client layer; we only surface
// non-AbortError failures to the status line.

import type { EventPayload, Message, Part, SessionInfo } from "./sdk"
import { getClient, setStatus, state } from "./shared"
import {
  applyPartDelta,
  clearMessagesRender,
  flushOrphanParts,
  recordMessage,
  removeMessageFromDom,
  renderAllMessages,
  renderIncremental,
  showSessionError,
  upsertMessage,
  upsertPart,
} from "./messages-view"
import {
  handlePermissionAsk,
  handlePermissionResolved,
  type PermissionAsk,
} from "./permissions"
import { renderQuestions } from "./questions"
import type { QuestionRequest } from "./sdk"

type Deps = {
  updateSessionLabel: () => void
  onCurrentSessionDeleted: () => void | Promise<void>
  setBusy: (busy: boolean) => void
}

let deps: Deps | null = null
let unsubscribe: (() => void) | undefined

export function initEvents(d: Deps) {
  deps = d
}

export function subscribeEvents() {
  const client = getClient()
  if (!client) return
  unsubscribe?.()
  unsubscribe = client.subscribeEvents(onServerEvent, (err) => {
    // Reconnection is automatic; surface only real failures.
    if ((err as { name?: string })?.name !== "AbortError") {
      setStatus(`Event stream error (retrying): ${(err as Error).message}`)
    }
  })
}

export function unsubscribeEvents() {
  unsubscribe?.()
  unsubscribe = undefined
}

// Guard so overlapping session.idle events (one per step boundary on a
// multi-step turn) don't fire several concurrent reloads.
let reconciling = false

/**
 * Post-turn consistency check.
 *
 * Runs on `session.idle`. If the visible message list is missing the
 * assistant's reply — i.e. we hold no assistant entry that carries any
 * renderable content — the SSE stream lost something and the user is left
 * looking at an idle composer with no answer. Re-fetch the authoritative
 * list and re-render.
 *
 * Deliberately conservative: it only reloads when the list actually looks
 * broken, so the normal path stays a no-op and never causes flicker.
 */
async function reconcileAfterIdle() {
  if (reconciling) return
  const client = getClient()
  const sid = state.sessionID
  if (!client || !sid) return

  // Does the local state already contain a renderable assistant reply?
  const hasAssistantContent = state.messageOrder.some((id) => {
    const entry = state.messages.get(id)
    if (!entry || entry.info.role !== "assistant") return false
    return entry.partOrder.some((pid) => {
      const p = entry.parts.get(pid) as { type?: string; text?: string; synthetic?: boolean } | undefined
      if (!p) return false
      if (p.type === "text") return !!p.text && !p.synthetic
      return p.type === "tool" || p.type === "reasoning"
    })
  })
  // Also treat a message carrying an error as "content" — the error card is
  // a legitimate result and must not trigger a reload loop.
  const hasError = state.messageOrder.some(
    (id) => !!(state.messages.get(id)?.info as { error?: unknown } | undefined)?.error,
  )
  if (hasAssistantContent || hasError) return

  reconciling = true
  try {
    const messages = await client.getMessages(sid)
    if (state.sessionID !== sid) return
    // Only rebuild if the server really does have more than we do —
    // otherwise an empty session would reload on every idle tick.
    const serverHasReply = messages.some(
      (m) => m.info.role === "assistant" && (m.parts ?? []).some((p) => (p as { type?: string }).type === "text"),
    )
    if (!serverHasReply) return
    clearMessagesRender()
    for (const m of messages) recordMessage(m)
    renderAllMessages()
    setStatus("Ready")
  } catch {
    // Network hiccup — the 3s sync poll in sync.ts will catch up later.
  } finally {
    reconciling = false
  }
}

function onServerEvent(evt: EventPayload) {
  switch (evt.type) {
    case "server.connected":
      setStatus("Connected")
      return
    case "server.heartbeat":
      return
    case "session.created":
    case "session.updated": {
      const info = evt.properties.info as SessionInfo
      const existing = state.sessions.findIndex((s) => s.id === info.id)
      if (existing >= 0) state.sessions[existing] = info
      else state.sessions.unshift(info)
      if (state.sessionID === info.id) deps?.updateSessionLabel()
      return
    }
    case "session.deleted": {
      const id = evt.properties.sessionID as string
      state.sessions = state.sessions.filter((s) => s.id !== id)
      if (state.sessionID === id) void deps?.onCurrentSessionDeleted()
      return
    }
    case "message.updated": {
      const info = evt.properties.info as Message
      if (info.sessionID !== state.sessionID) return
      upsertMessage(info)
      flushOrphanParts()
      renderIncremental(info.id)
      return
    }
    case "message.removed": {
      const messageID = evt.properties.messageID as string
      if (evt.properties.sessionID !== state.sessionID) return
      removeMessageFromDom(messageID)
      return
    }
    case "message.part.updated": {
      const part = evt.properties.part as Part & { sessionID?: string; messageID?: string }
      const sid = (part.sessionID as string) ?? (evt.properties.sessionID as string)
      if (sid !== state.sessionID) return
      upsertPart(sid, part)
      const messageID = (part as { messageID?: string }).messageID
      if (messageID) renderIncremental(messageID)
      return
    }
    case "message.part.removed": {
      if (evt.properties.sessionID !== state.sessionID) return
      const messageID = evt.properties.messageID as string
      const partID = evt.properties.partID as string
      const entry = state.messages.get(messageID)
      if (!entry) return
      entry.parts.delete(partID)
      entry.partOrder = entry.partOrder.filter((id) => id !== partID)
      renderIncremental(messageID)
      return
    }
    case "message.part.delta": {
      if (evt.properties.sessionID !== state.sessionID) return
      const messageID = evt.properties.messageID as string
      const partID = evt.properties.partID as string
      const field = evt.properties.field as string
      const delta = evt.properties.delta as string
      // Assistant text streams almost entirely through this event (one per
      // token chunk). The payload has no part object, so we can't create
      // the record here the way `message.part.updated` does — if the part
      // isn't known yet, applyPartDelta buffers the chunk and replays it
      // in order once `part.updated` lands. The old code just returned,
      // which silently threw away the whole reply whenever deltas out-ran
      // their part (webview reload mid-turn, SSE reconnect, microtask
      // ordering) — the "sent a message, got nothing, status says Ready"
      // failure mode.
      applyPartDelta(messageID, partID, field, delta)
      renderIncremental(messageID)
      return
    }
    case "session.status": {
      const s = evt.properties.status as { type?: string } | undefined
      state.busy = s?.type === "busy"
      deps?.setBusy(state.busy)
      return
    }
    case "session.idle": {
      state.busy = false
      deps?.setBusy(false)
      // Self-heal safety net. The turn is over as far as the server is
      // concerned, so whatever we have in `state.messages` should already
      // match the server. If the DOM is still empty (or holds nothing but
      // the user's own bubble), some events went missing on the way here
      // and the user is staring at "Ready" with no answer — the exact
      // symptom this net exists to kill. Re-pull the whole message list
      // once; it's a single cheap GET and only fires in the broken case.
      const sessionID = evt.properties.sessionID as string | undefined
      if (!sessionID || sessionID === state.sessionID) void reconcileAfterIdle()
      return
    }
    case "session.error": {
      // Route on both the status line AND a persistent error bubble in the
      // messages list. Status alone gets buried by the next "Ready" tick;
      // the bubble stays until the next full-list render. We also drop the
      // busy state so the composer isn't stuck showing "Assistant is
      // working…" — opencode's session runner has already given up.
      const err = (evt.properties.error ?? {}) as { name?: string; message?: string; data?: unknown }
      const summary = err.message?.trim() || err.name || "unknown"
      setStatus(`Error: ${summary}`)
      state.busy = false
      deps?.setBusy(false)
      // Only render the bubble if this error belongs to the visible
      // session — session.error can fire for background sessions too.
      const sessionID = evt.properties.sessionID as string | undefined
      if (!sessionID || sessionID === state.sessionID) {
        showSessionError(err)
      }
      return
    }
    case "permission.asked": {
      const info = evt.properties as unknown as PermissionAsk
      handlePermissionAsk(info)
      return
    }
    case "permission.replied":
    case "permission.rejected": {
      const id = (evt.properties.id ?? evt.properties.permissionID) as string
      handlePermissionResolved(id)
      return
    }
    case "question.asked": {
      // opencode `question` tool: model wants clarification. Payload matches
      // the QuestionRequest struct (see packages/schema/src/v1/question.ts).
      const req = evt.properties as unknown as QuestionRequest
      if (!req?.id || req.sessionID !== state.sessionID) return
      state.pendingQuestions.set(req.id, req)
      renderQuestions()
      return
    }
    case "question.replied":
    case "question.rejected": {
      const id = evt.properties.requestID as string
      if (state.pendingQuestions.delete(id)) renderQuestions()
      return
    }
  }
}
