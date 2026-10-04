// Gamepad navigation for the DOM menus (start picker, join/lobby, game-over
// overlay, pause). Menus are plain <button>s driven by clicks; gamepads fire no DOM
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
// defaults to ANY face button (0-3) or Start (9): a player mashing to proceed
// should always get through. The pause menu narrows that to A, gives B to back,
// and puts its one destructive button (New Seed) behind a second press.

/** One frame's worth of intent decoded from a pad: the four directions,
 * confirm, and back. */
export interface PadReading {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
  confirm: boolean
  back: boolean
}

/** Edge-detection memory: what was held last frame, so a held control acts once. */
export type NavMemory = PadReading

export const emptyNavMemory = (): NavMemory => ({ up: false, down: false, left: false, right: false, confirm: false, back: false })

/** Stick magnitude past which an axis counts as a directional press. Well above
 * any spec-conformant resting drift, below a deliberate flick. */
export const MENU_STICK_DEADZONE = 0.5

/** A minimal shape covering the parts of the Gamepad API we read — keeps the
 * pure decoder testable without a real Gamepad. */
export interface PadLike {
  buttons: readonly { pressed: boolean }[]
  axes: readonly number[]
}

/** The buttons that confirm by default: any face button, or Start. */
export const MENU_CONFIRM_BUTTONS: readonly number[] = [0, 1, 2, 3, 9]

/** Decode a pad snapshot into directional, confirm and back intent. Tolerant of
 * short button/axis arrays (non-standard pads): every lookup is bounds-guarded. */
export const readMenuPad = (
  gp: PadLike | null | undefined,
  confirmButtons: readonly number[] = MENU_CONFIRM_BUTTONS,
  backButtons: readonly number[] = [],
): PadReading => {
  if (!gp) return emptyNavMemory()
  const pressed = (i: number): boolean => gp.buttons[i]?.pressed === true
  const axis = (i: number): number => gp.axes[i] ?? 0
  const dz = MENU_STICK_DEADZONE
  return {
    up: pressed(12) || axis(1) <= -dz,
    down: pressed(13) || axis(1) >= dz,
    left: pressed(14) || axis(0) <= -dz,
    right: pressed(15) || axis(0) >= dz,
    confirm: confirmButtons.some(pressed),
    back: backButtons.some(pressed),
  }
}

/** Where the cursor sits: a row of the menu, and a control within it. */
export interface NavFocus {
  row: number
  col: number
}

export interface NavStep {
  focus: NavFocus
  activate: boolean
  back: boolean
  mem: NavMemory
}

/** Snap a focus onto a live control: the same row if it has any, else the first
 * row that does. Column clamps to the row's end. */
const settle = (focus: NavFocus, rows: readonly number[]): NavFocus => {
  const row = (rows[focus.row] ?? 0) > 0 ? focus.row : rows.findIndex((n) => n > 0)
  if (row < 0) return { row: 0, col: 0 }
  return { row, col: Math.max(0, Math.min(rows[row] - 1, focus.col)) }
}

/** The next non-empty row after `row` going `dir`, cyclic. */
const nextRow = (rows: readonly number[], row: number, dir: 1 | -1): number => {
  for (let k = 1; k <= rows.length; k++) {
    const r = (row + dir * k + rows.length * k) % rows.length
    if (rows[r] > 0) return r
  }
  return row
}

/**
 * Pure reducer over a menu laid out as rows of controls (`rows[i]` is row i's
 * control count). A press acts only on its false→true edge, and every move wraps.
 *
 * One live row (every menu except pause): Up/Left step back and Down/Right step
 * forward, so a vertical stack and a horizontal row share one scheme. Several
 * rows: Up/Down change row, keeping the column where the new row allows, and
 * Left/Right walk within the row.
 */
export const stepMenuNav = (reading: PadReading, mem: NavMemory, focus: NavFocus, rows: readonly number[]): NavStep => {
  const rose = (k: keyof PadReading): boolean => reading[k] && !mem[k]
  let { row, col } = settle(focus, rows)
  const live = rows.filter((n) => n > 0).length
  if (live > 0) {
    const n = rows[row]
    const vertical = live > 1
    const back = rose('left') || (!vertical && rose('up'))
    const fwd = rose('right') || (!vertical && rose('down'))
    if (back) col = (col - 1 + n) % n
    if (fwd) col = (col + 1) % n
    if (vertical && (rose('up') || rose('down'))) {
      row = nextRow(rows, row, rose('up') ? -1 : 1)
      col = Math.min(col, rows[row] - 1)
    }
  }
  return { focus: { row, col }, activate: live > 0 && rose('confirm'), back: rose('back'), mem: reading }
}

/** Focus-cursor styling applied to the active button (a glow ring). Stashed on a
 * data attribute so we can cleanly strip it when focus moves or nav tears down. */
export const FOCUS_SHADOW = '0 0 0 3px #ffd76a, 0 0 14px #ffd76aaa'

/** What the nav cursor can land on. Buttons everywhere; the settings panel also
 * walks its selects and checkboxes (all three carry `.disabled`, `.focus()`,
 * and `.click()`, which is all the driver touches). */
export type MenuNavControl = HTMLButtonElement | HTMLSelectElement | HTMLInputElement

