// Slash command palette.
//
// Renders below the textarea when the user starts typing "/word" at the very
// start of the input. Filters the command list by prefix, supports ↑/↓ to
// select and Enter/Tab to complete. Esc closes it. Non-slash input or the
// caret leaving the leading token hides the palette automatically.
//
// Depends on the current command list (kept fresh by main.ts via
// `setSlashCommands`) and the textarea. It renders its own floating DOM
// element so the palette can escape the composer's layout.

import type { CommandInfo } from "./sdk"

let inputEl: HTMLTextAreaElement | null = null
let commands: readonly CommandInfo[] = []
let onSubmit: () => void = () => {}

let paletteEl: HTMLElement | null = null
let paletteIndex = 0
let paletteMatches: CommandInfo[] = []

/**
 * Wire the textarea + submit-on-Cmd-Enter callback. Called once from setup().
 * The palette's own listeners are attached here; main.ts still owns the
 * `blur` handler (it needs to defer palette hiding until after a click on
 * the palette row has a chance to fire).
 */
export function initSlashCommands(deps: {
  input: HTMLTextAreaElement
  onSubmit: () => void
}) {
  inputEl = deps.input
  onSubmit = deps.onSubmit
  deps.input.addEventListener("input", onInputChange)
  deps.input.addEventListener("keydown", onInputKeydown)
}

/** Called whenever bootstrap / refresh loads a fresh command list. */
export function setSlashCommands(list: readonly CommandInfo[]) {
  commands = list
}

/** Exposed so external code (sendPrompt, session switch, etc.) can hide. */
export function hideCommandPalette() {
  if (!paletteEl) return
  paletteEl.hidden = true
  paletteMatches = []
}

function currentSlashQuery(): string | null {
  if (!inputEl || commands.length === 0) return null
  // Only trigger when "/" is at position 0 and the caret is still inside the
  // leading token (no whitespace between "/" and caret).
  const value = inputEl.value
  if (!value.startsWith("/")) return null
  const caret = inputEl.selectionStart ?? value.length
  const firstSpace = value.search(/\s/)
  const tokenEnd = firstSpace === -1 ? value.length : firstSpace
  if (caret > tokenEnd) return null
  return value.slice(1, tokenEnd)
}

function onInputChange() {
  const query = currentSlashQuery()
  if (query === null) {
    hideCommandPalette()
    return
  }
  const q = query.toLowerCase()
  paletteMatches = commands.filter(
    (c) => c.name.toLowerCase().startsWith(q) || (c.description ?? "").toLowerCase().includes(q),
  )
  if (paletteMatches.length === 0) {
    hideCommandPalette()
    return
  }
  paletteIndex = 0
  renderCommandPalette()
}

function onInputKeydown(e: KeyboardEvent) {
  const paletteOpen = paletteEl && !paletteEl.hidden && paletteMatches.length > 0

  // Cmd/Ctrl+Enter always sends, palette open or not.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault()
    onSubmit()
    return
  }

  if (!paletteOpen) return

  if (e.key === "ArrowDown") {
    e.preventDefault()
    paletteIndex = (paletteIndex + 1) % paletteMatches.length
    renderCommandPalette()
    return
  }
  if (e.key === "ArrowUp") {
    e.preventDefault()
    paletteIndex = (paletteIndex - 1 + paletteMatches.length) % paletteMatches.length
    renderCommandPalette()
    return
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault()
    completeCommand(paletteMatches[paletteIndex])
    return
  }
  if (e.key === "Escape") {
    e.preventDefault()
    hideCommandPalette()
    return
  }
}

function completeCommand(cmd: CommandInfo) {
  if (!inputEl) return
  // Replace the leading /token with the picked command name, keep whatever the
  // user had typed after the space (their arguments), and put the caret at the
  // point where they'd naturally type args.
  const value = inputEl.value
  const firstSpace = value.search(/\s/)
  const rest = firstSpace === -1 ? "" : value.slice(firstSpace)
  const nextValue = `/${cmd.name}${rest || " "}`
  inputEl.value = nextValue
  const caret = cmd.name.length + 2 // skip "/name "
  inputEl.setSelectionRange(caret, caret)
  hideCommandPalette()
  inputEl.focus()
}

function ensureCommandPalette(): HTMLElement {
  if (paletteEl) return paletteEl
  const el = document.createElement("div")
  el.id = "command-palette"
  el.className = "command-palette"
  el.hidden = true
  document.body.appendChild(el)
  paletteEl = el
  return el
}

function renderCommandPalette() {
  if (!inputEl) return
  const el = ensureCommandPalette()
  el.innerHTML = ""
  for (let i = 0; i < paletteMatches.length; i++) {
    const cmd = paletteMatches[i]
    const row = document.createElement("div")
    row.className = "command-palette-row" + (i === paletteIndex ? " active" : "")
    const name = document.createElement("span")
    name.className = "command-palette-name"
    name.textContent = `/${cmd.name}`
    row.appendChild(name)
    if (cmd.description) {
      const desc = document.createElement("span")
      desc.className = "command-palette-desc"
      desc.textContent = cmd.description
      row.appendChild(desc)
    }
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault() // prevent input blur before click fires
      completeCommand(cmd)
    })
    el.appendChild(row)
  }
  // Position above the textarea.
  const rect = inputEl.getBoundingClientRect()
  Object.assign(el.style, {
    position: "fixed",
    left: `${rect.left}px`,
    bottom: `${window.innerHeight - rect.top + 4}px`,
    width: `${rect.width}px`,
  })
  el.hidden = false
}
