// Inline question cards (opencode `question` tool).
//
// Plan-B rendering: pending questions live INSIDE the assistant bubble
// (on the tool part itself), not as a floating card at the bottom of the
// messages list. That means:
//   • This module still owns SSE event handling, the pendingQuestions
//     Map, and the HTTP submit/reject calls.
//   • `renderQuestions()` no longer appends anything to the DOM — it
//     just kicks the messages view to rerender any assistant bubble
//     whose `question` tool part has a matching pending request.
//   • The actual card DOM is built by `buildQuestionCard(req)` and
//     called from messages-view.ts when it encounters a running
//     `question` tool part. Completed / errored calls go through the
//     read-only `renderAnsweredQuestionCard` in messages-view.ts.
//
// In-flight user selections (option picks + custom text) are memoised
// in `questionDrafts` keyed by callID so that a mid-stream re-render
// (e.g. more assistant text arriving after the question was posed)
// doesn't wipe what the user already ticked.

import type { QuestionRequest } from "./sdk"
import { getClient, refs, setStatus, state } from "./shared"

// messages-view owns the scroll heuristic and the "rerender assistant
// bubble N" hook. Both are injected so this module stays free of a
// direct import cycle with messages-view.
let scrollToBottom: () => void = () => {}
let rerenderMessage: (messageID: string) => void = () => {}
export function initQuestions(deps: {
  scrollToBottom: () => void
  rerenderMessage?: (messageID: string) => void
}) {
  scrollToBottom = deps.scrollToBottom
  if (deps.rerenderMessage) rerenderMessage = deps.rerenderMessage
}

// Draft state for a running question card. Held outside the DOM so a
// re-render of the assistant bubble (triggered by a later text delta,
// a later tool part, etc.) can restore what the user has already picked
// or typed. Keyed by callID because that value is stable across
// renders for the same tool call.
type Draft = {
  selected: Set<string>[]
  custom: string[]
}
const questionDrafts = new Map<string, Draft>()

export function getQuestionDraft(callID: string): Draft | undefined {
  return questionDrafts.get(callID)
}

// Called when the tool call transitions away from `running` (completed
// or errored) so we don't leak drafts across replies.
export function clearQuestionDraft(callID: string) {
  questionDrafts.delete(callID)
}

// Called by events.ts on `question.asked` / `question.replied` /
// `question.rejected`. Reruns the matching assistant bubble's render
// so the tool part swaps between "pending interactive" / "answered
// read-only" / "dismissed read-only" without any special-case DOM
// splicing.
export function renderQuestions() {
  // Ask messages-view to redraw every assistant message that owns a
  // pending question. `req.tool` is set by tool/question.ts whenever
  // the ask comes from a tool call, which is the only case we care
  // about — direct API askers (rare) have no bubble to update.
  const affected = new Set<string>()
  for (const req of state.pendingQuestions.values()) {
    if (req.tool?.messageID) affected.add(req.tool.messageID)
  }
  for (const id of affected) rerenderMessage(id)
  if (state.pendingQuestions.size > 0) scrollToBottom()

  // Legacy cleanup: earlier versions rendered pending cards as direct
  // children of refs.messages. If any such stragglers survive (e.g. a
  // reload happened mid-stream) sweep them so we don't show two cards.
  for (const el of Array.from(refs.messages.querySelectorAll(":scope > .question-card:not(.answered)"))) {
    el.remove()
  }
}

