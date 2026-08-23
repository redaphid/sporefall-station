/**
 * Controller camera zoom — VIEW-ONLY. Polled from the render frame loop
 * (main.ts), never from the sim: zoom is presentation exactly like wheel and
 * pinch, so nothing here may enter the InputCmd or cross the wire.
 *
 * While a bound zoomIn button is held the zoom target multiplies up each frame
 * (padZoomFactor — framerate-independent, wheel-feel), zoomOut down; both held
 * cancel to a no-op. Anchored on the screen centre: there is no cursor on a
 * pad, and centre is the pivot the player's eye is already on.
 *
 * Reads the LIVE user button map (remap.ts) each frame, so a binding made in
 * the settings panel works on the very next frame — and goes fully inert while
 * the panel is capturing a bind (isPadCaptureActive), the same "the press is
 * spent on the meta action" rule gameplay follows.
 */

import { padZoomFactor, type ZoomSink } from '../render/zoomModel'
import { getButtonMap, isPadCaptureActive } from './remap'
import { buttonPressed } from './readPad'

export interface PadZoomHeld {
  zoomIn: boolean
  zoomOut: boolean
}

/** Decode held zoom intent across every connected pad (any pad can zoom — the
 * view is shared on a couch device). Pure over its inputs; bounds-safe for
 * short button arrays via buttonPressed. */
export const readPadZoomHeld = (
  pads: readonly (Gamepad | null)[],
  map: { zoomIn: readonly number[]; zoomOut: readonly number[] },
): PadZoomHeld => {
  let zoomIn = false
  let zoomOut = false
  for (const p of pads) {
    if (!p) continue
    if (!zoomIn) zoomIn = map.zoomIn.some((b) => buttonPressed(p, b))
    if (!zoomOut) zoomOut = map.zoomOut.some((b) => buttonPressed(p, b))
    if (zoomIn && zoomOut) break
  }
  return { zoomIn, zoomOut }
}

export interface PadZoom {
  /** Call once per render frame with that frame's dt (seconds). */
  update(dt: number): void
}

export const createPadZoom = (
  zoom: ZoomSink,
  /** Screen centre in stage px — the zoom anchor (no cursor exists on a pad). */
  getCentre: () => { x: number; y: number },
  // Injectable for tests; the default is the same live surface gamepadCoop polls.
  getPads: () => readonly (Gamepad | null)[] = () => navigator.getGamepads?.() ?? [],
): PadZoom => ({
  update(dt: number): void {
    if (isPadCaptureActive()) return // the captured press must not zoom
    const map = getButtonMap()
    // Overwhelmingly common case (zoom unbound): skip the pad poll entirely.
    if (map.zoomIn.length === 0 && map.zoomOut.length === 0) return
    const held = readPadZoomHeld(getPads(), map)
    const f = padZoomFactor(held.zoomIn, held.zoomOut, dt)
    if (f === 1) return
    const c = getCentre()
    zoom.set(zoom.get() * f, c.x, c.y)
  },
})
