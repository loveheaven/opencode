// Agent + model pills in the composer.
//
// Two compact pill buttons at the bottom of the chat: current agent and
// current model. Clicking either opens a popup menu built from state.agents /
// state.providers. The popup is a small hand-rolled component; VSCode
// webviews don't ship any UI toolkit, and pulling one in is overkill for a
// menu.
//
// Persistence of the user's choice lives in main.ts (via the `persisted`
// helper); we call back into it through injected setters so this module
// doesn't need to know about VSCode webview state APIs.

import type { AgentInfo, ProviderInfo } from "./sdk"
import { openSettings } from "./settings"
import { refs, state } from "./shared"

type PersistedWriter = {
  setAgent: (dir: string, agent: string) => void
  setModel: (dir: string, model: string) => void
}

let persisted: PersistedWriter | null = null
let onRefreshProviders: () => void | Promise<void> = () => {}

export function initAgentModel(deps: {
  persisted: PersistedWriter
  onRefreshProviders: () => void | Promise<void>
}) {
  persisted = deps.persisted
  onRefreshProviders = deps.onRefreshProviders
}

export function renderAgentModel() {
  refs.agentModel.innerHTML = ""
  // Compact "icon + short name" pills. Full name goes in the tooltip so the
  // user can still verify at hover. Icons distinguish agent vs model at a
  // glance; before we prefixed with "agent:"/"model:" which ate 6+ chars of
  // horizontal room in the composer.
  const agentName = state.agent || "?"
  const agentBtn = pillButton(
    `${agentIcon(agentName)} ${agentName}`,
    `agent: ${agentName}`,
    () => showAgentMenu(agentBtn),
  )
  const modelBtn = pillButton(
    `${modelIcon(state.model)} ${state.model || "model"}`,
    `model: ${state.model || "(none)"}`,
    () => showModelMenu(modelBtn),
  )
  refs.agentModel.appendChild(agentBtn)
  refs.agentModel.appendChild(modelBtn)
}

/** Utility used at bootstrap to pick a default when no model was persisted. */
export function firstProviderModel(providers: ProviderInfo[]): string {
  for (const p of providers) {
    const models = p.models ? Object.values(p.models) : []
    if (models.length > 0) return `${p.id}/${models[0].id}`
  }
  return ""
}

// Pick a tiny glyph representing the agent. `build` is the default coding
// agent — most sessions live there — so a wrench works. Anything unknown
// falls back to a generic gear so the pill never renders naked.
function agentIcon(agent: string): string {
  switch (agent.toLowerCase()) {
    case "build":
      return "🔨"
    case "plan":
    case "planner":
      return "📋"
    case "review":
    case "reviewer":
      return "🔍"
    case "chat":
    case "general":
      return "💬"
    default:
      return "⚙"
  }
}

// Provider-aware icon so users can distinguish Claude / GPT / Gemini / etc.
// at a glance. `state.model` is "providerID/modelID"; we key off the
// providerID prefix so anything from the same family shares a glyph.
function modelIcon(model: string): string {
  const provider = model.split("/", 1)[0]?.toLowerCase() ?? ""
  if (provider.includes("anthropic") || provider.includes("claude")) return "✦"
  if (provider.includes("openai") || provider.includes("gpt")) return "◐"
  if (provider.includes("google") || provider.includes("gemini")) return "◈"
  if (provider.includes("deepseek")) return "▲"
  if (provider.includes("groq")) return "◆"
  if (provider.includes("mistral")) return "◉"
  return "✧"
}

function pillButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button")
  b.className = "pill"
  b.textContent = label
  b.title = title
  b.addEventListener("click", onClick)
  return b
}

function showAgentMenu(anchor: HTMLElement) {
  // Server returns EVERY agent it knows about, including three categories
  // the user must not pick from the menu:
  //   • hidden === true — internal utility agents (compaction/title/summary)
  //     used by the server itself; picking one as your session's agent would
  //     leave the session unable to do anything useful.
  //   • mode === "subagent" — only reachable via the `task` tool
  //     (general/explore); the LLM picks these, not the user.
  // Anything with mode === "primary" or "all" (or missing on legacy servers)
  // is a valid session-level agent.
  const items = state.agents
    .filter(isUserSelectableAgent)
    .map((a) => ({ label: a.name, value: a.name, title: a.description }))
  showPopupMenu(
    anchor,
    items,
    (val) => {
      state.agent = val
      persisted?.setAgent(state.directory, val)
      renderAgentModel()
    },
    state.agent,
  )
}

export function isUserSelectableAgent(a: AgentInfo): boolean {
  if (a.hidden === true) return false
  if (a.mode === "subagent") return false
  return true
}

