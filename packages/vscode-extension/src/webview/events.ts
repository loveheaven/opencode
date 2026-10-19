// Neutral-update router.
//
// Subscribes to the backend's neutral stream on bootstrap and dispatches
// every NeutralUpdate to the right sibling module: message updates →
// messages-view, permissions → permissions module, questions → questions
// module. Session lifecycle events feed back into main.ts via injected
// callbacks (session label refresh, new-session-when-current-deleted, busy
// state).
//
// The backend already folded its native stream (opencode SSE or dsh ACP) into
// NeutralUpdate, so this module never sees opencode EventPayload or ACP
// SessionUpdate — only the neutral shape from model.ts.

import type { NeutralUpdate } from "../model"
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
import { handlePermissionAsk, handlePermissionResolved } from "./permissions"
import { renderQuestions } from "./questions"

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
  unsubscribe = client.onUpdate(onNeutralUpdate)
}

export function unsubscribeEvents() {
  unsubscribe?.()
  unsubscribe = undefined
}

// Guard so overlapping session.status idle updates (one per step boundary on
// a multi-step turn) don't fire several concurrent reloads.
let reconciling = false

/**
 * Post-turn consistency check.
 *
 * Runs on `session.status` idle. If the visible message list is missing the
 * assistant's reply — i.e. we hold no assistant entry that carries any
 * renderable content — the stream lost something and the user is left looking
 * at an idle composer with no answer. Re-fetch the authoritative list and
 * re-render.
 *
 * Deliberately conservative: it only reloads when the list actually looks
 * broken, so the normal path stays a no-op and never causes flicker.
 */
async function reconcileAfterIdle() {
  if (reconciling) return
  const client = getClient()
  const sid = state.sessionID
  if (!client || !sid) return

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
  const hasError = state.messageOrder.some((id) => !!state.messages.get(id)?.info.error)
  if (hasAssistantContent || hasError) return

  reconciling = true
  try {
    const messages = await client.getMessages(sid)
    if (state.sessionID !== sid) return
    const serverHasReply = messages.some(
      (m) => m.role === "assistant" && m.parts.some((p) => (p as { type?: string }).type === "text"),
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

function onNeutralUpdate(u: NeutralUpdate) {
  switch (u.kind) {
    case "session.upsert": {
      const s = u.session
      const existing = state.sessions.findIndex((x) => x.id === s.id)
      if (existing >= 0) state.sessions[existing] = s
      else state.sessions.unshift(s)
      if (state.sessionID === s.id) deps?.updateSessionLabel()
      return
    }
    case "session.deleted": {
      state.sessions = state.sessions.filter((s) => s.id !== u.sessionID)
      if (state.sessionID === u.sessionID) void deps?.onCurrentSessionDeleted()
      return
    }
    case "message.upsert": {
      const info = u.message
      if (info.sessionID && info.sessionID !== state.sessionID) return
      upsertMessage(info)
      flushOrphanParts()
      renderIncremental(info.id)
      return
    }
    case "message.removed": {
      if (u.sessionID !== state.sessionID) return
      removeMessageFromDom(u.messageID)
      return
    }
    case "part.upsert": {
      if (u.sessionID !== state.sessionID) return
      upsertPart(u.sessionID, u.messageID, u.part)
      renderIncremental(u.messageID)
      return
    }
    case "part.removed": {
      if (u.sessionID !== state.sessionID) return
      const entry = state.messages.get(u.messageID)
      if (!entry) return
      entry.parts.delete(u.partID)
      entry.partOrder = entry.partOrder.filter((id) => id !== u.partID)
      renderIncremental(u.messageID)
      return
    }
    case "part.delta": {
      if (u.sessionID !== state.sessionID) return
      // Assistant text streams almost entirely through this update (one per
      // token chunk). The payload has no part object, so we can't create the
      // record here the way `part.upsert` does — if the part isn't known yet,
      // applyPartDelta buffers the chunk and replays it in order once
      // `part.upsert` lands.
      applyPartDelta(u.messageID, u.partID, u.field, u.delta)
      renderIncremental(u.messageID)
      return
    }
    case "session.status": {
      state.busy = u.status === "busy"
      deps?.setBusy(state.busy)
      if (!state.busy) {
        if (!u.sessionID || u.sessionID === state.sessionID) void reconcileAfterIdle()
      }
      return
    }
    case "session.error": {
      const err = u.error ?? {}
      const summary = err.message?.trim() || err.name || "unknown"
      setStatus(`Error: ${summary}`)
      state.busy = false
      deps?.setBusy(false)
      if (!u.sessionID || u.sessionID === state.sessionID) showSessionError(err)
      return
    }
    case "permission.asked": {
      handlePermissionAsk(u.request)
      return
    }
    case "permission.resolved": {
      handlePermissionResolved(u.id)
      return
    }
    case "question.asked": {
      const req = u.request
      if (!req?.id || req.sessionID !== state.sessionID) return
      state.pendingQuestions.set(req.id, req)
      renderQuestions()
      return
    }
    case "question.resolved": {
      if (state.pendingQuestions.delete(u.id)) renderQuestions()
      return
    }
  }
}