// Build the interactive card for a running question. Called from
// messages-view.ts when it renders a `tool: "question"` part whose
// state.status is "running" and finds a matching pending request.
//
// Returns an element that:
//   • shows the same question / options / custom input layout as the
//     old floating card;
//   • persists partially-filled selections into `questionDrafts` so
//     an incremental re-render doesn't lose them;
//   • posts to /question/:id/reply on Submit and to /question/:id/reject
//     on Dismiss, then clears the draft.
export function buildQuestionCard(req: QuestionRequest): HTMLElement {
  const card = document.createElement("div")
  card.className = "question-card"
  card.dataset.questionId = req.id
  if (req.tool?.callID) card.dataset.callId = req.tool.callID

  const header = document.createElement("div")
  header.className = "question-header"
  header.textContent = req.questions.length === 1
    ? "opencode needs your input"
    : `opencode needs your input (${req.questions.length} questions)`
  card.appendChild(header)

  // Restore or initialise the draft for this callID (or by req.id if
  // no tool binding — the ask API path).
  const draftKey = req.tool?.callID ?? req.id
  const existing = questionDrafts.get(draftKey)
  const draft: Draft = existing ?? {
    selected: req.questions.map(() => new Set<string>()),
    custom: req.questions.map(() => ""),
  }
  if (!existing) questionDrafts.set(draftKey, draft)

  req.questions.forEach((q, qi) => {
    const multiple = q.multiple === true
    // Schema default: custom is true unless explicitly disabled.
    const allowCustom = q.custom !== false

    const block = document.createElement("div")
    block.className = "question-block"

    if (req.questions.length > 1) {
      const label = document.createElement("div")
      label.className = "question-index"
      label.textContent = `Q${qi + 1}${q.header ? " · " + q.header : ""}`
      block.appendChild(label)
    }

    const qtext = document.createElement("div")
    qtext.className = "question-text"
    qtext.textContent = q.question
    block.appendChild(qtext)

    if (q.options && q.options.length > 0) {
      const opts = document.createElement("div")
      opts.className = "question-options"
      q.options.forEach((opt, oi) => {
        const row = document.createElement("label")
        row.className = "question-option"
        const input = document.createElement("input")
        input.type = multiple ? "checkbox" : "radio"
        input.name = `q_${draftKey}_${qi}`
        input.value = opt.label
        input.checked = draft.selected[qi].has(opt.label)
        input.addEventListener("change", () => {
          if (multiple) {
            if (input.checked) draft.selected[qi].add(opt.label)
            else draft.selected[qi].delete(opt.label)
          } else {
            draft.selected[qi].clear()
            if (input.checked) draft.selected[qi].add(opt.label)
          }
        })
        const text = document.createElement("span")
        text.className = "question-option-text"
        const strong = document.createElement("strong")
        strong.textContent = opt.label
        text.appendChild(strong)
        if (opt.description) {
          const desc = document.createElement("span")
          desc.className = "question-option-desc"
          desc.textContent = " — " + opt.description
          text.appendChild(desc)
        }
        row.appendChild(input)
        row.appendChild(text)
        opts.appendChild(row)
        // Focus the first radio in the first question for keyboard flow —
        // but only on the very first render (i.e. before any draft
        // exists), otherwise refocusing on every incremental rerender
        // steals the user's caret from wherever they typed.
        if (!existing && qi === 0 && oi === 0 && !multiple) setTimeout(() => input.focus(), 0)
      })
      block.appendChild(opts)
    }

    if (allowCustom) {
      const custom = document.createElement("input")
      custom.type = "text"
      custom.className = "question-custom"
      custom.placeholder = q.options.length > 0 ? "Or type your own answer…" : "Type your answer…"
      custom.value = draft.custom[qi]
      custom.addEventListener("input", () => {
        draft.custom[qi] = custom.value
      })
      // Enter in the custom field submits.
      custom.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault()
          void submit()
        }
      })
      block.appendChild(custom)
    }

    card.appendChild(block)
  })

  const actions = document.createElement("div")
  actions.className = "question-actions"
  const dismissBtn = document.createElement("button")
  dismissBtn.className = "question-btn secondary"
  dismissBtn.textContent = "Dismiss"
  dismissBtn.title = "Reject: model gets no answer and its turn ends"
  dismissBtn.addEventListener("click", () => void reject())
  const submitBtn = document.createElement("button")
  submitBtn.className = "question-btn primary"
  submitBtn.textContent = "Submit"
  submitBtn.addEventListener("click", () => void submit())
  actions.appendChild(dismissBtn)
  actions.appendChild(submitBtn)
  card.appendChild(actions)

  const buildAnswers = (): string[][] =>
    draft.selected.map((sel, i) => {
      const answers = Array.from(sel)
      const trimmed = draft.custom[i].trim()
      if (trimmed) answers.push(trimmed)
      return answers
    })

  const submit = async () => {
    const client = getClient()
    if (!client) return
    const answers = buildAnswers()
    if (answers.every((a) => a.length === 0)) {
      setStatus("Answer at least one question or click Dismiss.")
      return
    }
    submitBtn.disabled = true
    dismissBtn.disabled = true
    try {
      await client.replyQuestion(req.id, answers)
      questionDrafts.delete(draftKey)
      state.pendingQuestions.delete(req.id)
      renderQuestions()
    } catch (err) {
      submitBtn.disabled = false
      dismissBtn.disabled = false
      setStatus(`Reply failed: ${(err as Error).message}`)
    }
  }

  const reject = async () => {
    const client = getClient()
    if (!client) return
    submitBtn.disabled = true
    dismissBtn.disabled = true
    try {
      await client.rejectQuestion(req.id)
      questionDrafts.delete(draftKey)
      state.pendingQuestions.delete(req.id)
      renderQuestions()
    } catch (err) {
      submitBtn.disabled = false
      dismissBtn.disabled = false
      setStatus(`Dismiss failed: ${(err as Error).message}`)
    }
  }

  return card
}

// Find the pending request that corresponds to a given tool part on an
// assistant message. Matching is done via
// `tool: { messageID, callID }` which the server fills in whenever a
// question is asked through the `question` tool (see
// packages/opencode/src/tool/question.ts:27).
export function findPendingQuestionForTool(messageID: string, callID: string): QuestionRequest | undefined {
  for (const req of state.pendingQuestions.values()) {
    if (req.tool?.messageID === messageID && req.tool.callID === callID) return req
  }
  return undefined
}
