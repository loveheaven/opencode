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
// keeps question cards pinned to the bottom of the list, and `postMessage`
// forwards path/diff clicks to the extension host.

import { escapeHtml, renderMarkdown } from "./markdown"
import type { Message, MessageWithParts, Part, TokenUsage, ToolPart } from "./sdk"
import { refs, state, type MessageEntry } from "./shared"
import { openLightbox } from "./lightbox"

let renderQuestionsCb: () => void = () => {}
let postMessage: (msg: unknown) => void = () => {}

export function initMessagesView(deps: {
  renderQuestions: () => void
  postMessage: (msg: unknown) => void
}) {
  renderQuestionsCb = deps.renderQuestions
  postMessage = deps.postMessage
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
// The bubble is transient: it's appended directly to the DOM (not to
// state.messages), so a full renderAllMessages() will wipe it. Fine —
// once the user retries or moves on it should disappear anyway.
export function showSessionError(err: { name?: string; message?: string; data?: unknown }) {
  const wrap = document.createElement("div")
  wrap.className = "msg assistant session-error-msg"
  const bubble = document.createElement("div")
  bubble.className = "bubble prose"
  const detail =
    (err.message && err.message.trim()) ||
    (err.data ? JSON.stringify(err.data) : "") ||
    "The opencode server reported an error but did not include a message."
  const nameLabel = err.name || "Session error"
  const errEl = document.createElement("div")
  errEl.className = "tool"
  errEl.innerHTML =
    `<div class="tool-header"><span class="tool-icon">⚠</span>` +
    `<span class="tool-name">${escapeHtml(nameLabel)}</span>` +
    `<span class="tool-status error">error</span></div>` +
    `<div class="tool-body">${escapeHtml(detail)}</div>` +
    `<div class="tool-body" style="opacity:0.7;font-size:11px;margin-top:6px">` +
    `Check the model/provider settings (Providers tab) and the OpenCode Output panel for details.</div>`
  bubble.appendChild(errEl)
  wrap.appendChild(bubble)
  const wasAtBottom = isAtBottom()
  refs.messages.appendChild(wrap)
  if (wasAtBottom) scrollToBottom()
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
      // Keep question cards pinned to the bottom by inserting new messages
      // before the first pending question card, if any.
      const firstQuestion = refs.messages.querySelector(".question-card")
      if (firstQuestion) refs.messages.insertBefore(replacement, firstQuestion)
      else refs.messages.appendChild(replacement)
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
        const el = renderPart(part)
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
      const el = renderPart(part)
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
    const meaningfulError = !!(err && err.message && err.message.trim())
    if (err && (hasContent || meaningfulError)) {
      const detail = err.message?.trim() || (err.data ? JSON.stringify(err.data) : "(no details)")
      const errEl = document.createElement("div")
      errEl.className = "tool"
      errEl.innerHTML = `<div class="tool-header"><span class="tool-icon">⚠</span><span class="tool-name">${escapeHtml(err.name || "Error")}</span><span class="tool-status error">error</span></div><div class="tool-body">${escapeHtml(detail)}</div>`
      bubble.appendChild(errEl)
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

function renderPart(part: Part): HTMLElement | null {
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
    return renderToolPart(part as ToolPart)
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
  if (part.type === "patch") {
    const div = document.createElement("div")
    div.className = "tool"
    const filename =
      (part as { file?: string; path?: string }).file ?? (part as { path?: string }).path ?? "patch"
    div.innerHTML = `<div class="tool-header"><span class="tool-icon">✎</span><span class="tool-name">patch</span><span class="tool-target">${escapeHtml(filename)}</span></div>`
    return div
  }
  return null
}

function renderToolPart(part: ToolPart): HTMLElement {
  const div = document.createElement("div")
  div.className = "tool"
  div.dataset.partId = part.id

  const status = part.state.status
  const statusText =
    status === "running" ? "running" : status === "completed" ? "done" : status === "error" ? "failed" : "pending"
  const target = toolTarget(part)

  const header = document.createElement("div")
  header.className = "tool-header"
  header.innerHTML = `
    <span class="tool-icon">${toolIcon(part.tool)}</span>
    <span class="tool-name">${escapeHtml(part.tool)}</span>
    <span class="tool-target">${escapeHtml(target)}</span>
    <span class="tool-status ${status}">${statusText}</span>
  `
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

function toolIcon(tool: string): string {
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

function toolTarget(part: ToolPart): string {
  const input = part.state.input as Record<string, unknown>
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined)
  return (
    pick("filePath") ??
    pick("path") ??
    pick("file") ??
    pick("command") ??
    pick("pattern") ??
    pick("query") ??
    pick("description") ??
    ""
  )
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
    link.textContent = filePath
    link.title = "Open in editor"
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
    // Show diff button for edit/write
    if (filePath && (part.tool === "edit" || part.tool === "write")) {
      const btn = document.createElement("button")
      btn.className = "diff-btn"
      btn.textContent = "View diff"
      btn.addEventListener("click", () => showDiffForEdit(filePath, input, part.state as { metadata: Record<string, unknown> }))
      body.appendChild(btn)
    }
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
