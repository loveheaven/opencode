// Attachments module.
//
// Staging area between the user and `sendPrompt`. Users add files via three
// paths — paste from clipboard, drag-and-drop onto the composer, and the
// "Add to OpenCode Chat" context menu (which the extension host forwards
// through the `addAttachments` postMessage). Every path funnels into the
// same list which sendPrompt drains and converts into opencode `file` parts.
//
// The module owns its own state array + strip DOM; main.ts holds a handle
// to `list()` when composing the outgoing prompt, and calls `clear()` after
// send succeeds.

import { openLightbox } from "./lightbox"

export type Attachment = {
  id: string
  mime: string
  url: string
  filename: string
  sizeBytes: number
}

// Max size per attachment. Providers reject huge inline data URLs; opencode
// enforces its own limits too, but bailing early gives a friendlier error.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024 // 8 MiB

const attachments: Attachment[] = []
let stripEl: HTMLElement | null = null
let inputEl: HTMLTextAreaElement | null = null
let setStatus: (text: string) => void = () => {}

/** Wire the strip DOM and shared setStatus. Called once from setup(). */
export function initAttachments(deps: {
  strip: HTMLElement
  input: HTMLTextAreaElement
  composer: HTMLElement
  setStatus: (text: string) => void
}) {
  stripEl = deps.strip
  inputEl = deps.input
  setStatus = deps.setStatus

  // Paste handler on the textarea; drag-and-drop on the composer so users
  // can drop anywhere in that region and still get the same behaviour.
  deps.input.addEventListener("paste", onPaste)
  ;["dragenter", "dragover"].forEach((evt) =>
    deps.composer.addEventListener(evt, (e) => {
      const dt = (e as DragEvent).dataTransfer
      if (!dt || !dt.types.includes("Files")) return
      e.preventDefault()
      deps.composer.classList.add("drag-hover")
    }),
  )
  ;["dragleave", "drop"].forEach((evt) =>
    deps.composer.addEventListener(evt, () => deps.composer.classList.remove("drag-hover")),
  )
  deps.composer.addEventListener("drop", (e) => void onDrop(e as DragEvent))
}

/** Snapshot of the current staging list. Do not mutate the returned array. */
export function listAttachments(): readonly Attachment[] {
  return attachments
}

/** Drop everything currently staged; call after a successful send. */
export function clearAttachments() {
  attachments.length = 0
  renderAttachments()
}

/**
 * Restore the strip from a previous snapshot. Used when sendPrompt fails to
 * hand things back to the user rather than losing them.
 */
export function restoreAttachments(list: readonly Attachment[]) {
  attachments.length = 0
  attachments.push(...list)
  renderAttachments()
}

/**
 * Called by main.ts when the extension host forwards right-clicked files
 * from the explorer / editor tab / editor title. Payload carries the
 * `file://…` URL that opencode server will parse on send.
 */
export function handleAddAttachments(items: Array<{ filename: string; mime: string; url: string; hint: string }>) {
  if (!items || items.length === 0 || !inputEl) return
  for (const item of items) {
    // Skip if we already have this exact url queued — repeated right-clicks
    // on the same file shouldn't duplicate.
    if (attachments.some((a) => a.url === item.url)) continue
    attachments.push({
      id: newAttachmentId(),
      mime: item.mime,
      url: item.url,
      filename: item.filename,
      // We don't know the file size without reading it; the server reads it
      // on send anyway. Zero suppresses the "· N bytes" tooltip suffix.
      sizeBytes: 0,
    })
  }
  renderAttachments()
  // Append a hint into the composer so the user sees which files got added
  // and can type their question after them. Trailing space so the caret
  // lands past the file token and the user just types.
  const added = items.map((i) => `@${i.hint}`).join(" ")
  const cur = inputEl.value
  const sep = cur.length === 0 || cur.endsWith(" ") || cur.endsWith("\n") ? "" : " "
  inputEl.value = `${cur}${sep}${added} `
  inputEl.focus()
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length)
  setStatus(`Attached: ${items.map((i) => i.hint).join(", ")}`)
}

async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue
    const f = item.getAsFile()
    if (f) files.push(f)
  }
  if (files.length === 0) return
  // Prevent the raw image bytes from being pasted as text into the textarea.
  e.preventDefault()
  await addFiles(files)
}

async function onDrop(e: DragEvent) {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length === 0) return
  e.preventDefault()
  await addFiles(files)
}

async function addFiles(files: File[]) {
  for (const file of files) {
    if (!isSupportedAttachment(file)) {
      setStatus(`Unsupported file type: ${file.type || file.name}`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setStatus(`${file.name} is too large (${formatBytes(file.size)} > ${formatBytes(MAX_ATTACHMENT_BYTES)})`)
      continue
    }
    try {
      const url = await fileToDataURL(file)
      attachments.push({
        id: newAttachmentId(),
        mime: file.type || guessMimeFromName(file.name),
        url,
        filename: file.name || defaultNameForMime(file.type),
        sizeBytes: file.size,
      })
    } catch (err) {
      setStatus(`Attach failed: ${(err as Error).message}`)
    }
  }
  renderAttachments()
}

function isSupportedAttachment(file: File): boolean {
  const t = (file.type || "").toLowerCase()
  if (t.startsWith("image/")) return true
  if (t === "application/pdf") return true
  return false
}

function guessMimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? ""
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
  }
  return map[ext] ?? "application/octet-stream"
}

function defaultNameForMime(mime: string): string {
  if (mime.startsWith("image/")) return `clipboard.${mime.split("/")[1] ?? "png"}`
  if (mime === "application/pdf") return "document.pdf"
  return "attachment"
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => {
      const result = reader.result
      if (typeof result === "string") resolve(result)
      else reject(new Error("unexpected reader result"))
    }
    reader.readAsDataURL(file)
  })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function newAttachmentId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function renderAttachments() {
  if (!stripEl) return
  stripEl.innerHTML = ""
  if (attachments.length === 0) {
    stripEl.hidden = true
    return
  }
  stripEl.hidden = false
  for (const att of attachments) {
    const chip = document.createElement("div")
    chip.className = "attachment-chip"
    chip.title = `${att.filename} · ${formatBytes(att.sizeBytes)}`
    if (att.mime.startsWith("image/")) {
      const img = document.createElement("img")
      img.src = att.url
      img.alt = att.filename
      img.style.cursor = "zoom-in"
      img.title = "Click to enlarge"
      img.addEventListener("click", (ev) => {
        ev.stopPropagation()
        openLightbox(att.url, att.filename)
      })
      chip.appendChild(img)
    } else {
      const icon = document.createElement("span")
      icon.className = "attachment-icon"
      icon.textContent = att.mime === "application/pdf" ? "PDF" : "FILE"
      chip.appendChild(icon)
    }
    const label = document.createElement("span")
    label.className = "attachment-name"
    label.textContent = att.filename
    chip.appendChild(label)
    const remove = document.createElement("button")
    remove.className = "attachment-remove"
    remove.type = "button"
    remove.title = "Remove"
    remove.setAttribute("aria-label", "Remove attachment")
    remove.textContent = "×"
    remove.addEventListener("click", () => {
      const idx = attachments.findIndex((a) => a.id === att.id)
      if (idx !== -1) attachments.splice(idx, 1)
      renderAttachments()
    })
    chip.appendChild(remove)
    stripEl.appendChild(chip)
  }
}
