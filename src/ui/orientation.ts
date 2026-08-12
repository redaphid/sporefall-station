/**
 * Landscape-always presentation.
 *
 * THE GOAL: the game PRESENTS landscape whatever the phone is doing — not "asks
 * politely and gives up if refused". Three levers, in decreasing order of how
 * absolute they are:
 *
 *   1. The installed Android app — `android:screenOrientation="sensorLandscape"`
 *      in AndroidManifest.xml. The OS simply cannot present the activity in
 *      portrait, and an activity's requested orientation OVERRIDES the user's
 *      auto-rotate/rotation-lock setting. Nothing in this file is involved.
 *   2. An installed PWA — `"orientation": "landscape"` in the web manifest.
 *      Honoured by Chrome/Android for installed apps; ignored by iOS.
 *   3. A browser tab — `screen.orientation.lock()`. This one is NOT reliable:
 *      it requires fullscreen, and **iOS Safari does not implement `lock()` at
 *      all** (Safari 16.4 shipped `type`/`angle`/`onchange` and deliberately not
 *      `lock`). So on iOS the lock can never succeed, on any setting.
 *
 * Because (3) fails outright on a whole platform, the lock alone would leave
 * browser players in portrait. So when the viewport is portrait anyway we ROTATE
 * THE GAME ITSELF: the entire stage (canvas + every DOM layer) is turned 90°
 * clockwise and sized to the swapped dimensions, so a landscape game fills a
 * portrait screen. Landscape EVERYWHERE, rather than landscape on some devices.
 *
 * ── THE TRAP THIS MODULE EXISTS TO CLOSE ────────────────────────────────────
 *
 * If the view rotates and the input mapping does not, every control is 90° out:
 * press left, go up. It looks perfect on a desktop (which never rotates) and is
 * broken on every phone. The fix is structural, not a patch at each call site:
 *
 *   **Above the DOM event boundary, this codebase works in STAGE coordinates.**
 *
 * Every listener that reads `clientX`/`clientY` converts through {@link toStage}
 * FIRST, and everything downstream (stick vectors, pinch midpoints, tap→world
 * picking, mouse aim) is then automatically correct, because it is doing its
 * arithmetic in the same space the game is drawn in. Deltas need no separate
 * treatment: convert both endpoints and subtract, and the rotation comes out in
 * the wash. When rotation is 0, `toStage` is the identity and nothing changes.
 *
 * The pure functions below are DOM-free so the whole mapping is unit-tested
 * exhaustively (orientation.test.ts), including the "press left, go up" case.
 *
 * ── ROTATION DIRECTION ──────────────────────────────────────────────────────
 *
 * We rotate the content 90° CLOCKWISE, which puts the game's top edge on the
 * phone's physical RIGHT edge — i.e. the player turns the phone COUNTER-
 * clockwise (its natural top goes to the left). That matches Android's own
 * default `landscape` (Surface.ROTATION_90), so the browser fallback and the
 * installed app ask the player to hold the phone the same way. If we ever want
 * the other handedness, it is the one `ROTATION` constant plus its table row.
 */

/** Clockwise rotation applied to the whole stage, in degrees. */
export type StageRotation = 0 | 90

/** The single non-zero rotation we ever apply (see header: direction rationale). */
export const ROTATION: StageRotation = 90

// ─────────────────────────────────────────────────────────────────────────────
// Pure core — no DOM, exhaustively unit-tested.

/** One frame of facts deciding whether the stage is rotated. */
export interface RotationGate {
  /** Layout viewport width/height in CSS px (`window.innerWidth/innerHeight`). */
  vw: number
  vh: number
  /**
   * The PRIMARY pointer is coarse — a phone/tablet. A desktop browser in a tall,
   * narrow window is ALSO "portrait" by aspect ratio, and turning a desktop game
   * on its side would be absurd, so the fallback is phone-only. Reuse
   * `detectTouchCaps(...).coarsePrimary` (input/stickVisibility.ts) for this.
   */
  coarsePrimary: boolean
}

