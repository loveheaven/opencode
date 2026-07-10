// Image lightbox: full-panel preview for pasted / attached / rendered images.
//
// Features:
//   • click to open, Esc / ✕ / backdrop click to close
//   • mouse wheel to zoom around the cursor
//   • drag when zoomed to pan
//   • toolbar buttons for zoom in/out/reset
//
// Self-contained: reads its own DOM (`#image-lightbox`, `#lightbox-image`,
// toolbar buttons in index.html) and manages a single module-scoped state
// object. Callers only need `setupLightbox()` once at boot and
// `openLightbox(src, filename?)` per image; `closeLightbox()` is exported
// for the Escape handler in main.ts.

type LightboxState = {
  overlay: HTMLElement
  img: HTMLImageElement
  scale: number
  tx: number
  ty: number
  dragging: boolean
  dragStartX: number
  dragStartY: number
  dragOriginTx: number
  dragOriginTy: number
  wheelHandler?: (e: WheelEvent) => void
}

let state: LightboxState | null = null

export function setupLightbox() {
  const overlay = document.getElementById("image-lightbox") as HTMLElement | null
  const img = document.getElementById("lightbox-image") as HTMLImageElement | null
  if (!overlay || !img) return

  overlay.addEventListener("click", (e) => {
    // Only close when the click is on the backdrop itself, not the image or
    // the toolbar. Otherwise dragging the image would keep closing us.
    if (e.target === overlay) closeLightbox()
  })
  document.getElementById("lightbox-close")?.addEventListener("click", () => closeLightbox())
  document.getElementById("lightbox-zoom-in")?.addEventListener("click", () => zoomLightbox(1.25))
  document.getElementById("lightbox-zoom-out")?.addEventListener("click", () => zoomLightbox(1 / 1.25))
  document.getElementById("lightbox-zoom-reset")?.addEventListener("click", () => resetLightboxTransform())

  img.addEventListener("mousedown", (e) => {
    if (!state) return
    state.dragging = true
    state.dragStartX = e.clientX
    state.dragStartY = e.clientY
    state.dragOriginTx = state.tx
    state.dragOriginTy = state.ty
    img.style.cursor = "grabbing"
    e.preventDefault()
  })
  window.addEventListener("mousemove", (e) => {
    if (!state || !state.dragging) return
    state.tx = state.dragOriginTx + (e.clientX - state.dragStartX)
    state.ty = state.dragOriginTy + (e.clientY - state.dragStartY)
    applyLightboxTransform()
  })
  window.addEventListener("mouseup", () => {
    if (!state) return
    state.dragging = false
    state.img.style.cursor = state.scale > 1 ? "grab" : "zoom-in"
  })
}

export function openLightbox(src: string, filename?: string) {
  const overlay = document.getElementById("image-lightbox") as HTMLElement | null
  const img = document.getElementById("lightbox-image") as HTMLImageElement | null
  if (!overlay || !img) return
  img.src = src
  img.alt = filename ?? ""
  overlay.hidden = false
  state = {
    overlay,
    img,
    scale: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginTx: 0,
    dragOriginTy: 0,
  }
  applyLightboxTransform()
  // Wheel zoom scoped to the overlay so we don't fight page scroll.
  state.wheelHandler = (e: WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    zoomLightbox(factor, e.clientX, e.clientY)
  }
  overlay.addEventListener("wheel", state.wheelHandler, { passive: false })
}

export function closeLightbox() {
  if (!state) return
  const { overlay, wheelHandler } = state
  overlay.hidden = true
  if (wheelHandler) overlay.removeEventListener("wheel", wheelHandler)
  state = null
}

export function isLightboxOpen(): boolean {
  return state !== null
}

function zoomLightbox(factor: number, cx?: number, cy?: number) {
  if (!state) return
  const prev = state.scale
  const next = Math.min(8, Math.max(0.1, prev * factor))
  if (next === prev) return
  if (cx !== undefined && cy !== undefined) {
    // Zoom around the cursor: keep the world-point under the cursor stationary.
    const rect = state.img.getBoundingClientRect()
    const originX = rect.left + rect.width / 2
    const originY = rect.top + rect.height / 2
    const dx = cx - originX
    const dy = cy - originY
    const ratio = next / prev - 1
    state.tx -= dx * ratio
    state.ty -= dy * ratio
  }
  state.scale = next
  state.img.style.cursor = next > 1 ? "grab" : "zoom-in"
  applyLightboxTransform()
}

function resetLightboxTransform() {
  if (!state) return
  state.scale = 1
  state.tx = 0
  state.ty = 0
  applyLightboxTransform()
}

function applyLightboxTransform() {
  if (!state) return
  const { img, scale, tx, ty } = state
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
}
