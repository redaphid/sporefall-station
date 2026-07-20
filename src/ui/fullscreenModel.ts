/**
 * Fullscreen + cursor-hiding policy — the pure decision core plus a thin,
 * feature-detected glue layer over the browser Fullscreen API.
 *
 * WHY this shape: mouse aim reads the cursor's ABSOLUTE position (a vector from
 * the player toward the pointer — see input/aim.ts `pointerAim` and main.ts's
 * window `pointermove` tracker). We therefore hide the cursor with CSS
 * (`cursor: none` on the canvas) and NEVER with Pointer Lock, which would swap
 * absolute coordinates for relative deltas and break aiming.
 *
 * The decision functions are pure (DOM-free) so they unit-test exhaustively;
 * the API glue is thin, injectable (doc/el params), and swallows rejection —
 * the browser can deny fullscreen even from a valid user gesture, and a denied
 * request must never crash the game.
 */

/** Play state that decides whether the mouse cursor is hidden this frame. */
export interface CursorState {
  paused: boolean
  gameOver: boolean
  selfDead: boolean
}

/**
 * Hide the mouse cursor ONLY during active play. It stays visible on the pause
 * overlay, the death/game-over screen, and (by construction — this only runs in
 * the game loop) menus/lobbies, so every button remains clickable. Touch and
 * gamepad are unaffected: there is no OS cursor to hide on those paths.
 */
export const shouldHideCursor = (s: CursorState): boolean => !s.paused && !s.gameOver && !s.selfDead

/** Inputs gating an automatic (run-start) fullscreen request. */
export interface FullscreenGate {
  /** Player setting — the Fullscreen toggle in the settings panel. */
  enabled: boolean
  /** `document.fullscreenEnabled` — false on browsers/contexts that forbid it. */
  supported: boolean
  /** Capacitor native shell: the app is ALREADY fullscreen; don't fight it. */
  native: boolean
  /** Already in fullscreen — requesting again is a redundant no-op. */
  alreadyFullscreen: boolean
}

/**
 * Should we request browser fullscreen right now? Only when the player wants
 * it, the browser supports it, we are NOT inside the native Capacitor shell
 * (already fullscreen there), and we are not already fullscreen. Must be called
 * from within a user-gesture handler for the subsequent request to be honoured.
 */
export const canRequestFullscreen = (g: FullscreenGate): boolean =>
  g.enabled && g.supported && !g.native && !g.alreadyFullscreen

// ── Thin, feature-detected API glue (injectable for tests) ─────────────────

/** Minimal structural types so the glue is testable with a fake document/el. */
interface FsDoc {
  fullscreenEnabled?: boolean
  fullscreenElement?: Element | null
  exitFullscreen?: () => Promise<void>
}
interface FsEl {
  requestFullscreen?: () => Promise<void>
}

/** Is the browser Fullscreen API available at all? (`document.fullscreenEnabled`) */
export const fullscreenSupported = (doc: FsDoc = document): boolean => !!doc.fullscreenEnabled

/** Are we currently in fullscreen? (`document.fullscreenElement`) */
export const isFullscreen = (doc: FsDoc = document): boolean => !!doc.fullscreenElement

/**
 * Fire-and-forget fullscreen request on `el` (default: the whole page, so the
 * HUD/overlay layer on #ui is included — fullscreening only #app would crop
 * them out). No-op when unsupported or already fullscreen; a rejected promise
 * (browser denial) is swallowed so it can never crash the caller.
 */
export const enterFullscreen = (el: FsEl = document.documentElement, doc: FsDoc = document): void => {
  if (!fullscreenSupported(doc) || isFullscreen(doc)) return
  void el.requestFullscreen?.()?.catch(() => {})
}

/** Leave fullscreen if we're in it; swallow rejection. Esc also exits natively. */
export const exitFullscreen = (doc: FsDoc = document): void => {
  if (!isFullscreen(doc)) return
  void doc.exitFullscreen?.()?.catch(() => {})
}
