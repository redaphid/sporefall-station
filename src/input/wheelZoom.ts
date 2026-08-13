import { wheelZoomFactor, type ZoomSink } from '../render/zoomModel'
import { toStage } from '../ui/orientation'

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
      // Stage space (ui/orientation.ts). A desktop stage is never rotated, so
      // this is the identity there — but it is also the correct anchor if the
      // page is ever rotated, and it removes the getBoundingClientRect that
      // would silently mean the wrong rectangle on a transformed canvas.
      const p = toStage(ev.clientX, ev.clientY)
      zoom.set(zoom.get() * wheelZoomFactor(ev.deltaY, ev.deltaMode), p.x, p.y)
    },
    { passive: false, capture: true },
  )
}
