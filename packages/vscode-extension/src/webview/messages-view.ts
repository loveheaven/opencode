// Message rendering.
//
// Owns everything that draws the messages list:
//   • state ingestion (recordMessage / upsertMessage / upsertPart)
//   • full rerenders (renderAllMessages) and incremental patches
//     (renderIncremental) driven by SSE deltas
//   • per-message bubble (renderMessage) + part rendering (renderPart,
//     renderToolPart, fillToolBody, showDiffForEdit)
//   • topbar session-usage badge (updateSessionUsage) and per-message
//     token/cost badges (tokenBadge)
//   • copy-to-clipboard button on each meta row
//
// The module reads shared.state directly (message maps live there) and
// writes into shared.refs.messages / shared.refs.sessionUsage. Two
// injected callbacks connect it to sibling modules: `renderQuestions()`
// requests re-rendering of assistant bubbles that own a pending
// question (the interactive card is drawn on the tool part itself —
// see buildQuestionCard in questions.ts), and `postMessage` forwards
// path/diff clicks to the extension host.

import { escapeHtml, renderMarkdown } from "./markdown"
import type { Message, MessageWithParts, Part, TokenUsage, ToolPart } from "./sdk"
import { getClient, refs, state, type MessageEntry } from "./shared"
import { openLightbox } from "./lightbox"
import { buildQuestionCard, clearQuestionDraft, findPendingQuestionForTool } from "./questions"

let renderQuestionsCb: () => void = () => {}
let postMessage: (msg: unknown) => void = () => {}
// Optional: caller can wire this so the error card's "Start new session"
// button can trigger the same flow as the toolbar "+" button. When left
// unset, the button falls back to a soft no-op with a status message.
let onNewSessionCb: (() => void) | undefined

export function initMessagesView(deps: {
  renderQuestions: () => void
  postMessage: (msg: unknown) => void
  onNewSession?: () => void
}) {
  renderQuestionsCb = deps.renderQuestions
  postMessage = deps.postMessage
  onNewSessionCb = deps.onNewSession
}

/** Ingest a full message+parts blob from /session/:id/message list. */
export function recordMessage(m: MessageWithParts) {
  const existing = state.messages.get(m.info.id)
  if (existing) {
    existing.info = m.info
    // reconcile parts by id
    for (const p of m.parts) {
      if (!existing.parts.has(p.id)) existing.partOrder.push(p.id)
      existing.parts.set(p.id, p)
    }
    return
  }
  const partOrder = m.parts.map((p) => p.id)
  const parts = new Map<string, Part>()
  for (const p of m.parts) parts.set(p.id, p)
  state.messages.set(m.info.id, { info: m.info, parts, partOrder })
  state.messageOrder.push(m.info.id)
}

/** Update or insert a message record without touching its parts. */
export function upsertMessage(info: Message) {
  const existing = state.messages.get(info.id)
  if (existing) {
    existing.info = info
    return
  }
  state.messages.set(info.id, { info, parts: new Map(), partOrder: [] })
  state.messageOrder.push(info.id)
}

/** Insert or replace a single part; buffer if we haven't seen the parent yet. */
export function upsertPart(sessionID: string, part: Part) {
  if (sessionID !== state.sessionID) return
  // Every part carries a parent messageID via partBase.messageID; but that field
  // isn't part of our stripped types — the server does include it. Cast to unknown.
  const messageID = (part as unknown as { messageID?: string }).messageID
  if (!messageID) return
  const entry = state.messages.get(messageID)
  if (!entry) {
    // We may not have the message record yet (arrives via message.updated).
    // Buffer the part; it'll surface on next full render pass.
    orphanParts.push({ messageID, part })
    return
  }
  if (!entry.parts.has(part.id)) entry.partOrder.push(part.id)
  entry.parts.set(part.id, part)
}

const orphanParts: { messageID: string; part: Part }[] = []
export function flushOrphanParts() {
  const remaining: typeof orphanParts = []
  for (const item of orphanParts) {
    const entry = state.messages.get(item.messageID)
    if (!entry) {
      remaining.push(item)
      continue
    }
    if (!entry.parts.has(item.part.id)) entry.partOrder.push(item.part.id)
    entry.parts.set(item.part.id, item.part)
  }
  orphanParts.length = 0
  orphanParts.push(...remaining)
}

/** Reset the messages list; used on session switch. */
export function clearMessagesRender() {
  state.messages.clear()
  state.messageOrder.length = 0
  orphanParts.length = 0
  openCompactions.clear()
  refs.messages.innerHTML = ""
}

export function renderEmptyState() {
  if (state.messageOrder.length > 0) return
  refs.messages.innerHTML = ""
  const empty = document.createElement("div")
  empty.className = "empty"
  empty.textContent = state.sessionID ? "Start the conversation by typing a message below." : "Preparing session…"
  refs.messages.appendChild(empty)
}

export function renderAllMessages() {
  flushOrphanParts()
  refs.messages.innerHTML = ""
  if (state.messageOrder.length === 0) {
    const empty = document.createElement("div")
    empty.className = "empty"
    empty.textContent = "Start the conversation by typing a message below."
    refs.messages.appendChild(empty)
    updateSessionUsage()
    // question cards still need to appear even in an empty session (rare
    // but possible if the first turn only spawned a question).
    renderQuestionsCb()
    return
  }
  for (const id of state.messageOrder) {
    const entry = state.messages.get(id)
    if (!entry) continue
    const el = renderMessage(entry)
    if (el) refs.messages.appendChild(el)
  }
  updateSessionUsage()
  // Rerender pending question cards below the messages after the wipe above.
  renderQuestionsCb()
  scrollToBottom()
}

export function scrollToBottom() {
  requestAnimationFrame(() => {
    refs.messages.scrollTop = refs.messages.scrollHeight
  })
}

export function isAtBottom(): boolean {
  return refs.messages.scrollHeight - refs.messages.scrollTop - refs.messages.clientHeight < 40
}

// Surface an out-of-band session error (misconfigured model, unreachable
// provider baseURL, invalid API key, provider-side 5xx, etc.) as a visible
// bubble at the bottom of the list. Without this, `session.error` events
// only flash across the status line — quickly buried by the next "Ready"
// or "Assistant is working…" — and users have no idea their prompt failed.
//
// De-duplication contract: opencode fires `session.error` AND, in most
// failure modes, also stores the same error onto the last assistant
// message's `.error` field (see session/prompt.ts error path). Rendering
// both would produce two identical cards stacked on top of each other.
//
// Strategy: prefer the assistant-message path (it's persistent, re-renders
// on session switch, and is anchored to the correct turn). If the message
// list already has a trailing assistant message that carries an error with
// the same signature, we skip the standalone bubble. Otherwise we still
// need one — some server-level errors (session startup, auth) fire before
// any assistant message exists and only reach the user through the SSE
// event.
//
// The standalone bubble is transient: it's appended directly to the DOM
// (not into state.messages), so a full renderAllMessages() wipe replaces
// it with the message-anchored card when the server later attaches the
// error to the assistant turn.
export function showSessionError(err: { name?: string; message?: string; data?: unknown }) {
  if (hasMatchingMessageError(err)) return
  const wrap = document.createElement("div")
  wrap.className = "msg assistant session-error-msg"
  const bubble = document.createElement("div")
  bubble.className = "bubble prose"
  bubble.appendChild(renderErrorCard(err))
  wrap.appendChild(bubble)
  const wasAtBottom = isAtBottom()
  refs.messages.appendChild(wrap)
  if (wasAtBottom) scrollToBottom()
}

// Look at the last assistant message: does it already carry an error whose
// message text matches what we're about to render? Empty-message errors
// aren't considered a match (the assistant-message renderer suppresses
// those anyway).
function hasMatchingMessageError(err: { name?: string; message?: string; data?: unknown }): boolean {
  for (let i = state.messageOrder.length - 1; i >= 0; i--) {
    const entry = state.messages.get(state.messageOrder[i])
    if (!entry) continue
    if (entry.info.role !== "assistant") continue
    const existing = (entry.info as { error?: { name?: string; message?: string; data?: unknown } }).error
    if (!existing) return false
    return sameErrorSignature(existing, err)
  }
  return false
}

// Two errors count as "the same" for de-dup purposes if their message
// texts are identical (after trim) OR the shorter one is a prefix of the
// longer — opencode occasionally truncates one side. Falls back to a
// data-payload comparison when neither carries a message string.
function sameErrorSignature(
  a: { message?: string; data?: unknown },
  b: { message?: string; data?: unknown },
): boolean {
  const am = (a.message ?? "").trim()
  const bm = (b.message ?? "").trim()
  if (am && bm) {
    if (am === bm) return true
    const [short, long] = am.length < bm.length ? [am, bm] : [bm, am]
    if (long.startsWith(short) && short.length > 30) return true
  }
  const ad = a.data ? safeStringify(a.data) : ""
  const bd = b.data ? safeStringify(b.data) : ""
  return !!ad && ad === bd
}

