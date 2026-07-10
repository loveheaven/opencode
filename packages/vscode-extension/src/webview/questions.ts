// Inline question cards (opencode `question` tool).
//
// The `question` tool pauses the model until the user answers via
// POST /question/:id/reply. We render pending asks as a card pinned to the
// bottom of the message list. State is keyed by request id; a single ask
// may contain multiple sub-questions, each with options + optional custom
// answer.

import type { QuestionRequest } from "./sdk"
import { getClient, refs, setStatus, state } from "./shared"

// messages-view owns the scroll-to-bottom heuristic; we call it after
// appending a card so the user's eyes land on the fresh prompt.
let scrollToBottom: () => void = () => {}
export function initQuestions(deps: { scrollToBottom: () => void }) {
  scrollToBottom = deps.scrollToBottom
}

export function renderQuestions() {
  // Wipe any previously-rendered cards and re-render the current pending set.
  // The list is small (usually 0-1 asks) so full rerender is fine.
  for (const el of Array.from(refs.messages.querySelectorAll(".question-card"))) el.remove()
  for (const req of state.pendingQuestions.values()) {
    refs.messages.appendChild(renderQuestionCard(req))
  }
  // If a card was just added, scroll it into view — user needs to see it.
  if (state.pendingQuestions.size > 0) scrollToBottom()
}

function renderQuestionCard(req: QuestionRequest): HTMLElement {
  const card = document.createElement("div")
  card.className = "question-card"
  card.dataset.questionId = req.id

  const header = document.createElement("div")
  header.className = "question-header"
  header.textContent = req.questions.length === 1
    ? "opencode needs your input"
    : `opencode needs your input (${req.questions.length} questions)`
  card.appendChild(header)

  // Per-question local state: which options are selected + optional custom text.
  // Held in closures so the submit handler can read them without DOM diving.
  type QState = { selected: Set<string>; custom: string; multiple: boolean; allowCustom: boolean }
  const perQuestion: QState[] = []

  req.questions.forEach((q, qi) => {
    const qs: QState = {
      selected: new Set<string>(),
      custom: "",
      // Schema default: custom is true unless explicitly disabled.
      multiple: q.multiple === true,
      allowCustom: q.custom !== false,
    }
    perQuestion.push(qs)

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
        // Multi-select uses checkboxes; single-select uses radios grouped
        // per question so only one option ever stays picked.
        input.type = qs.multiple ? "checkbox" : "radio"
        input.name = `q_${req.id}_${qi}`
        input.value = opt.label
        input.addEventListener("change", () => {
          if (qs.multiple) {
            if (input.checked) qs.selected.add(opt.label)
            else qs.selected.delete(opt.label)
          } else {
            qs.selected.clear()
            if (input.checked) qs.selected.add(opt.label)
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
        // Focus the first radio in the first question for keyboard flow.
        if (qi === 0 && oi === 0 && !qs.multiple) setTimeout(() => input.focus(), 0)
      })
      block.appendChild(opts)
    }

    if (qs.allowCustom) {
      const custom = document.createElement("input")
      custom.type = "text"
      custom.className = "question-custom"
      custom.placeholder = q.options.length > 0 ? "Or type your own answer…" : "Type your answer…"
      custom.addEventListener("input", () => {
        qs.custom = custom.value
      })
      // Enter in the last custom field submits.
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

  // Build the answers[] payload the server expects: one string[] per question,
  // containing every picked label plus (if provided) the custom free-text
  // answer. Empty string means "no answer" for this question — the tool
  // reports it as "Unanswered" back to the model, which is fine.
  const buildAnswers = (): string[][] =>
    perQuestion.map((qs) => {
      const answers = Array.from(qs.selected)
      const trimmed = qs.custom.trim()
      if (trimmed) answers.push(trimmed)
      return answers
    })

  const submit = async () => {
    const client = getClient()
    if (!client) return
    const answers = buildAnswers()
    // Refuse to send a payload that answers nothing — server would accept it
    // but the model gets zero information, wasting a turn.
    if (answers.every((a) => a.length === 0)) {
      setStatus("Answer at least one question or click Dismiss.")
      return
    }
    submitBtn.disabled = true
    dismissBtn.disabled = true
    try {
      await client.replyQuestion(req.id, answers)
      // question.replied SSE clears the card; if it doesn't arrive within a
      // reasonable window (server bug / network hiccup), the local delete
      // below keeps the UI honest.
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
