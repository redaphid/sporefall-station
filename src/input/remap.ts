/**
 * User button remapping — an overlay on THE button map (padProfile.BUTTONS),
 * applied at read time via `remapProfile` (gamepadCoop wraps every
 * `padProfile(pad)` in it, so a change applies on the very next poll, no
 * reload). Persisted to localStorage like the theme setting; one map for all
 * pads and all profiles (standard/canonical/raw share the button table
 * already, so they share the remap too).
 *
 * Scope, deliberately narrow:
 *   - BUTTONS ONLY. Axes are never remappable — the raw-pad safety invariant
 *     ("no unproven axis may ever fire") must not grow a user-configurable
 *     bypass. The capture machine (padCapture.ts) never reads `pad.axes`.
 *   - `join` and `dpad` are not remappable (see padProfile.defaultButtons).
 *
 * Conflict rule — SWAP: binding a button that another action already owns
 * exchanges the two actions' bindings (the displaced action takes the buttons
 * the rebound action used to have). One button therefore drives at most one
 * action, except via the untouched defaults (RB/L2/R2 all fire attack today).
 * An action CAN end up unbound — capturing Start for something else leaves
 * pause with no button, which is acceptable: the panel still opens via the
 * gear, and any binding can be restored by reset.
 *
 * Schema is versioned ({ v: 1, map }) and validated all-or-nothing: any
 * missing/invalid action falls back to FULL defaults rather than a partial
 * merge, because a partial merge could silently recreate the multi-action
 * conflicts the swap rule exists to prevent.
 */

import { defaultButtons, type PadProfile } from './padProfile'
import { migrateLegacyKey } from '../app/storageMigration'

export type ButtonMap = ReturnType<typeof defaultButtons>
export type PadAction = keyof ButtonMap

/** UI order: the frequent verbs first, meta last. */
export const PAD_ACTIONS: readonly PadAction[] = [
  'attack',
  'interact',
  'special',
  'roll',
  'throw',
  'hotbarPrev',
  'hotbarNext',
  'pause',
]

export const ACTION_LABELS: Record<PadAction, string> = {
  attack: 'Attack',
  interact: 'Interact',
  special: 'Special',
  roll: 'Dodge roll',
  throw: 'Throw item',
  hotbarPrev: 'Weapon prev',
  hotbarNext: 'Weapon next',
  pause: 'Pause',
}

export const defaultButtonMap = (): ButtonMap => defaultButtons()

/** W3C standard-layout names; anything past the spec'd 16 is an exotic index. */
const BUTTON_NAMES = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'L2',
  'R2',
  'Back',
  'Start',
  'L3',
  'R3',
  'D-Up',
  'D-Down',
  'D-Left',
  'D-Right',
]

export const buttonName = (i: number): string => BUTTON_NAMES[i] ?? `Button ${i}`

/** 'A · RB · L2 · R2', or an em-dash for an unbound action. */
export const bindingLabel = (buttons: readonly number[]): string =>
  buttons.length === 0 ? '—' : buttons.map(buttonName).join(' · ')

/** Sanity ceiling on a button index we'll store. Generous — exotic pads report
 * high indices — but bounded so garbage can't bloat the map. */
const MAX_BUTTON = 63
const MAX_PER_ACTION = 16

const validButtons = (v: unknown): number[] | null => {
  if (!Array.isArray(v) || v.length > MAX_PER_ACTION) return null
  const out: number[] = []
  for (const b of v) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > MAX_BUTTON) return null
    if (!out.includes(b)) out.push(b)
  }
  return out
}

/** Parse persisted (or arbitrary) data into a valid ButtonMap. All-or-nothing:
 * wrong version, missing action, or any invalid entry → full defaults. */
export const clampButtonMap = (raw: unknown): ButtonMap => {
  const base = defaultButtonMap()
  if (typeof raw !== 'object' || raw === null) return base
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || typeof r.map !== 'object' || r.map === null) return base
  const m = r.map as Record<string, unknown>
  const out = {} as ButtonMap
  for (const a of PAD_ACTIONS) {
    const v = validButtons(m[a])
    if (v === null) return base
    out[a] = v
  }
  return out
}

/**
 * Bind `button` as the ONLY button for `action`. If another action currently
 * owns that button, the two actions SWAP: the other action takes this action's
 * previous buttons (which may be several — swap attack away and the displaced
 * action inherits A/RB/L2/R2 — or none, leaving it unbound). Rebinding an
 * action to one of its own buttons narrows it to just that button.
 * Pure; returns a new map (or the same map for a no-op/invalid button).
 */