// -------------------------------------------------------------------------
// Error card renderer (shared by showSessionError + assistant-message errors)
// -------------------------------------------------------------------------
//
// opencode's APIError.message is often a dumped JSON blob from the upstream
// provider — e.g. openrouter.woa.com returns
//   {"error":{"message":"...","code":"4003"},"venusMarker":{...}}
// with a 400. Rendering that raw makes the error card unreadable: the
// interesting single line ("input X tokens > limit Y") is buried inside
// ~500 chars of headers/metadata.
//
// The renderer here:
//   1. Recognises a handful of well-known failure categories (context
//      overflow, rate limit, auth, upstream 5xx, network) and shows a
//      short human title + the most useful numbers extracted from the
//      payload.
//   2. Adds a category-specific "what to do next" line so users don't
//      have to guess whether the problem is client-side config or an
//      upstream limit.
//   3. Collapses the raw JSON behind a "Show details" toggle so it's
//      still available for support / bug reports but doesn't dominate
//      the card by default.
//
// The parser is intentionally lenient: any regex we miss falls through to
// a generic "APIError" render that still looks nicer than dumping the
// stringified `data` field.
type ErrorKind = "context" | "rate-limit" | "auth" | "upstream" | "network" | "generic"

interface ClassifiedError {
  kind: ErrorKind
  title: string
  summary: string
  facts: Array<{ label: string; value: string }>
  advice: string
  raw: string
}

function classifyError(err: { name?: string; message?: string; data?: unknown }): ClassifiedError {
  const rawMessage = (err.message ?? "").trim()
  const rawData = err.data ? safeStringify(err.data) : ""
  // Combined haystack for regex matching — we don't care whether the
  // interesting substring came from the exception message or the response
  // body; both routinely appear in either slot depending on which layer
  // caught the error first.
  const haystack = [rawMessage, rawData].filter(Boolean).join("\n")

  // Try to pull an inner .error.message out of a JSON-looking blob so we
  // can quote just the human-readable line instead of the whole envelope.
  const inner = extractInnerErrorMessage(haystack)

  // 1) Context length overflow. Upstream messages vary but almost always
  //    include the two token counts and the word "context". Sample:
  //    "The input (295615 tokens) is longer than the model's context
  //    length (200000 tokens)."
  const ctxMatch = haystack.match(
    /input.{0,40}?(\d[\d,]*)\s*tokens?.{0,60}?context\s*length.{0,20}?(\d[\d,]*)/i,
  )
  if (
    ctxMatch ||
    /context[_ ]length[_ ]exceeded|maximum context length|too many input tokens/i.test(haystack)
  ) {
    const used = ctxMatch ? parseIntSafe(ctxMatch[1]) : undefined
    const limit = ctxMatch ? parseIntSafe(ctxMatch[2]) : undefined
    const facts: ClassifiedError["facts"] = []
    if (used !== undefined) facts.push({ label: "Input tokens", value: used.toLocaleString() })
    if (limit !== undefined) facts.push({ label: "Model limit", value: limit.toLocaleString() })
    if (used !== undefined && limit !== undefined) {
      const over = used - limit
      facts.push({ label: "Over by", value: `${over.toLocaleString()} (${((used / limit - 1) * 100).toFixed(0)}%)` })
    }
    return {
      kind: "context",
      title: "Context length exceeded",
      summary:
        inner ||
        (used !== undefined && limit !== undefined
          ? `Input is ${used.toLocaleString()} tokens; upstream model accepts at most ${limit.toLocaleString()}.`
          : "The message you sent (with history + tool output) is longer than the model's context window."),
      facts,
      advice:
        limit !== undefined
          ? `This turn's payload is already over the model's ${limit.toLocaleString()}-token cap. If the payload spike came from your latest message alone — an @-attached large file, or a huge tool result — “Compact this session” won't help, because compaction preserves the recent tail (including that message) so the model still has context to work with. In that case: start a new session, or re-@ the file with a smaller line range like \`file.ts:100-300\`. If the payload grew gradually across many turns, Compact should work.`
          : "Click “Compact this session” to summarise the history, or start a new session. opencode only auto-compacts based on the previous turn's usage, so a single over-budget request always reaches the upstream and gets rejected.",
      raw: haystack,
    }
  }

  // 2) Rate limit / quota. openrouter, anthropic, openai all use 429.
  if (/429|rate.?limit|too many requests|quota/i.test(haystack)) {
    const retryMatch = haystack.match(/retry.{0,20}?(\d+)\s*(second|ms|milli)/i)
    return {
      kind: "rate-limit",
      title: "Rate limit / quota",
      summary: inner || "The upstream provider rejected the request because you've exceeded a rate or quota limit.",
      facts: retryMatch ? [{ label: "Retry after", value: `${retryMatch[1]} ${retryMatch[2]}` }] : [],
      advice:
        "Wait a bit and resend, or switch to a different model / provider that isn't currently throttled.",
      raw: haystack,
    }
  }

  // 3) Authentication / authorisation.
  if (/401|403|unauthori[sz]ed|invalid.{0,10}(api.?key|token)|authentication/i.test(haystack)) {
    return {
      kind: "auth",
      title: "Authentication failed",
      summary: inner || "The upstream provider rejected your credentials.",
      facts: [],
      advice:
        "Open Settings → Providers and check the API key. For env-based providers, verify the environment variable is set in the extension host's shell (not just your terminal), then restart the server.",
      raw: haystack,
    }
  }

  // 4) Upstream 5xx / server-side error.
  const statusMatch = haystack.match(/["']?status(?:Code)?["']?\s*[:=]\s*(\d{3})/)
  const status = statusMatch ? parseIntSafe(statusMatch[1]) : undefined
  if (status !== undefined && status >= 500) {
    return {
      kind: "upstream",
      title: `Upstream error (HTTP ${status})`,
      summary: inner || "The upstream model provider returned a server error.",
      facts: [{ label: "Status", value: String(status) }],
      advice: "Try again in a moment. If it persists, check the provider's status page or switch models.",
      raw: haystack,
    }
  }

  // 5) Network-level.
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(haystack)) {
    return {
      kind: "network",
      title: "Network error",
      summary: inner || "The extension couldn't reach the upstream provider.",
      facts: [],
      advice:
        "Verify the provider's baseURL is reachable from this machine (curl it from the same shell VSCode was launched from). Corporate proxies often need HTTPS_PROXY set for the extension host too.",
      raw: haystack,
    }
  }

  // 6) Fallback — still nicer than the old raw dump.
  return {
    kind: "generic",
    title: err.name || "APIError",
    summary: inner || rawMessage || "The opencode server reported an error but did not include a message.",
    facts: status !== undefined ? [{ label: "Status", value: String(status) }] : [],
    advice: "Check the model/provider settings (Providers tab) and the OpenCode Output panel for the full response.",
    raw: haystack,
  }
}

// Extract a human-readable line out of a JSON envelope like
// `{"error":{"message":"..."},"venusMarker":{...}}`. Falls back to
// undefined when the input doesn't parse as JSON or when the shape
// doesn't match anything we recognise — the classifier then keeps the
// full haystack as the summary source.
function extractInnerErrorMessage(text: string): string | undefined {
  // Find the outermost { … } block in the text; opencode's APIError
  // sometimes prefixes it with a stack-like string.
  const start = text.indexOf("{")
  if (start === -1) return undefined
  const jsonSlice = text.slice(start)
  try {
    const parsed = JSON.parse(jsonSlice)
    // Common shapes: { error: { message } }, { message }, { detail }.
    const candidates: unknown[] = [
      (parsed as { error?: { message?: string } })?.error?.message,
      (parsed as { message?: string })?.message,
      (parsed as { detail?: string })?.detail,
      (parsed as { responseBody?: string })?.responseBody,
    ]
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        // responseBody itself is a JSON string — recurse once so we drill
        // through the "responseBody":"{\"error\":{...}}" wrapper opencode
        // sometimes serialises around upstream errors.
        const trimmed = c.trim()
        if (trimmed.startsWith("{")) {
          const nested = extractInnerErrorMessage(trimmed)
          if (nested) return nested
        }
        return trimmed
      }
    }
  } catch {
    // not JSON — fine
  }
  return undefined
}

