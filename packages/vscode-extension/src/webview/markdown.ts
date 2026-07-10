// Markdown rendering for the chat bubbles.
//
// Backed by markdown-it (CommonMark + GFM tables) with the task-list plugin
// on top so `- [ ]` / `- [x]` render as checkbox items. Previous hand-rolled
// parser was missing tables, strikethrough, task lists, nested lists, and
// hardened poorly against edge cases (auto-linking, HTML escaping, etc.).
//
// Security posture: markdown-it is configured with `html: false`, so any
// raw HTML in the input renders as text — no XSS surface even without an
// extra sanitizer. Autolinks (`linkify`) are also off; LLMs already emit
// proper `[text](url)` markdown and we want plain `example.com` in prose
// to stay text.
//
// Styling note: markdown-it emits stock tag names (`<table>`, `<del>`, etc.).
// We add a `.md-table` class on tables via a renderer override so the CSS
// selectors in styles.css keep working; every other element styles via its
// parent `.prose` scope.

import MarkdownIt from "markdown-it"
import taskLists from "markdown-it-task-lists"
import hljs from "highlight.js/lib/common"

// Syntax highlighting for fenced code blocks. `highlight.js/lib/common`
// preloads ~34 languages (js/ts/py/go/rust/java/sh/css/html/json/xml/yaml/
// md/sql/…) — covers virtually every LLM code block we see. If the tagged
// language isn't recognised we try auto-detect; if that scores nothing
// meaningful we fall back to raw escaped text so the block still shows.
function highlight(code: string, lang: string): string {
  const tagged = lang && hljs.getLanguage(lang)
  if (tagged) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      // fall through to auto
    }
  }
  try {
    const auto = hljs.highlightAuto(code)
    // highlightAuto returns even for pure prose; only trust it when it's
    // reasonably confident. relevance below ~5 usually means guesswork.
    if (auto.relevance >= 5 && auto.value) return auto.value
  } catch {
    // ignore, fall through
  }
  return md.utils.escapeHtml(code)
}

const md = new MarkdownIt({
  html: false,
  xhtmlOut: false,
  // Single newlines become <br>. LLMs use them meaningfully in prose
  // (line-broken poetry, aligned commands, etc.); default CommonMark would
  // merge them into a single paragraph.
  breaks: true,
  linkify: false,
  typographer: false,
  // Wrap highlighted HTML in <pre><code class="hljs language-…"> so the
  // github/github-dark stylesheets we ship apply. Returning full markup
  // means markdown-it won't wrap again.
  highlight: (code, lang) => {
    const cls = `hljs${lang ? ` language-${lang}` : ""}`
    return `<pre><code class="${cls}">${highlight(code, lang)}</code></pre>`
  },
})

// Add a class to tables so styles.css `.md-table` selectors keep applying.
// markdown-it's default is `<table>` with no class — one line override.
const defaultTableOpen = md.renderer.rules.table_open ?? ((_tokens, _idx, options, _env, self) => self.renderToken(_tokens, _idx, options))
md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  token.attrJoin("class", "md-table")
  return defaultTableOpen(tokens, idx, options, env, self)
}

// Force anchor targets to open safely. External http(s) links should open
// externally; VSCode webviews route <a href="..."> clicks through the host,
// which turns them into `vscode.env.openExternal`. Adding rel="noreferrer"
// is belt-and-suspenders.
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const href = token.attrGet("href") ?? ""
  // Restrict schemes we hand to the webview. `file:` is fine — click handler
  // in main.ts intercepts and opens in the editor. Anything else that isn't
  // http(s)/mailto gets neutered to "#" so a hostile mention like
  // `javascript:...` can't slip through even though html:false is off.
  if (!/^(https?:|mailto:|file:)/i.test(href)) token.attrSet("href", "#")
  token.attrSet("rel", "noreferrer")
  return defaultLinkOpen(tokens, idx, options, env, self)
}

md.use(taskLists, { enabled: false, label: false })

export function renderMarkdown(input: string): string {
  return md.render(input ?? "")
}

// Kept for callers that want to escape user-supplied text before injecting
// into innerHTML outside of markdown context (tool bodies, badges, etc.).
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!))
}

export function escapeAttr(text: string): string {
  return escapeHtml(text)
}
