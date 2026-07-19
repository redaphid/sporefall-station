import { wheelZoomFactor, type ZoomSink } from '../render/zoomModel'

/**
 * Desktop scroll-wheel zoom (dev/browser). Wheel over the game canvas zooms,
 * anchored on the cursor so the world point under it stays put. Ctrl+wheel
 * ANYWHERE is preventDefault-ed — the browser must never pinch-zoom/mangle the
 * page — while plain wheel over real UI (settings panel, cards, menus) is left
 * alone so scrollable panels keep scrolling.
 *
 * Listening on `window` (capture) rather than the canvas catches the event even
 * when a pointer-events:auto overlay sits on top of the play area.
 */
export const wireWheelZoom = (canvas: HTMLElement, zoom: ZoomSink): void => {
  window.addEventListener(
    'wheel',
    (ev) => {
      // The canvas is the target whenever the cursor is over the play area:
      // every overlay layer above it is pointer-events:none except true UI.
      const overCanvas = ev.target === canvas
      if (!overCanvas && !ev.ctrlKey) return
      ev.preventDefault()
      if (!overCanvas) return
      const rect = canvas.getBoundingClientRect()
      zoom.set(zoom.get() * wheelZoomFactor(ev.deltaY, ev.deltaMode), ev.clientX - rect.left, ev.clientY - rect.top)
    },
    { passive: false, capture: true },
  )
}