function parseIntSafe(s: string): number | undefined {
  const n = Number(s.replace(/,/g, ""))
  return Number.isFinite(n) ? n : undefined
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// Turn a ClassifiedError into a DOM node. Layout:
//   ⚠ Title                                              [category badge]
//   Human-readable summary sentence.
//   • Fact 1: value    • Fact 2: value    (rendered as chips)
//   💡 What to do next: …
//   ▸ Show details      (click → reveals <pre> with raw payload)
function renderErrorCard(err: { name?: string; message?: string; data?: unknown }): HTMLElement {
  const c = classifyError(err)
  const card = document.createElement("div")
  card.className = `tool error-card error-card-${c.kind}`

  const header = document.createElement("div")
  header.className = "tool-header error-card-header"
  const icon = document.createElement("span")
  icon.className = "tool-icon"
  icon.textContent = errorIconGlyph(c.kind)
  header.appendChild(icon)
  const title = document.createElement("span")
  title.className = "tool-name"
  title.textContent = c.title
  header.appendChild(title)
  const spacer = document.createElement("span")
  spacer.style.flex = "1"
  header.appendChild(spacer)
  const badge = document.createElement("span")
  badge.className = "tool-status error"
  badge.textContent = "error"
  header.appendChild(badge)
  card.appendChild(header)

  const body = document.createElement("div")
  body.className = "tool-body error-card-body"

  const summaryEl = document.createElement("div")
  summaryEl.className = "error-card-summary"
  summaryEl.textContent = c.summary
  body.appendChild(summaryEl)

  if (c.facts.length > 0) {
    const facts = document.createElement("div")
    facts.className = "error-card-facts"
    for (const f of c.facts) {
      const chip = document.createElement("span")
      chip.className = "error-card-fact"
      const k = document.createElement("span")
      k.className = "error-card-fact-key"
      k.textContent = f.label
      const v = document.createElement("span")
      v.className = "error-card-fact-val"
      v.textContent = f.value
      chip.appendChild(k)
      chip.appendChild(v)
      facts.appendChild(chip)
    }
    body.appendChild(facts)
  }

  if (c.advice) {
    const advice = document.createElement("div")
    advice.className = "error-card-advice"
    const bulb = document.createElement("span")
    bulb.className = "error-card-advice-icon"
    bulb.textContent = "💡"
    const text = document.createElement("span")
    text.textContent = c.advice
    advice.appendChild(bulb)
    advice.appendChild(text)
    body.appendChild(advice)
  }

  const actions = buildErrorActions(c)
  if (actions) body.appendChild(actions)

  // Raw payload folded away by default. We keep it because upstream error
  // envelopes often carry a `spanId` / request-id users need to share with
  // whoever runs the upstream service.
  if (c.raw && c.raw.trim()) {
    const details = document.createElement("details")
    details.className = "error-card-details"
    const summary = document.createElement("summary")
    summary.textContent = "Show raw response"
    details.appendChild(summary)
    const pre = document.createElement("pre")
    pre.className = "error-card-raw"
    pre.textContent = c.raw
    details.appendChild(pre)
    // Add a copy button so users can grab the payload for bug reports
    // without having to select-all inside the <pre>.
    const copyBtn = document.createElement("button")
    copyBtn.type = "button"
    copyBtn.className = "error-card-copy"
    copyBtn.textContent = "Copy"
    copyBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      const ok = await copyToClipboard(c.raw)
      copyBtn.textContent = ok ? "Copied" : "Copy failed"
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200)
    })
    details.appendChild(copyBtn)
    body.appendChild(details)
  }

  card.appendChild(body)
  return card
}

// Actionable follow-ups for an error card. Only the "context overflow"
// class gets buttons because it's the only case where the webview can
// meaningfully act without user input:
//
//   • Compact this session — calls POST /session/:id/summarize. The
//     server not only produces the summary, it also runs a retry loop
//     with `summary + tail turns` on the same session BEFORE returning.
//     If the tail's last user message itself was over budget (typical
//     when the message carried a large @-attachment or a big paste),
//     that retry hits the same context-length error and produces a
//     second error card below this one. We DON'T hide the second card
//     — it's the source of truth for the retry failure. Instead we
//     append a small "Compact requested — this session will auto-retry"
//     hint to THIS card so the user isn't surprised when another error
//     bubble shows up.
//   • Start new session — hard reset, useful when compact isn't enough.
//
// Returns undefined when there's nothing useful to offer.
function buildErrorActions(c: ClassifiedError): HTMLElement | undefined {
  if (c.kind !== "context") return undefined

  const row = document.createElement("div")
  row.className = "error-card-actions"

  // A single-line hint that appears below the buttons after the user
  // clicks Compact. Made ahead of time so the click handler can flip
  // it hidden→visible without rebuilding the action row. Explains the
  // "why is there another error card underneath?" phenomenon.
  const hint = document.createElement("div")
  hint.className = "error-card-inline-hint"
  hint.hidden = true
  hint.textContent =
    "Compact requested — this session will auto-retry. If the retry also fails, a new error card will appear below."

  const compactBtn = document.createElement("button")
  compactBtn.type = "button"
  compactBtn.className = "error-card-action primary"
  compactBtn.textContent = "Compact this session"
  compactBtn.title =
    "Ask opencode to summarise older history and auto-retry the last turn."
  compactBtn.addEventListener("click", async () => {
    const client = getClient()
    const sessionID = state.sessionID
    if (!client || !sessionID) {
      compactBtn.textContent = "No active session"
      return
    }
    const modelSel = pickSessionModel()
    if (!modelSel) {
      compactBtn.textContent = "No model configured"
      return
    }
    compactBtn.disabled = true
    compactBtn.textContent = "Compacting…"
    hint.hidden = false
    try {
      await client.compactSession(sessionID, modelSel.providerID, modelSel.modelID)
      compactBtn.textContent = "Done"
      compactBtn.classList.add("done")
    } catch (err) {
      compactBtn.disabled = false
      compactBtn.textContent = "Retry compact"
      compactBtn.title = (err as Error).message
    }
  })
  row.appendChild(compactBtn)

  const newBtn = document.createElement("button")
  newBtn.type = "button"
  newBtn.className = "error-card-action"
  newBtn.textContent = "Start new session"
  newBtn.title = "Clear the current session and open an empty one."
  newBtn.addEventListener("click", () => {
    if (onNewSessionCb) onNewSessionCb()
    else newBtn.textContent = "Use the “+” in the toolbar"
  })
  row.appendChild(newBtn)

  // Wrap row + hint together so the caller only has to append a single
  // node to the card body.
  const wrap = document.createElement("div")
  wrap.className = "error-card-actions-wrap"
  wrap.appendChild(row)
  wrap.appendChild(hint)
  return wrap
}

// Best-effort look-up for the model to feed into the compact endpoint.
// The session's last assistant/user message usually carries the exact
// (provider, model) pair used for that turn; falling back to defaults
// covers newly created sessions where nothing has been sent yet.
function pickSessionModel(): { providerID: string; modelID: string } | undefined {
  const sessionID = state.sessionID
  if (sessionID) {
    // Walk message order from newest to oldest; first entry with a model
    // wins. Both roles record it (server echoes the assistant's routing
    // model onto the user request too).
    for (let i = state.messageOrder.length - 1; i >= 0; i--) {
      const entry = state.messages.get(state.messageOrder[i])
      const m = entry?.info.model
      if (m?.providerID && m?.modelID) return { providerID: m.providerID, modelID: m.modelID }
    }
  }
  const dm = state.defaultModel
  if (dm && dm.includes("/")) {
    const idx = dm.indexOf("/")
    return { providerID: dm.slice(0, idx), modelID: dm.slice(idx + 1) }
  }
  return undefined
}

function errorIconGlyph(kind: ErrorKind): string {
  switch (kind) {
    case "context":
      return "📏"
    case "rate-limit":
      return "⏱"
    case "auth":
      return "🔒"
    case "upstream":
      return "☁"
    case "network":
      return "🌐"
    default:
      return "⚠"
  }
}

export function renderIncremental(messageID: string) {
  flushOrphanParts()
  const entry = state.messages.get(messageID)
  if (!entry) return
  const el = refs.messages.querySelector<HTMLElement>(`[data-message-id="${messageID}"]`)
  const replacement = renderMessage(entry)
  const wasAtBottom = isAtBottom()
  if (replacement) {
    if (el) el.replaceWith(replacement)
    else {
      const empty = refs.messages.querySelector(".empty")
      empty?.remove()
      // Plan B (see questions.ts): pending question cards live INSIDE
      // the assistant bubble on the running `question` tool part, not
      // as free-floating children of refs.messages. So new messages
      // just append at the end — nothing to pin around.
      refs.messages.appendChild(replacement)
    }
    // When this message now carries an error, drop any standalone session-
    // error bubble that showSessionError() may have added earlier: the SSE
    // `session.error` event and the assistant-message `.error` field
    // arrive out of order, and rendering both leaves the user staring at
    // two identical cards.
    const carriesError = (entry.info as { error?: unknown }).error !== undefined
    if (carriesError) {
      for (const stray of refs.messages.querySelectorAll(".session-error-msg")) {
        stray.remove()
      }
    }
  } else if (el) {
    // Message became renderless (e.g. still empty error placeholder); drop it.
    el.remove()
  }
  updateSessionUsage()
  if (wasAtBottom) scrollToBottom()
}

/** SSE handler for message.removed. */
export function removeMessageFromDom(messageID: string) {
  state.messages.delete(messageID)
  state.messageOrder = state.messageOrder.filter((id) => id !== messageID)
  const el = refs.messages.querySelector(`[data-message-id="${messageID}"]`)
  el?.remove()
}