function showModelMenu(anchor: HTMLElement) {
  const items: { label: string; value: string }[] = []
  for (const p of state.providers) {
    const models = p.models ? Object.values(p.models) : []
    for (const m of models) items.push({ label: `${p.name ?? p.id} / ${m.name ?? m.id}`, value: `${p.id}/${m.id}` })
  }
  showPopupMenu(
    anchor,
    items,
    (val) => {
      state.model = val
      persisted?.setModel(state.directory, val)
      renderAgentModel()
    },
    state.model,
    [
      {
        label: "＋ Add custom provider / model…",
        // Jump straight into the Providers settings tab with the add-form
        // pre-expanded — saves the user a click through the settings gear
        // + a click on "+ Add custom provider" once they get there.
        run: () => void openSettings("providers", { openAddForm: true }),
      },
      {
        label: "↻ Reload provider list",
        run: () => {
          void onRefreshProviders()
        },
      },
    ],
  )
}

type MenuAction = { label: string; run: () => void }
function showPopupMenu(
  anchor: HTMLElement,
  items: { label: string; value: string; title?: string }[],
  onPick: (value: string) => void,
  selectedValue?: string,
  actions?: MenuAction[],
) {
  const existing = document.getElementById("__popup_menu__")
  if (existing) existing.remove()
  const menu = document.createElement("div")
  menu.id = "__popup_menu__"
  Object.assign(menu.style, {
    position: "fixed",
    zIndex: "100",
    background: "var(--vscode-menu-background, var(--vscode-editorWidget-background))",
    color: "var(--vscode-menu-foreground, var(--vscode-editorWidget-foreground))",
    border: "1px solid var(--vscode-menu-border, var(--vscode-panel-border, transparent))",
    borderRadius: "4px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    minWidth: "180px",
    maxHeight: "50vh",
    overflowY: "auto",
    padding: "4px 0",
    fontSize: "12px",
  })
  const rect = anchor.getBoundingClientRect()
  // Position above the anchor when there's more space up top (typical for the
  // composer-anchored pills). Fall back to below when the anchor sits near the
  // top of the panel.
  const spaceBelow = window.innerHeight - rect.bottom
  const openUpward = spaceBelow < 200 && rect.top > spaceBelow
  if (openUpward) {
    menu.style.bottom = `${window.innerHeight - rect.top + 4}px`
    menu.style.left = `${rect.left}px`
  } else {
    menu.style.top = `${rect.bottom + 4}px`
    menu.style.left = `${rect.left}px`
  }
  const makeRow = (
    text: string,
    onClick: () => void,
    opts: { checked?: boolean; muted?: boolean; title?: string } = {},
  ) => {
    const el = document.createElement("div")
    Object.assign(el.style, {
      padding: "4px 10px 4px 22px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      position: "relative",
      opacity: opts.muted ? "0.85" : "1",
    })
    if (opts.checked) {
      const check = document.createElement("span")
      check.textContent = "✓"
      Object.assign(check.style, {
        position: "absolute",
        left: "6px",
        top: "50%",
        transform: "translateY(-50%)",
        color: "var(--vscode-textLink-foreground)",
        fontWeight: "600",
      })
      el.appendChild(check)
      el.style.fontWeight = "600"
    }
    const label = document.createElement("span")
    label.textContent = text
    el.appendChild(label)
    if (opts.title) el.title = opts.title
    el.addEventListener("mouseenter", () => (el.style.background = "var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground))"))
    el.addEventListener("mouseleave", () => (el.style.background = "transparent"))
    el.addEventListener("click", () => {
      onClick()
      menu.remove()
    })
    menu.appendChild(el)
    return el
  }

  // Selected item first so users see the current choice without scrolling.
  const sorted = selectedValue
    ? [...items].sort((a, b) => (a.value === selectedValue ? -1 : b.value === selectedValue ? 1 : 0))
    : items
  for (const item of sorted) {
    makeRow(item.label, () => onPick(item.value), {
      checked: item.value === selectedValue,
      title: item.title,
    })
  }
  if (items.length === 0) {
    const el = document.createElement("div")
    el.textContent = "(none)"
    el.style.padding = "4px 12px"
    el.style.opacity = "0.6"
    menu.appendChild(el)
  }
  if (actions && actions.length > 0) {
    const sep = document.createElement("div")
    Object.assign(sep.style, {
      height: "1px",
      background: "var(--vscode-menu-separatorBackground, var(--vscode-panel-border, transparent))",
      margin: "4px 0",
    })
    menu.appendChild(sep)
    for (const a of actions) makeRow(a.label, a.run, { muted: true })
  }
  document.body.appendChild(menu)
  const dismiss = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove()
      document.removeEventListener("mousedown", dismiss)
    }
  }
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0)
}