/**
 * Rotate only when a coarse-pointer device is genuinely presenting portrait.
 *
 * Note what this does NOT need to special-case: when the orientation lock works
 * (installed app, Android Chrome in fullscreen) the viewport is already
 * landscape, so `vh > vw` is false and the answer is 0 — the lock and the
 * fallback compose instead of fighting. Square is landscape enough; don't rotate.
 */
export const pickRotation = (g: RotationGate): StageRotation => (g.coarsePrimary && g.vh > g.vw ? ROTATION : 0)

/** Stage box in stage-local CSS px — the swapped dimensions when rotated. */
export const stageSize = (vw: number, vh: number, rot: StageRotation): { w: number; h: number } =>
  rot === 90 ? { w: vh, h: vw } : { w: vw, h: vh }

/**
 * The CSS transform placing the stage over the viewport, for `transform-origin:
 * 0 0`. A 90° clockwise rotation maps local (x,y) → (-y, x), which lands the box
 * off-screen to the left, so it is translated right by the viewport width.
 */
export const stageTransform = (vw: number, rot: StageRotation): string =>
  rot === 90 ? `translate(${vw}px, 0px) rotate(90deg)` : 'none'

/**
 * Viewport (clientX/clientY) → stage coordinates. THE conversion the whole
 * input layer funnels through; the identity when unrotated.
 *
 * Inverse of the transform above: client = (vw - y, x), so stage = (cy, vw - cx).
 */
export const clientToStage = (
  cx: number,
  cy: number,
  vw: number,
  rot: StageRotation,
): { x: number; y: number } => (rot === 90 ? { x: cy, y: vw - cx } : { x: cx, y: cy })

/** The four box edges, as CSS names them. */
export type Edge = 'top' | 'right' | 'bottom' | 'left'

const EDGES: readonly Edge[] = ['top', 'right', 'bottom', 'left']

/**
 * Which PHYSICAL screen edge each STAGE edge sits on, per rotation.
 *
 * This is why safe-area insets cannot be left alone: `env(safe-area-inset-top)`
 * always means the physical top (the notch / status bar), but once the stage is
 * rotated the game's "top" is the phone's RIGHT edge. A HUD anchored to
 * `env(safe-area-inset-top)` would dodge a notch that is no longer there while
 * sitting straight under the real one.
 */
const EDGE_SOURCE: Record<StageRotation, Record<Edge, Edge>> = {
  0: { top: 'top', right: 'right', bottom: 'bottom', left: 'left' },
  90: { top: 'right', right: 'bottom', bottom: 'left', left: 'top' },
}

/** CSS custom-property name carrying the STAGE-space inset for one edge. */
export const safeAreaVar = (edge: Edge): string => `--sf-safe-${edge}`

/**
 * The `--sf-safe-*` custom properties for a rotation: stage-space safe-area
 * insets, re-pointed at whichever physical edge that stage edge now occupies.
 * UI anchors to `var(--sf-safe-top, 0px)` and stops caring about rotation.
 */
export const safeAreaVars = (rot: StageRotation): Record<string, string> =>
  Object.fromEntries(
    EDGES.map((e) => [safeAreaVar(e), `env(safe-area-inset-${EDGE_SOURCE[rot][e]}, 0px)`]),
  )

// ─────────────────────────────────────────────────────────────────────────────
// Ambient stage state.
//
// A module-level singleton, deliberately — the same shape as render/themeState.ts.
// The alternative is threading a transform through touch.ts, overlay.ts,
// wheelZoom.ts and main.ts, and a call site that FORGETS to thread it is exactly
// the 90°-out bug this module exists to prevent. One import, no plumbing, and an
// identity default so every test and headless harness behaves as it always did.
// It lives in src/ui/ and touches no sim state: determinism is untouched.

let activeVw = 0
let activeRot: StageRotation = 0

/** The rotation currently applied to the stage (0 when not rotated). */
export const currentRotation = (): StageRotation => activeRot