function renderMessage(entry: MessageEntry): HTMLElement | null {
  // Short-circuit compaction turns into a single collapsed card. Server-
  // side compaction fires TWO messages into the stream:
  //   • a user message carrying a `type: "compaction"` marker part (empty
  //     otherwise — this is just the "please compact" trigger);
  //   • an assistant message with `agent: "compaction"` + `summary: true`,
  //     containing the summary text produced by the compaction model.
  // Rendering these inline splits the user's actual conversation into
  // "your turn → compaction trigger card → compaction summary bubble →
  // model's continuation" with a wall of summary text in the middle. Fold
  // both into a single compact chip that expands on click. See
  // `packages/opencode/src/session/compaction.ts` lines ~360 for the
  // producing side.
  if (isCompactionMessage(entry)) return renderCompactionMessage(entry)

  const bubble = document.createElement("div")
  bubble.className = "bubble prose"

  // Collected plain-text form of this message, used by the copy button on the
  // meta row. For user messages this is exactly what they typed; for assistant
  // messages it's the concatenated text/reasoning parts (tool call output is
  // omitted — copying the raw JSON of every tool call is rarely useful).
  let copyText = ""

  if (entry.info.role === "user") {
    // User messages can now contain text plus one or more file attachments.
    // Preserve authoring order but split them into visual groups: text goes
    // into a whitespace-preserving span, files render as small chips/images
    // via renderPart. If neither exists, drop the bubble entirely.
    //
    // IMPORTANT: skip parts flagged `synthetic: true`. Server injects these
    // when it expands a file attachment (e.g. "Called the Read tool with …"
    // followed by the whole file content) so the model sees the context.
    // Rendering them in the user bubble makes the bubble absurdly long and
    // hides what the user actually typed. Same rule already applies in the
    // assistant branch below and in renderPart.
    const textChunks: string[] = []
    let fileCount = 0
    for (const pid of entry.partOrder) {
      const part = entry.parts.get(pid)
      if (!part) continue
      if (part.type === "text") {
        const tp = part as { text?: string; synthetic?: boolean }
        if (tp.synthetic) continue
        if (tp.text) textChunks.push(tp.text)
      } else if (part.type === "file") {
        // Skip server-synthesised file parts too — those come from Read tool
        // expansion, not from the user, and render as noisy duplicates.
        if ((part as { synthetic?: boolean }).synthetic) continue
        const el = renderPart(part, entry.info.id)
        if (el) {
          bubble.appendChild(el)
          fileCount++
        }
      }
    }
    if (textChunks.length > 0) {
      const joined = textChunks.join("\n")
      // Slash commands (e.g. `/understand`) get server-expanded into a full
      // template dump — often multi-hundred-line skill descriptions — that
      // arrives here as the user message text. Rendering it verbatim buries
      // whatever the user actually typed. We detect the expansion by the
      // template's canonical `# /<name>` first line (see command/template/*
      // and third-party skill templates) and collapse it: header stays
      // visible, body hides behind a Show/Hide toggle. Non-command user
      // text keeps rendering unchanged.
      const commandHeader = joined.match(/^#\s+\/([\w-]+)\s*\n/)
      if (commandHeader) {
        bubble.appendChild(renderCollapsedCommand(commandHeader[1], joined))
      } else {
        const textEl = document.createElement("div")
        textEl.className = "user-text"
        textEl.textContent = joined
        bubble.appendChild(textEl)
      }
    }
    if (textChunks.length === 0 && fileCount === 0) return null
    copyText = textChunks.join("\n")
  } else {
    const textChunks: string[] = []
    for (const pid of entry.partOrder) {
      const part = entry.parts.get(pid)
      if (!part) continue
      const el = renderPart(part, entry.info.id)
      if (el) bubble.appendChild(el)
      if (part.type === "text") {
        const tp = part as { text?: string; synthetic?: boolean }
        if (tp.text && !tp.synthetic) textChunks.push(tp.text)
      } else if (part.type === "reasoning") {
        const rp = part as { text?: string }
        if (rp.text) textChunks.push(rp.text)
      }
    }
    copyText = textChunks.join("\n\n")
    const err = (entry.info as { error?: { name: string; message?: string; data?: unknown } }).error
    // opencode occasionally emits a trailing assistant message that carries
    // nothing but an unnamed/empty APIError — typically an aborted follow-up
    // continuation or a hidden helper turn. Rendering that as a big red
    // "APIError" bubble is pure noise. Only surface errors that carry an
    // actual message, and only if the message itself has any content to show.
    const hasContent = entry.partOrder.some((pid) => {
      const p = entry.parts.get(pid)
      if (!p) return false
      if (p.type === "text") {
        const tp = p as { text?: string; synthetic?: boolean }
        return !!tp.text && !tp.synthetic
      }
      if (p.type === "tool" || p.type === "reasoning" || p.type === "patch") return true
      return false
    })
    const meaningfulError = !!(err && ((err.message && err.message.trim()) || err.data))
    if (err && (hasContent || meaningfulError)) {
      // Route both inline (per-message) and standalone (session) errors
      // through renderErrorCard so users get the same categorised, human-
      // readable presentation instead of a raw JSON dump.
      bubble.appendChild(renderErrorCard(err))
    }
    if (!hasContent && !meaningfulError) return null
  }

  const wrap = document.createElement("div")
  wrap.className = `msg ${entry.info.role}`
  wrap.dataset.messageId = entry.info.id
  wrap.appendChild(bubble)

  const meta = document.createElement("div")
  meta.className = "meta"
  const label = document.createElement("span")
  label.textContent = entry.info.role === "user" ? "You" : agentLabel(entry.info)
  meta.appendChild(label)
  // Token/cost badge on assistant messages: opencode reports usage per turn on
  // the assistant message metadata. Only render when the server actually filled
  // it in (finished turns) so partial in-flight streams stay quiet.
  if (entry.info.role === "assistant") {
    const badge = tokenBadge(entry.info as { tokens?: TokenUsage; cost?: number })
    if (badge) meta.appendChild(badge)
  }
  if (copyText) meta.appendChild(makeCopyButton(copyText))
  wrap.appendChild(meta)

  return wrap
}

// Sum tokens/cost across every assistant message in the current session and
// render a compact badge on the topbar. Kept O(n) and re-run after any message
// event; the message count is small enough that microoptimizing is pointless.
function updateSessionUsage() {
  if (!refs.sessionUsage) return
  let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, cost = 0
  let turns = 0
  for (const id of state.messageOrder) {
    const entry = state.messages.get(id)
    if (!entry || entry.info.role !== "assistant") continue
    const info = entry.info as { tokens?: TokenUsage; cost?: number }
    const t = info.tokens
    if (!t) continue
    const turnTotal = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    if (turnTotal <= 0) continue
    input += t.input ?? 0
    output += t.output ?? 0
    reasoning += t.reasoning ?? 0
    cacheRead += t.cache?.read ?? 0
    cacheWrite += t.cache?.write ?? 0
    cost += info.cost ?? 0
    turns += 1
  }
  if (turns === 0) {
    refs.sessionUsage.hidden = true
    refs.sessionUsage.textContent = ""
    refs.sessionUsage.title = ""
    return
  }
  const parts = [`↑${formatTokens(input)}`, `↓${formatTokens(output)}`]
  const costStr = formatCost(cost)
  if (costStr) parts.push(costStr)
  refs.sessionUsage.textContent = parts.join(" · ")
  refs.sessionUsage.title = [
    `session totals across ${turns} turn${turns === 1 ? "" : "s"}:`,
    `input:       ${input}`,
    `output:      ${output}`,
    `reasoning:   ${reasoning}`,
    `cache read:  ${cacheRead}`,
    `cache write: ${cacheWrite}`,
    cost > 0 ? `cost:        $${cost.toFixed(6)}` : "",
  ].filter(Boolean).join("\n")
  refs.sessionUsage.hidden = false
}

// Format token counts as compact strings: 1234 → "1.2k", 4200000 → "4.2M".
// Sub-1k stays exact so users see accuracy where it matters most (short turns).
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1000) return String(n)
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
  return `${(n / 1000000).toFixed(n < 10000000 ? 2 : 1)}M`
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return ""
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

// Small pill next to the agent label showing per-turn token usage. Returns
// null when the message hasn't finished (no usage recorded yet) so we don't
// paint zeros over an in-flight assistant reply.
function tokenBadge(info: { tokens?: TokenUsage; cost?: number }): HTMLElement | null {
  const t = info.tokens
  if (!t) return null
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  if (total <= 0) return null

  const badge = document.createElement("span")
  badge.className = "token-badge"
  const parts: string[] = [`↑${formatTokens(t.input ?? 0)}`, `↓${formatTokens(t.output ?? 0)}`]
  const cost = formatCost(info.cost ?? 0)
  if (cost) parts.push(cost)
  badge.textContent = parts.join(" · ")
  // Tooltip carries the full breakdown for users who want details.
  const tip = [
    `input:     ${t.input ?? 0}`,
    `output:    ${t.output ?? 0}`,
    `reasoning: ${t.reasoning ?? 0}`,
    `cache read:  ${t.cache?.read ?? 0}`,
    `cache write: ${t.cache?.write ?? 0}`,
  ]
  if (info.cost) tip.push(`cost: $${info.cost.toFixed(6)}`)
  badge.title = tip.join("\n")
  return badge
}

