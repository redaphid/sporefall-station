// Gamepad navigation for the DOM menus (start picker, join/lobby, game-over
// overlay). Menus are plain <button>s driven by clicks; gamepads fire no DOM
// events, so without this a controller-only player is stuck the moment they hit
// a menu — no way to pick a mode, restart a run, or roll a new seed.
//
// This is a thin poll-loop over navigator.getGamepads(): each animation frame it
// reads one directional + confirm intent off the pad, edge-detects it (one press
// = one action; holding does not spam), moves a focus cursor across the live
// buttons, and `.click()`s the focused one on confirm. UI layer only — the
// determinism ban lives under src/game/, not here.
//
// Robustness notes: nav is read off the LEFT STICK (axes 0/1) and the standard
// d-pad buttons (12-15), never off the high "hat" axis that some pads (8BitDo
// Lite 2) park at -1 while idle — so a resting pad can't walk the cursor. Confirm
// accepts ANY face button (0-3) or Start (9): a player mashing to proceed should
// always get through, and these menus have no destructive option to fat-finger.

/** One frame's worth of intent decoded from a pad: move to prev/next item, or
 * confirm the focused one. Left/Up map to `prev`, Right/Down to `next`. */
export interface PadReading {
  prev: boolean
  next: boolean
  confirm: boolean
}

/** Edge-detection memory: what was held last frame, so a held control acts once. */
export interface NavMemory {
  prevDown: boolean
  nextDown: boolean
  confirmDown: boolean
}

export const emptyNavMemory = (): NavMemory => ({ prevDown: false, nextDown: false, confirmDown: false })

/** Stick magnitude past which an axis counts as a directional press. Well above
 * any spec-conformant resting drift, below a deliberate flick. */
export const MENU_STICK_DEADZONE = 0.5

/** A minimal shape covering the parts of the Gamepad API we read — keeps the
 * pure decoder testable without a real Gamepad. */
export interface PadLike {
  buttons: readonly { pressed: boolean }[]
  axes: readonly number[]
}

/** Decode a pad snapshot into directional + confirm intent. Tolerant of short
 * button/axis arrays (non-standard pads) — every lookup is bounds-guarded. */
export const readMenuPad = (gp: PadLike | null | undefined): PadReading => {
  if (!gp) return { prev: false, next: false, confirm: false }
  const pressed = (i: number): boolean => gp.buttons[i]?.pressed === true
  const axis = (i: number): number => gp.axes[i] ?? 0
  const dz = MENU_STICK_DEADZONE
  // Up OR Left → previous; Down OR Right → next. Covers vertical stacks and the
  // horizontal game-over button row with one control scheme.
  const prev = pressed(12) || pressed(14) || axis(1) <= -dz || axis(0) <= -dz
  const next = pressed(13) || pressed(15) || axis(1) >= dz || axis(0) >= dz
  const confirm = pressed(0) || pressed(1) || pressed(2) || pressed(3) || pressed(9)
  return { prev, next, confirm }
}

export interface NavStep {
  index: number
  activate: boolean
  mem: NavMemory
}

/** Pure reducer: given this frame's reading, the edge memory, the current focus
 * index and the item count, return the new index, whether to activate, and the
 * next memory. A press only fires on the false→true edge. Wrapping is cyclic. */
export const stepMenuNav = (reading: PadReading, mem: NavMemory, index: number, count: number): NavStep => {
  let idx = count > 0 ? Math.max(0, Math.min(count - 1, index)) : 0
  if (count > 0) {
    if (reading.prev && !mem.prevDown) idx = (idx - 1 + count) % count
    if (reading.next && !mem.nextDown) idx = (idx + 1) % count
  }
  const activate = count > 0 && reading.confirm && !mem.confirmDown
  return {
    index: idx,
    activate,
    mem: { prevDown: reading.prev, nextDown: reading.next, confirmDown: reading.confirm },
  }
}

/** Focus-cursor styling applied to the active button (a glow ring). Stashed on a
 * data attribute so we can cleanly strip it when focus moves or nav tears down. */
const FOCUS_SHADOW = '0 0 0 3px #ffd76a, 0 0 14px #ffd76aaa'

export interface GamepadMenuNavOptions {
  /** Poll scheduler + canceller — injectable so tests can drive frames by hand.
   * Defaults to requestAnimationFrame/cancelAnimationFrame. */
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
}

/**
 * Install controller navigation over a set of buttons and return a teardown fn.
 * `getButtons` is re-queried every frame, so dynamically-added buttons (BLE host
 * list) and show/hide (the game-over overlay) are handled: hidden/disabled
 * buttons are skipped, and when none are live the loop idles cheaply. Safe to
 * leave running for the lifetime of a persistent overlay.
 */
export const installGamepadMenuNav = (
  getButtons: () => HTMLButtonElement[],
  options: GamepadMenuNavOptions = {},
): (() => void) => {
  const schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb))
  const cancel = options.cancel ?? ((h) => cancelAnimationFrame(h))
  let handle = 0
  let index = 0
  let mem = emptyNavMemory()
  let painted: HTMLButtonElement | null = null

  const liveButtons = (): HTMLButtonElement[] =>
    getButtons().filter((b) => !b.disabled && b.offsetParent !== null)

  const paint = (btns: HTMLButtonElement[]): void => {
    const cur = btns[index] ?? null
    if (cur === painted) {
      if (cur && document.activeElement !== cur) cur.focus?.()
      return
    }
    if (painted) painted.style.boxShadow = ''
    if (cur) {
      cur.style.boxShadow = FOCUS_SHADOW
      if (document.activeElement !== cur) cur.focus?.()
    }
    painted = cur
  }

  const readPads = (): PadLike | null => {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
    for (const p of navigator.getGamepads()) if (p) return p
    return null
  }

  const frame = (): void => {
    const btns = liveButtons()
    if (btns.length > 0) {
      if (index >= btns.length) index = btns.length - 1
      const step = stepMenuNav(readMenuPad(readPads()), mem, index, btns.length)
      mem = step.mem
      index = step.index
      paint(btns)
      if (step.activate) btns[index]?.click()
    } else if (painted) {
      painted.style.boxShadow = ''
      painted = null
    }
    handle = schedule(frame)
  }

  handle = schedule(frame)
  return () => {
    cancel(handle)
    if (painted) painted.style.boxShadow = ''
    painted = null
  }
}