export interface GamepadMenuNavOptions {
  /** Poll scheduler + canceller — injectable so tests can drive frames by hand.
   * Defaults to requestAnimationFrame/cancelAnimationFrame. */
  schedule?: (cb: () => void) => number
  cancel?: (handle: number) => void
  /**
   * While true, this navigator is INERT: no focus paint, no movement, no
   * activation. On the first frame after suppression lifts, the edge memory is
   * re-baselined against the pad's CURRENT held state before anything can act,
   * so a press consumed elsewhere (another overlay's navigator, the remap bind
   * capture) can never edge-fire here on resume — only a genuinely fresh press
   * does. This is what keeps exactly one navigator live when overlays stack
   * (settings over the start menu).
   */
  suppress?: () => boolean
  /** Confirm action for the focused control; defaults to `.click()`. The
   * settings panel uses it to cycle a <select> instead (a synthetic click
   * cannot open the native dropdown). */
  activate?: (el: MenuNavControl) => void
  /** Pad buttons that confirm; defaults to MENU_CONFIRM_BUTTONS. The pause menu
   * leaves out Start, which already resumes the run. */
  confirmButtons?: readonly number[]
  /** A back press: these buttons run `run` on their edge (the pause menu's B). */
  back?: { buttons: readonly number[]; run: () => void }
  /** Where the cursor lands each time suppression lifts (the menu reopens).
   * Without it the cursor stays wherever it was left. */
  home?: NavFocus
}

/** A flat list is one row; the pause menu passes rows (the wand strip above the
 * action buttons). */
export type MenuNavLayout = MenuNavControl[] | MenuNavControl[][]

const asRows = (layout: MenuNavLayout): MenuNavControl[][] =>
  layout.length > 0 && Array.isArray(layout[0]) ? (layout as MenuNavControl[][]) : [layout as MenuNavControl[]]

/**
 * Install controller navigation over a set of buttons and return a teardown fn.
 * `getButtons` is re-queried every frame, so dynamically-added buttons (BLE host
 * list) and show/hide (the game-over overlay) are handled: hidden/disabled
 * buttons are skipped, and when none are live the loop idles cheaply. Safe to
 * leave running for the lifetime of a persistent overlay.
 *
 * The cursor follows real focus: when a tap or click focuses one of these
 * controls, the cursor moves there instead of pulling focus back.
 */
export const installGamepadMenuNav = (
  getButtons: () => MenuNavLayout,
  options: GamepadMenuNavOptions = {},
): (() => void) => {
  const schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb))
  const cancel = options.cancel ?? ((h) => cancelAnimationFrame(h))
  const activate = options.activate ?? ((el: MenuNavControl) => el.click())
  const readPads = (): PadLike | null => {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
    for (const p of navigator.getGamepads()) if (p) return p
    return null
  }
  let handle = 0
  let focus: NavFocus = options.home ?? { row: 0, col: 0 }
  let mem = emptyNavMemory()
  let painted: MenuNavControl | null = null
  let paintedWas = '' // the control's own shadow (the strip glows its next chip), restored on unpaint

  const liveRows = (): MenuNavControl[][] =>
    asRows(getButtons()).map((row) => row.filter((b) => !b.disabled && b.offsetParent !== null))

  const unpaint = (): void => {
    if (painted) painted.style.boxShadow = paintedWas
    painted = null
  }

  /** Ring the focused control. Pull real focus onto it when the pad moved the
   * cursor, or when nothing else holds focus (a just-shown overlay). */
  const paint = (rows: MenuNavControl[][], moved: boolean): void => {
    const cur = rows[focus.row]?.[focus.col] ?? null
    if (cur !== painted) {
      unpaint()
      if (cur) {
        paintedWas = cur.style.boxShadow
        cur.style.boxShadow = FOCUS_SHADOW
      }
      painted = cur
    }
    const active = document.activeElement
    if (cur && active !== cur && (moved || !active || active === document.body)) cur.focus?.()
  }

  const adoptRealFocus = (rows: MenuNavControl[][]): void => {
    const active = document.activeElement
    rows.forEach((row, r) => {
      const c = row.indexOf(active as MenuNavControl)
      if (c >= 0) focus = { row: r, col: c }
    })
  }

  // Set while suppressed; the first live frame afterwards re-baselines the edge
  // memory instead of acting (see GamepadMenuNavOptions.suppress).
  let resync = false

  const frame = (): void => {
    const rows = liveRows()
    const counts = rows.map((r) => r.length)
    if (options.suppress?.()) {
      resync = true
      unpaint()
    } else if (counts.some((n) => n > 0)) {
      const gp = readPads()
      const reading = readMenuPad(gp, options.confirmButtons, options.back?.buttons)
      if (resync) {
        resync = false
        if (options.home) focus = options.home
        focus = stepMenuNav(emptyNavMemory(), emptyNavMemory(), focus, counts).focus
        mem = reading
        paint(rows, true) // show the cursor at once; presses act from the next frame
      } else if (!gp) {
        // No pad is not a release: keep the memory, so a button held through a
        // disconnect cannot edge-fire when the pad comes back.
        adoptRealFocus(rows)
        paint(rows, false)
      } else {
        adoptRealFocus(rows)
        const before = focus
        const step = stepMenuNav(reading, mem, focus, counts)
        mem = step.mem
        focus = step.focus
        paint(rows, focus.row !== before.row || focus.col !== before.col)
        if (step.activate) {
          const focused = rows[focus.row]?.[focus.col]
          if (focused) activate(focused)
        }
        if (step.back) options.back?.run()
      }
    } else {
      unpaint()
    }
    handle = schedule(frame)
  }

  handle = schedule(frame)
  return () => {
    cancel(handle)
    unpaint()
  }
}