// Compact bubble body for slash-command user messages. Shows just the
// command name + args (extracted from the template's `# /name` header +
// whatever follows on subsequent lines) with a toggle to reveal the full
// expanded template. Keeps the message list scannable when a single command
// invocation would otherwise flood the viewport with skill docs.
//
// Args heuristic: opencode's own templates put arguments after $ARGUMENTS
// substitution inside the body, so we can't reliably re-extract them from
// the expanded text. We just show the command name; the user still knows
// what they typed. Full text is one click away.
function renderCollapsedCommand(commandName: string, fullText: string): HTMLElement {
  const wrap = document.createElement("div")
  wrap.className = "user-command-collapsed"

  const head = document.createElement("div")
  head.className = "user-command-head"

  const marker = document.createElement("span")
  marker.className = "user-command-marker"
  marker.textContent = "/"
  head.appendChild(marker)

  const name = document.createElement("span")
  name.className = "user-command-name"
  name.textContent = commandName
  head.appendChild(name)

  const toggle = document.createElement("button")
  toggle.className = "user-command-toggle"
  toggle.type = "button"
  toggle.textContent = "Show details"
  head.appendChild(toggle)

  wrap.appendChild(head)

  const body = document.createElement("div")
  body.className = "user-text user-command-body"
  body.textContent = fullText
  body.hidden = true
  wrap.appendChild(body)

  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden
    toggle.textContent = body.hidden ? "Show details" : "Hide details"
  })

  return wrap
}

// Small clipboard button placed on the meta row of each bubble. VSCode webviews
// grant clipboard-write without prompting, so navigator.clipboard is fine.
// Falls back to a hidden textarea + execCommand("copy") if the async API is
// unavailable for any reason (older Electron, weird permissions, etc.).
function makeCopyButton(text: string): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.className = "copy-btn"
  btn.type = "button"
  btn.title = "Copy message"
  btn.setAttribute("aria-label", "Copy message")
  btn.textContent = "⧉" // simple clipboard-like glyph; keeps bundle free of icon fonts
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    const ok = await copyToClipboard(text)
    const original = btn.textContent
    btn.textContent = ok ? "✓" : "!"
    btn.classList.add(ok ? "copied" : "copy-failed")
    setTimeout(() => {
      btn.textContent = original
      btn.classList.remove("copied", "copy-failed")
    }, 1200)
  })
  return btn
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    ta.remove()
    return ok
  } catch {
    return false
  }
}

function agentLabel(info: Message): string {
  const agent = info.agent ?? ""
  const model = info.model?.modelID ?? ""
  if (agent && model) return `${agent} · ${model}`
  return agent || model || "assistant"
}

// Which compaction messages the user has opened. renderIncremental() runs
// on every part.updated during streaming and calls `el.replaceWith(new)`;
// without this memo the user's click to expand would be undone the next
// time a text chunk arrives. Keyed by message id so both the user marker
// and the assistant summary keep their own state.
const openCompactions = new Set<string>()

// A message belongs to a compaction turn when either
//   (a) it's the assistant summary itself (agent="compaction" or
//       summary=true — the server sets both), OR
//   (b) it's the user marker message whose only meaningful part is the
//       `type: "compaction"` marker (empty otherwise; carries `auto`
//       and `overflow` metadata for context, but nothing to render).
// Regular user messages that happen to sit right next to a compaction
// pass are not folded — we only touch the ones opencode itself synthesised.
function isCompactionMessage(entry: MessageEntry): boolean {
  const info = entry.info
  if (info.role === "assistant") {
    const a = info as { agent?: string; summary?: boolean; mode?: string }
    return a.agent === "compaction" || a.summary === true || a.mode === "compaction"
  }
  // user message: has a compaction marker part and no non-marker text.
  let hasMarker = false
  let hasOtherContent = false
  for (const pid of entry.partOrder) {
    const p = entry.parts.get(pid)
    if (!p) continue
    if (p.type === "compaction") {
      hasMarker = true
      continue
    }
    // A user message that happens to carry text alongside a compaction
    // marker (currently impossible on the server side, but be defensive)
    // is treated as a normal user message so we don't hide user text.
    if (p.type === "text") {
      const tp = p as { text?: string; synthetic?: boolean }
      if (tp.text && !tp.synthetic) hasOtherContent = true
    } else if (p.type === "file") {
      hasOtherContent = true
    }
  }
  return hasMarker && !hasOtherContent
}

// Render a collapsed chip for a compaction turn. Layout:
//   ▸ 📎 Compacted conversation history                (auto · 12 turns)
// Clicking toggles a body that shows the marker metadata (for user marker
// messages) or the summary text (for assistant summary messages) so users
// can still inspect what was compacted if they need to.
function renderCompactionMessage(entry: MessageEntry): HTMLElement | null {
  const info = entry.info
  const isAssistant = info.role === "assistant"

  // Gather visible content. For assistant summaries we take all
  // text/reasoning parts. For user markers we extract the auto/overflow
  // metadata into a small kv block.
  const summaryText: string[] = []
  const kvLines: string[] = []
  for (const pid of entry.partOrder) {
    const p = entry.parts.get(pid)
    if (!p) continue
    if (p.type === "text") {
      const tp = p as { text?: string; synthetic?: boolean }
      if (tp.text && !tp.synthetic) summaryText.push(tp.text)
    } else if (p.type === "reasoning") {
      const rp = p as { text?: string }
      if (rp.text) summaryText.push(rp.text)
    } else if (p.type === "compaction") {
      const cp = p as { auto?: boolean; overflow?: boolean; tail_start_id?: string }
      if (cp.auto !== undefined) kvLines.push(`auto: ${cp.auto}`)
      if (cp.overflow !== undefined) kvLines.push(`overflow: ${cp.overflow}`)
      if (cp.tail_start_id) kvLines.push(`tail_start_id: ${cp.tail_start_id}`)
    }
  }

  // Nothing to show at all → drop the message entirely rather than leave
  // a bare "▸ Compacted history" chip with an empty body.
  if (summaryText.length === 0 && kvLines.length === 0) return null

  const wrap = document.createElement("div")
  // Use a distinct class so styles.css can style the chip lighter than a
  // regular assistant bubble; the meta row is intentionally omitted (no
  // "assistant · model" label, no token badge) to keep it visually quiet.
  wrap.className = "msg compaction"
  wrap.dataset.messageId = info.id

  const chip = document.createElement("div")
  chip.className = "compaction-chip"
  chip.setAttribute("role", "button")
  chip.tabIndex = 0

  const arrow = document.createElement("span")
  arrow.className = "compaction-chip-arrow"
  arrow.textContent = "▸"
  chip.appendChild(arrow)

  const icon = document.createElement("span")
  icon.className = "compaction-chip-icon"
  icon.textContent = "📎"
  chip.appendChild(icon)

  const label = document.createElement("span")
  label.className = "compaction-chip-label"
  label.textContent = isAssistant ? "Compacted conversation history" : "Compaction triggered"
  chip.appendChild(label)

  // Optional short hint on the right. For the user marker we surface the
  // auto/overflow flags concisely so users can eyeball WHY compaction ran
  // without expanding the body.
  const hintBits: string[] = []
  if (!isAssistant) {
    for (const pid of entry.partOrder) {
      const p = entry.parts.get(pid)
      if (p?.type === "compaction") {
        const cp = p as { auto?: boolean; overflow?: boolean }
        if (cp.overflow) hintBits.push("overflow")
        else if (cp.auto) hintBits.push("auto")
        else hintBits.push("manual")
        break
      }
    }
  } else if (summaryText.length > 0) {
    const chars = summaryText.reduce((n, s) => n + s.length, 0)
    hintBits.push(`${formatCompactionChars(chars)} chars`)
  }
  if (hintBits.length > 0) {
    const hint = document.createElement("span")
    hint.className = "compaction-chip-hint"
    hint.textContent = hintBits.join(" · ")
    chip.appendChild(hint)
  }

  const body = document.createElement("div")
  body.className = "compaction-body"
  const startOpen = openCompactions.has(info.id)
  body.hidden = !startOpen
  arrow.textContent = startOpen ? "▾" : "▸"

  if (kvLines.length > 0) {
    const kv = document.createElement("div")
    kv.className = "compaction-body-kv"
    kv.textContent = kvLines.join(" · ")
    body.appendChild(kv)
  }
  if (summaryText.length > 0) {
    const pre = document.createElement("pre")
    pre.className = "compaction-body-text"
    pre.textContent = summaryText.join("\n\n")
    body.appendChild(pre)
  }

  const toggle = () => {
    body.hidden = !body.hidden
    arrow.textContent = body.hidden ? "▸" : "▾"
    if (body.hidden) openCompactions.delete(info.id)
    else openCompactions.add(info.id)
  }
  chip.addEventListener("click", toggle)
  chip.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault()
      toggle()
    }
  })

  wrap.appendChild(chip)
  wrap.appendChild(body)
  return wrap
}