export const bindButton = (map: ButtonMap, action: PadAction, button: number): ButtonMap => {
  if (!Number.isInteger(button) || button < 0 || button > MAX_BUTTON) return map
  const prev = map[action]
  if (prev.length === 1 && prev[0] === button) return map
  const next: ButtonMap = { ...map, [action]: [button] }
  const other = PAD_ACTIONS.find((a) => a !== action && map[a].includes(button))
  if (other) next[other] = [...prev]
  return next
}

/** Restore one action's DEFAULT buttons, reclaiming them: any other action
 * holding one of those defaults loses it (and may end up unbound — visible in
 * the UI, fixable by its own reset). Pure; returns a new map. */
export const resetAction = (map: ButtonMap, action: PadAction): ButtonMap => {
  const def = defaultButtonMap()[action]
  const next = {} as ButtonMap
  for (const a of PAD_ACTIONS) next[a] = a === action ? def : map[a].filter((b) => !def.includes(b))
  return next
}

const STORAGE_KEY = 'sporefall.padmap'
/** Pre-rebrand key, read-migrated once into STORAGE_KEY. */
const LEGACY_STORAGE_KEY = 'sor.padmap'

export const loadButtonMap = (): ButtonMap => {
  try {
    if (typeof localStorage === 'undefined') return defaultButtonMap()
    migrateLegacyKey(localStorage, STORAGE_KEY, LEGACY_STORAGE_KEY)
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultButtonMap()
    return clampButtonMap(JSON.parse(raw))
  } catch {
    return defaultButtonMap()
  }
}

export const saveButtonMap = (map: ButtonMap): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, map: clampButtonMap({ v: 1, map }) }))
  } catch {
    // Private-mode / quota failures are non-fatal; the map just won't persist.
  }
}

const mapsEqual = (a: ButtonMap, b: ButtonMap): boolean =>
  PAD_ACTIONS.every((k) => a[k].length === b[k].length && a[k].every((v, i) => v === b[k][i]))

// Live cache so remapProfile is cheap enough to call per pad per frame, and a
// dirty flag so the (overwhelmingly common) all-defaults case costs nothing.
let current: ButtonMap | null = null
let dirty = false

const refreshDirty = (): void => {
  dirty = !mapsEqual(current!, defaultButtonMap())
}

export const getButtonMap = (): ButtonMap => {
  if (current === null) {
    current = loadButtonMap()
    refreshDirty()
  }
  return current
}

/** Set + persist the user map. The next gamepad poll reads through it — no
 * reload, no event plumbing. */
export const setButtonMap = (map: ButtonMap): void => {
  current = clampButtonMap({ v: 1, map })
  refreshDirty()
  saveButtonMap(current)
}

/** Test seam: drop the in-module cache so the next getButtonMap() re-reads
 * localStorage. */
export const resetButtonMapCacheForTest = (): void => {
  current = null
  dirty = false
}

/**
 * The read-path overlay: the user's button map layered over a resolved
 * profile. Buttons only — kind, moveAxes, aimAxes, hatAxis and dpad pass
 * through untouched, so no remap can ever grant an axis the profile refused to
 * trust or move the player off a face button. Joining (padJoin.ts: any button,
 * or a proven stick push) is independent of this overlay entirely.
 */
export const remapProfile = (profile: PadProfile): PadProfile => {
  const m = getButtonMap()
  if (!dirty) return profile
  return {
    ...profile,
    attack: m.attack,
    interact: m.interact,
    special: m.special,
    roll: m.roll,
    pause: m.pause,
    throw: m.throw,
    hotbarPrev: m.hotbarPrev,
    hotbarNext: m.hotbarNext,
  }
}

// ---------------------------------------------------------------------------
// Capture inertness. While the settings panel is listening for a button press
// to bind, gameplay must not see the pad AT ALL: the captured press must not
// fire the action it used to be bound to (or is about to be bound to), must
// not pause, and must not press-to-join an unassigned pad. gamepadCoop checks
// this flag each sample and presents every pad as idle (while still recording
// real states, so releasing the captured button never edge-fires anything).
// Same shape as the join-press rule: the press is SPENT on the meta action.
// ---------------------------------------------------------------------------

let capturing = false

export const setPadCapture = (on: boolean): void => {
  capturing = on
}

export const isPadCaptureActive = (): boolean => capturing