/**
 * Convert a viewport point (a pointer event's clientX/clientY) into stage
 * coordinates. Call this at EVERY DOM event boundary before doing any
 * arithmetic with the coordinates — see the header.
 */
export const toStage = (cx: number, cy: number): { x: number; y: number } =>
  clientToStage(cx, cy, activeVw, activeRot)

// ─────────────────────────────────────────────────────────────────────────────
// DOM glue — thin, injectable, and the only part that is not unit-tested.

export interface Stage {
  /** Re-measure the viewport and re-apply size/transform/insets. */
  refresh(): void
  /**
   * Called after the stage geometry actually changed. The pixi renderer sizes
   * itself from the stage element (`resizeTo`), so it must re-read on a flip.
   */
  onChange?: () => void
  /** Detach listeners (tests/harnesses). */
  dispose(): void
}

/**
 * Own `el` as the rotating stage: size it to the viewport (swapped when
 * rotated), apply the transform, publish the stage-space safe-area insets, and
 * keep all of that current across resizes and orientation changes.
 */
export const installStage = (el: HTMLElement, gate: { coarsePrimary: boolean }, win: Window = window): Stage => {
  el.style.position = 'fixed'
  el.style.left = '0'
  el.style.top = '0'
  el.style.transformOrigin = '0 0'
  // The rotated box is exactly viewport-sized, so nothing should ever overflow —
  // but a rotated child that misbehaves must not paint outside the screen.
  el.style.overflow = 'hidden'

  const stage: Stage = {
    refresh(): void {
      const vw = win.innerWidth
      const vh = win.innerHeight
      const rot = pickRotation({ vw, vh, coarsePrimary: gate.coarsePrimary })
      const size = stageSize(vw, vh, rot)
      const changed = rot !== activeRot || vw !== activeVw
      activeRot = rot
      activeVw = vw
      el.style.width = `${size.w}px`
      el.style.height = `${size.h}px`
      el.style.transform = stageTransform(vw, rot)
      for (const [k, v] of Object.entries(safeAreaVars(rot))) el.style.setProperty(k, v)
      if (changed) stage.onChange?.()
    },
    dispose(): void {
      win.removeEventListener('resize', onResize)
      win.removeEventListener('orientationchange', onResize)
      win.screen?.orientation?.removeEventListener?.('change', onResize)
    },
  }

  const onResize = (): void => stage.refresh()
  win.addEventListener('resize', onResize)
  win.addEventListener('orientationchange', onResize)
  // Some browsers fire the ScreenOrientation change before a resize settles.
  win.screen?.orientation?.addEventListener?.('change', onResize)
  stage.refresh()
  return stage
}

/** The slice of `screen.orientation` we use — structural, so it fakes cleanly.
 * `lock` is typed to the one value we ever pass, which keeps the real
 * `ScreenOrientation` (whose parameter is the narrower `OrientationLockType`)
 * structurally assignable to it. */
export interface OrientationLike {
  lock?: (orientation: 'landscape') => Promise<void>
  type?: string
}

/**
 * Can this browser lock orientation at all?
 *
 * The load-bearing case: **iOS Safari exposes `screen.orientation` but no
 * `lock`**, so this is false there and the render-rotation fallback is what
 * actually delivers landscape on iPhone. Android Chrome has `lock`, but it only
 * SUCCEEDS in fullscreen — hence {@link lockLandscape} being called from the
 * fullscreenchange handler rather than hopefully at boot.
 */
export const canLockOrientation = (o: OrientationLike | undefined): boolean => typeof o?.lock === 'function'

/**
 * Ask the browser for landscape. Fire-and-forget: a browser may reject because
 * we are not fullscreen, because the platform forbids it, or for no stated
 * reason, and a refused lock must never crash the game — the rotation fallback
 * is standing by regardless.
 */
export const lockLandscape = (o: OrientationLike | undefined = globalThis.screen?.orientation): void => {
  if (!canLockOrientation(o)) return
  void o!.lock!('landscape').catch(() => {})
}