function formatCompactionChars(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function renderPart(part: Part, messageID: string): HTMLElement | null {
  if (part.type === "text") {
    const text = (part as { text: string }).text ?? ""
    if (!text) return null
    if ((part as { synthetic?: boolean }).synthetic) return null
    const div = document.createElement("div")
    div.className = "prose"
    div.innerHTML = renderMarkdown(text)
    return div
  }
  if (part.type === "reasoning") {
    const text = (part as { text: string }).text ?? ""
    if (!text) return null
    const div = document.createElement("div")
    div.className = "tool"
    div.innerHTML = `<div class="tool-header"><span class="tool-icon">💭</span><span class="tool-name">reasoning</span></div><div class="tool-body">${escapeHtml(text)}</div>`
    return div
  }
  if (part.type === "tool") {
    // The `question` tool renders as a card, not the generic tool row.
    // Two paths depending on state.status:
    //   • running  → interactive card (Plan-B: the pending question lives
    //     here in the assistant bubble, not as a floating card at the
    //     bottom of the messages list). Match by tool.callID via
    //     findPendingQuestionForTool so the same DOM is used whether the
    //     user has just started answering or is mid-typing after a
    //     partial-render round trip. Selections survive rerenders via the
    //     questionDrafts memo inside questions.ts.
    //   • completed / error → read-only card via renderAnsweredQuestionCard,
    //     showing what was asked and what the user picked, with disabled
    //     inputs. Errored calls surface as "Question dismissed".
    // Anything else falls back to the generic tool row (should not
    // normally happen for tool="question", but avoids a blank tool part
    // if the server ever adds a new status).
    const tp = part as ToolPart
    if (tp.tool === "question") {
      const status = tp.state.status
      if (status === "running") {
        const req = findPendingQuestionForTool(messageID, tp.callID)
        if (req) return buildQuestionCard(req)
        // No matching pending request: SSE ordering hiccup, or the ask
        // has already been answered on the server but the tool part
        // hasn't observed the transition yet. Render a tiny placeholder
        // instead of a stale interactive card that could double-submit.
        const placeholder = document.createElement("div")
        placeholder.className = "question-card answered"
        const header = document.createElement("div")
        header.className = "question-header"
        header.textContent = "Question (loading…)"
        placeholder.appendChild(header)
        return placeholder
      }
      // completed or error → clear any lingering draft (user can't edit
      // a settled question) and render the read-only card.
      clearQuestionDraft(tp.callID)
      const card = renderAnsweredQuestionCard(tp)
      if (card) return card
    }
    return renderToolPart(tp)
  }
  if (part.type === "file") {
    const fp = part as { mime?: string; url?: string; filename?: string }
    const mime = fp.mime ?? ""
    const wrap = document.createElement("div")
    wrap.className = "attached-file"
    if (mime.startsWith("image/") && fp.url) {
      const img = document.createElement("img")
      img.src = fp.url
      img.alt = fp.filename ?? "image"
      img.className = "attached-image"
      img.title = "Click to enlarge"
      img.addEventListener("click", () => openLightbox(fp.url as string, fp.filename))
      wrap.appendChild(img)
    } else {
      const badge = document.createElement("span")
      badge.className = "attachment-icon"
      badge.textContent = mime === "application/pdf" ? "PDF" : "FILE"
      wrap.appendChild(badge)
      const name = document.createElement("span")
      name.className = "attachment-name"
      name.textContent = fp.filename ?? mime ?? "file"
      wrap.appendChild(name)
    }
    return wrap
  }
  if (part.type === "step-start" || part.type === "step-finish") return null
  // `patch` parts are snapshot metadata emitted by the server after every
  // edit/write/apply_patch (session/processor.ts). They carry a `hash`
  // (rollback snapshot id) and `files: string[]` (touched paths). We used
  // to render them as a `✎ patch patch` card, which was pure noise:
  //   • the edit tool card right above already tells the user which file
  //     was touched and offers Open / Diff buttons;
  //   • the snapshot hash is only useful to the server's own rollback
  //     machinery, not to the user reading the conversation.
  // Drop the part silently — no visual, no downstream layout impact.
  if (part.type === "patch") return null
  return null
}

// Read-only render of a settled (completed / error) `question` tool
// call. Mirrors the DOM that questions.ts produces for a pending ask
// (`.question-card` etc.) so past questions look visually identical
// to live ones, just read-only:
//   • radios / checkboxes are `disabled` and pre-checked to reflect
//     what the user actually submitted (state.metadata.answers);
//   • the custom-answer input is replaced by a disabled text row when
//     the user typed a free-text answer, otherwise omitted;
//   • Dismiss / Submit buttons are dropped — nothing to do on a
//     settled ask;
//   • header reads "Answered" (or "Dismissed" on error) instead of
//     the "opencode needs your input" prompt.
// Interactive rendering for a still-running call is handled by
// buildQuestionCard in questions.ts. This function returns null on a
// running part and on parts without a `questions` input; callers fall
// back to a placeholder or the generic tool card respectively.
function renderAnsweredQuestionCard(part: ToolPart): HTMLElement | null {
  const status = part.state.status
  if (status !== "completed" && status !== "error") return null

  const input = part.state.input as Record<string, unknown>
  const rawQs = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQs) || rawQs.length === 0) return null
  const questions = rawQs as Array<{
    question?: string
    header?: string
    options?: Array<{ label?: string; description?: string }>
    multiple?: boolean
    custom?: boolean
  }>

  // Answers land on the completed part's metadata (see
  // packages/opencode/src/tool/question.ts). On error the array is
  // absent — the card still shows what was asked as a record.
  const meta = (part.state as { metadata?: unknown }).metadata as
    | { answers?: unknown }
    | undefined
  const answers: string[][] = Array.isArray(meta?.answers)
    ? (meta!.answers as unknown[]).map((a) => (Array.isArray(a) ? (a as unknown[]).map(String) : []))
    : []

  const card = document.createElement("div")
  card.className = "question-card answered"
  card.dataset.partId = part.id

  const header = document.createElement("div")
  header.className = "question-header"
  header.textContent =
    status === "error"
      ? "Question dismissed"
      : questions.length === 1
        ? "Question · Answered"
        : `Questions (${questions.length}) · Answered`
  card.appendChild(header)

  // Reuse a stable per-part id prefix for input `name` attributes so
  // radios in the same group behave correctly if the browser cares
  // (they're disabled, but still worth grouping cleanly).
  const gid = part.id

  questions.forEach((q, qi) => {
    const block = document.createElement("div")
    block.className = "question-block"

    if (questions.length > 1) {
      const label = document.createElement("div")
      label.className = "question-index"
      label.textContent = `Q${qi + 1}${q.header ? " · " + q.header : ""}`
      block.appendChild(label)
    }

    if (q.question) {
      const qtext = document.createElement("div")
      qtext.className = "question-text"
      qtext.textContent = q.question
      block.appendChild(qtext)
    }

    const picked = new Set(answers[qi] ?? [])
    const optionLabels = new Set(
      (q.options ?? []).map((o) => (typeof o?.label === "string" ? o.label : "")),
    )
    // Anything in the answer array that isn't a known option label came
    // from the free-text custom input on the ask card.
    const customs = (answers[qi] ?? []).filter((a) => !optionLabels.has(a))

    if (q.options && q.options.length > 0) {
      const opts = document.createElement("div")
      opts.className = "question-options"
      for (const opt of q.options) {
        const label = typeof opt?.label === "string" ? opt.label : ""
        if (!label) continue
        const row = document.createElement("label")
        row.className = "question-option"
        if (picked.has(label)) row.classList.add("picked")
        const inputEl = document.createElement("input")
        inputEl.type = q.multiple ? "checkbox" : "radio"
        inputEl.name = `q_${gid}_${qi}`
        inputEl.value = label
        inputEl.disabled = true
        inputEl.checked = picked.has(label)
        const text = document.createElement("span")
        text.className = "question-option-text"
        const strong = document.createElement("strong")
        strong.textContent = label
        text.appendChild(strong)
        if (opt.description) {
          const desc = document.createElement("span")
          desc.className = "question-option-desc"
          desc.textContent = " — " + opt.description
          text.appendChild(desc)
        }
        row.appendChild(inputEl)
        row.appendChild(text)
        opts.appendChild(row)
      }
      block.appendChild(opts)
    }

    // Free-text answers: render each as a disabled text input styled the
    // same as the ask card's custom field, so the visual language matches.
    for (const custom of customs) {
      const customEl = document.createElement("input")
      customEl.type = "text"
      customEl.className = "question-custom"
      customEl.value = custom
      customEl.disabled = true
      block.appendChild(customEl)
    }

    // "(Unanswered)" hint when the tool settled but nothing was picked
    // and no custom text was entered — usually means the user dismissed.
    if ((answers[qi] ?? []).length === 0) {
      const empty = document.createElement("div")
      empty.className = "question-empty"
      empty.textContent = "(Unanswered)"
      block.appendChild(empty)
    }

    card.appendChild(block)
  })

  return card
}

function renderToolPart(part: ToolPart): HTMLElement {
  const div = document.createElement("div")
  div.className = "tool"
  div.dataset.partId = part.id

  const status = part.state.status
  const target = toolTarget(part)

  // Header layout: icon · name · target · [actions | status]
  //
  // The tool card used to show a plain `done`/`failed`/`running` badge in the
  // trailing slot. That's fine as a signal but wastes the most valuable pixel
  // real estate for the two things users actually want to do on a finished
  // tool call: copy the command (bash/shell) or jump to the file / see the
  // diff (edit/write/apply_patch).
  //
  // We now render inline action buttons in that slot when the tool has
  // completed successfully, and fall back to the textual status badge in
  // every other state (running, error, pending) — those still need the
  // badge because there's no useful action yet.
  const header = document.createElement("div")
  header.className = "tool-header"
  const iconSpan = renderToolIconElement(part)
  header.appendChild(iconSpan)
  const nameSpan = document.createElement("span")
  nameSpan.className = "tool-name"
  nameSpan.textContent = part.tool
  header.appendChild(nameSpan)
  const targetSpan = document.createElement("span")
  targetSpan.className = "tool-target"
  targetSpan.textContent = target
  targetSpan.title = target
  header.appendChild(targetSpan)

  const trailing = document.createElement("span")
  trailing.className = "tool-trailing"
  if (status === "completed") {
    const actions = renderToolHeaderActions(part)
    if (actions) trailing.appendChild(actions)
    // Even when we render actions, keep a subtle "done" pill so users still
    // get the visual completion signal — but pushed into the actions row so
    // the buttons stay dominant. Uncomment if reviewers ask for it back;
    // Codebuddy's UI omits it, so we do too.
  } else {
    const statusText =
      status === "running" ? "running" : status === "error" ? "failed" : "pending"
    const statusEl = document.createElement("span")
    statusEl.className = `tool-status ${status}`
    statusEl.textContent = statusText
    trailing.appendChild(statusEl)
  }
  header.appendChild(trailing)

  const body = document.createElement("div")
  body.className = "tool-body collapsed"
  fillToolBody(body, part)

  header.addEventListener("click", () => body.classList.toggle("collapsed"))
  // Auto-expand while running or on error.
  if (status === "running" || status === "error") body.classList.remove("collapsed")

  div.appendChild(header)
  div.appendChild(body)
  return div
}

// Build the inline action buttons for a completed tool call.
// Returns undefined when the tool has no meaningful header action (in which
// case renderToolPart falls back to omitting the trailing slot).
//
// bash/shell           → Copy command
// edit/write/apply_patch → Open file · Diff
// read                 → Open file
// glob/grep            → (nothing — no single obvious action; the body
//                        already shows the matches and users expand for it)
function renderToolHeaderActions(part: ToolPart): HTMLElement | undefined {
  const input = part.state.input as Record<string, unknown>
  const filePath = pickPath(input)
  const actions = document.createElement("span")
  actions.className = "tool-actions"

  if (part.tool === "bash" || part.tool === "shell") {
    const command = typeof input.command === "string" ? input.command : ""
    // bash gets a hover-only icon rather than a persistent button — copying
    // the command is a nice-to-have, but the card is already busy and the
    // button label repeated on every shell call was distracting. The icon
    // fades in on tool hover (see .tool-action-icon in styles.css) and
    // fades out when the pointer leaves.
    if (command) actions.appendChild(makeCopyActionIcon("Copy command", command))
  } else if (part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch") {
    if (filePath) {
      actions.appendChild(
        makeToolActionButton("Open", "Open file in editor", () => postMessage({ type: "openFile", path: filePath })),
      )
      actions.appendChild(
        makeToolActionButton("Diff", "Show diff", () =>
          showDiffForEdit(filePath, input, part.state as { metadata: Record<string, unknown> }),
        ),
      )
    }
  } else if (part.tool === "read") {
    if (filePath) {
      actions.appendChild(
        makeToolActionButton("Open", "Open file in editor", () => postMessage({ type: "openFile", path: filePath })),
      )
    }
  }

  return actions.childElementCount > 0 ? actions : undefined
}

function pickPath(input: Record<string, unknown>): string | undefined {
  for (const k of ["filePath", "path", "file"] as const) {
    const v = input[k]
    if (typeof v === "string" && v) return v
  }
  return undefined
}

// A tiny inline button used in the tool header. Consistent look with
// .diff-btn but bound to a distinct class so we can hover-fade the whole
// group without disturbing standalone buttons in the body. The click
// handler receives the button element so callers that want to flash a
// success/failure state (e.g. the Copy action) can update it in place.
// stopPropagation is applied unconditionally so hitting a button never
// also toggles the card's expand/collapse.
function makeToolActionButton(
  label: string,
  tooltip: string,
  onClick: (btn: HTMLButtonElement) => void | Promise<void>,
): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.className = "tool-action-btn"
  btn.type = "button"
  btn.textContent = label
  btn.title = tooltip
  btn.setAttribute("aria-label", tooltip)
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation()
    void onClick(btn)
  })
  return btn
}

// Ghost-styled copy icon that only becomes visible when the pointer is over
// the parent .tool card (see .tool-action-icon in styles.css). Using an
// icon rather than a labelled button keeps the shell/bash header visually
// clean when the user is just skimming through a conversation, and only
// surfaces the copy affordance when they actually hover to interact.
//
// The icon glyph mirrors the .copy-btn used on the message meta row (⧉);
// keeping them identical means users only have to learn "the little copy
// glyph" once. On click the icon briefly switches to a checkmark / bang
// to confirm success or failure.
function makeCopyActionIcon(tooltip: string, text: string): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.className = "tool-action-icon"
  btn.type = "button"
  btn.textContent = "⧉"
  btn.title = tooltip
  btn.setAttribute("aria-label", tooltip)
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation()
    const ok = await copyToClipboard(text)
    const original = btn.textContent
    btn.textContent = ok ? "✓" : "!"
    btn.classList.add(ok ? "copied" : "copy-failed")
    setTimeout(() => {
      btn.textContent = original
      btn.classList.remove("copied", "copy-failed")
    }, 1200)
  })
  return btn
}

// Build the leading icon element for a tool card. For file-oriented tools
// (read/edit/write/apply_patch) we render a small monospaced badge derived
// from the file extension so users can tell at a glance whether the model
// touched a TypeScript file, a markdown doc, a JSON config, etc. — much
// more informative than a single ✎ glyph reused across every write. Falls
// back to the plain emoji icon whenever the tool isn't file-scoped or we
// can't extract a usable extension (e.g. an edit against a file with no
// suffix).
function renderToolIconElement(part: ToolPart): HTMLElement {
  const span = document.createElement("span")
  span.className = "tool-icon"

  if (isFileTool(part.tool)) {
    const input = part.state.input as Record<string, unknown>
    const filePath = pickPath(input)
    const info = filePath ? fileTypeInfo(filePath) : undefined
    if (info) {
      span.classList.add("tool-icon-filetype", `tool-icon-filetype-${info.className}`)
      span.textContent = info.label
      span.title = `${part.tool} · ${info.tooltip}`
      return span
    }
  }

  span.textContent = toolIconGlyph(part.tool)
  return span
}

function isFileTool(tool: string): boolean {
  return tool === "read" || tool === "write" || tool === "edit" || tool === "apply_patch"
}

// Fallback emoji glyphs for tools that either aren't file-scoped or have
// no discoverable file path in their input (rare — usually a bug in the
// caller). Kept as a lookup so renderToolIconElement can short-circuit
// back to the old behaviour without a per-tool branch.
function toolIconGlyph(tool: string): string {
  switch (tool) {
    case "read":
      return "📖"
    case "write":
    case "edit":
    case "apply_patch":
      return "✎"
    case "shell":
    case "bash":
      return "$"
    case "glob":
    case "grep":
      return "🔍"
    case "task":
      return "🧵"
    default:
      return "⚙"
  }
}

// Map a file path to a compact badge label + accent colour class. The
// label is intentionally short (2-4 chars) so it fits in the same 14px
// slot the old emoji occupied without pushing the tool name around. The
// palette keys off .tool-icon-filetype-<key> in styles.css — add both
// the entry here and a colour rule there when supporting a new extension.
//
// "Family" grouping (ts + tsx share one accent, js + jsx share one, etc.)
// keeps related file types visually related; users care that a change
// happened to "some JS-ish file" more than about the exact suffix.
function fileTypeInfo(filePath: string): { label: string; className: string; tooltip: string } | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  // Special-case dotfiles / config files with well-known bare names before
  // falling through to extension matching (e.g. "Dockerfile", "Makefile",
  // ".gitignore"). Recognisable at a glance and worth their own badge.
  const specials: Record<string, { label: string; className: string; tooltip: string }> = {
    Dockerfile: { label: "DOC", className: "docker", tooltip: "Dockerfile" },
    Makefile: { label: "MK", className: "make", tooltip: "Makefile" },
    ".gitignore": { label: "GIT", className: "git", tooltip: ".gitignore" },
    ".env": { label: "ENV", className: "env", tooltip: ".env file" },
    "package.json": { label: "NPM", className: "npm", tooltip: "npm package.json" },
    "tsconfig.json": { label: "TSC", className: "ts", tooltip: "TypeScript config" },
  }
  if (specials[base]) return specials[base]

  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return undefined
  const ext = base.slice(dot + 1).toLowerCase()

  const table: Record<string, { label: string; className: string; tooltip: string }> = {
    ts: { label: "TS", className: "ts", tooltip: "TypeScript" },
    tsx: { label: "TSX", className: "ts", tooltip: "TypeScript React" },
    mts: { label: "TS", className: "ts", tooltip: "TypeScript module" },
    cts: { label: "TS", className: "ts", tooltip: "TypeScript CommonJS" },
    js: { label: "JS", className: "js", tooltip: "JavaScript" },
    jsx: { label: "JSX", className: "js", tooltip: "JavaScript React" },
    mjs: { label: "JS", className: "js", tooltip: "JavaScript module" },
    cjs: { label: "JS", className: "js", tooltip: "JavaScript CommonJS" },
    py: { label: "PY", className: "py", tooltip: "Python" },
    rb: { label: "RB", className: "rb", tooltip: "Ruby" },
    go: { label: "GO", className: "go", tooltip: "Go" },
    rs: { label: "RS", className: "rs", tooltip: "Rust" },
    java: { label: "JV", className: "java", tooltip: "Java" },
    kt: { label: "KT", className: "kotlin", tooltip: "Kotlin" },
    swift: { label: "SW", className: "swift", tooltip: "Swift" },
    c: { label: "C", className: "c", tooltip: "C" },
    h: { label: "H", className: "c", tooltip: "C header" },
    cpp: { label: "C++", className: "cpp", tooltip: "C++" },
    cc: { label: "C++", className: "cpp", tooltip: "C++" },
    hpp: { label: "H++", className: "cpp", tooltip: "C++ header" },
    cs: { label: "C#", className: "csharp", tooltip: "C#" },
    php: { label: "PHP", className: "php", tooltip: "PHP" },
    md: { label: "MD", className: "md", tooltip: "Markdown" },
    mdx: { label: "MDX", className: "md", tooltip: "MDX" },
    markdown: { label: "MD", className: "md", tooltip: "Markdown" },
    json: { label: "{}", className: "json", tooltip: "JSON" },
    jsonc: { label: "{}", className: "json", tooltip: "JSON with comments" },
    json5: { label: "{}", className: "json", tooltip: "JSON5" },
    yml: { label: "YML", className: "yaml", tooltip: "YAML" },
    yaml: { label: "YML", className: "yaml", tooltip: "YAML" },
    toml: { label: "TOM", className: "toml", tooltip: "TOML" },
    xml: { label: "XML", className: "xml", tooltip: "XML" },
    html: { label: "<>", className: "html", tooltip: "HTML" },
    htm: { label: "<>", className: "html", tooltip: "HTML" },
    css: { label: "CSS", className: "css", tooltip: "CSS" },
    scss: { label: "SCS", className: "css", tooltip: "Sass (SCSS)" },
    sass: { label: "SAS", className: "css", tooltip: "Sass" },
    less: { label: "LES", className: "css", tooltip: "Less" },
    vue: { label: "VUE", className: "vue", tooltip: "Vue" },
    svelte: { label: "SVL", className: "svelte", tooltip: "Svelte" },
    sh: { label: "SH", className: "sh", tooltip: "Shell script" },
    bash: { label: "SH", className: "sh", tooltip: "Bash script" },
    zsh: { label: "SH", className: "sh", tooltip: "Zsh script" },
    fish: { label: "SH", className: "sh", tooltip: "Fish script" },
    ps1: { label: "PS1", className: "sh", tooltip: "PowerShell" },
    sql: { label: "SQL", className: "sql", tooltip: "SQL" },
    graphql: { label: "GQL", className: "gql", tooltip: "GraphQL" },
    gql: { label: "GQL", className: "gql", tooltip: "GraphQL" },
    proto: { label: "PB", className: "proto", tooltip: "Protocol Buffers" },
    dockerfile: { label: "DOC", className: "docker", tooltip: "Dockerfile" },
    lock: { label: "LCK", className: "lock", tooltip: "Lockfile" },
    txt: { label: "TXT", className: "txt", tooltip: "Plain text" },
    log: { label: "LOG", className: "txt", tooltip: "Log file" },
    csv: { label: "CSV", className: "csv", tooltip: "CSV" },
    tsv: { label: "TSV", className: "csv", tooltip: "TSV" },
    png: { label: "IMG", className: "image", tooltip: "PNG image" },
    jpg: { label: "IMG", className: "image", tooltip: "JPEG image" },
    jpeg: { label: "IMG", className: "image", tooltip: "JPEG image" },
    gif: { label: "IMG", className: "image", tooltip: "GIF image" },
    webp: { label: "IMG", className: "image", tooltip: "WebP image" },
    svg: { label: "SVG", className: "image", tooltip: "SVG image" },
    pdf: { label: "PDF", className: "pdf", tooltip: "PDF" },
    zip: { label: "ZIP", className: "archive", tooltip: "Zip archive" },
    tar: { label: "TAR", className: "archive", tooltip: "Tar archive" },
    gz: { label: "GZ", className: "archive", tooltip: "Gzip archive" },
  }
  if (table[ext]) return table[ext]

  // Fallback: use the upper-cased extension itself (max 3 chars) so exotic
  // suffixes still get a badge rather than the generic ✎ icon.
  const label = ext.toUpperCase().slice(0, 3)
  return { label, className: "generic", tooltip: `.${ext}` }
}

function toolTarget(part: ToolPart): string {
  const input = part.state.input as Record<string, unknown>
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined)
  // Prefer workspace-relative paths in the header — absolute paths are noisy
  // and hide the useful suffix behind the ellipsis when the workspace root
  // is deeply nested. `relativizeToWorkspace` returns the input unchanged if
  // it doesn't sit under state.directory (e.g. a system path the model read
  // for reference, or when directory isn't known yet), which keeps behaviour
  // safe.
  const filePath = pick("filePath") ?? pick("path") ?? pick("file")
  if (filePath) return relativizeToWorkspace(filePath)
  return pick("command") ?? pick("pattern") ?? pick("query") ?? pick("description") ?? ""
}

// Turn `/data/share/AgentRag/opencode/packages/…/foo.ts` into
// `opencode/packages/…/foo.ts` when the state.directory prefix matches.
// Falls back to the original path unchanged when:
//   • state.directory hasn't been set yet (very early bootstrap render)
//   • the path is already relative
//   • the path lives outside the workspace (system dirs, home config, etc.)
// The tool contract is "just make it shorter when we safely can" — never
// silently invent a path that would open the wrong file.
function relativizeToWorkspace(p: string): string {
  const dir = state.directory
  if (!dir) return p
  if (!p.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(p)) return p // already relative
  // Normalise trailing slash on dir so `/foo` + `/foo/bar` matches cleanly.
  const prefix = dir.endsWith("/") ? dir : dir + "/"
  if (p === dir) return "."
  if (p.startsWith(prefix)) return p.slice(prefix.length) || "."
  return p
}

function fillToolBody(body: HTMLElement, part: ToolPart) {
  body.innerHTML = ""
  const input = part.state.input as Record<string, unknown>
  const filePath =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.file === "string" && input.file) ||
    ""

  // Header keys/values summary
  const keys = Object.keys(input).filter((k) => k !== "filePath" && k !== "path" && k !== "file")
  if (keys.length > 0) {
    for (const k of keys) {
      const v = input[k]
      const line = document.createElement("div")
      line.className = "kv"
      line.textContent = `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
      body.appendChild(line)
    }
  }

  if (filePath) {
    const link = document.createElement("span")
    link.className = "path-link"
    // Show the relativized form for readability; keep the absolute path in
    // the tooltip so users can still see the full location on hover and
    // click still targets the absolute path (workspace-relative doesn't
    // resolve reliably in vscode.workspace.openTextDocument).
    link.textContent = relativizeToWorkspace(filePath)
    link.title = filePath
    link.addEventListener("click", () => postMessage({ type: "openFile", path: filePath }))
    body.appendChild(link)
  }

  if (part.state.status === "completed") {
    const output = (part.state as { output: string }).output ?? ""
    if (output) {
      const pre = document.createElement("pre")
      pre.textContent = output
      pre.style.whiteSpace = "pre-wrap"
      pre.style.margin = "6px 0 0 0"
      body.appendChild(pre)
    }
    // Note: the Diff button used to live here in the body; it's now surfaced
    // inline in the tool header via renderToolHeaderActions so users don't
    // have to expand the card first. See renderToolPart above.
  }
  if (part.state.status === "error") {
    const pre = document.createElement("pre")
    pre.textContent = (part.state as { error: string }).error
    pre.style.color = "var(--vscode-errorForeground)"
    pre.style.whiteSpace = "pre-wrap"
    pre.style.margin = "6px 0 0 0"
    body.appendChild(pre)
  }
}

function showDiffForEdit(filePath: string, input: Record<string, unknown>, partState: { metadata: Record<string, unknown> }) {
  // The `edit` tool stores oldString/newString in input, plus final content in
  // state.metadata.contents when available. `write` stores full content in
  // input.content and old contents in metadata.previousContent.
  let original = ""
  let modified = ""
  if (typeof input.oldString === "string") original = input.oldString
  if (typeof input.newString === "string") modified = input.newString
  const meta = partState.metadata ?? {}
  if (typeof meta.previousContent === "string") original = meta.previousContent
  if (typeof meta.contents === "string") modified = meta.contents
  if (!original && typeof input.content === "string") modified = input.content
  postMessage({ type: "showDiff", path: filePath, original, modified, title: filePath })
}
