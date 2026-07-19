/**
 * Pure show/hide policy for the on-screen touch controls (virtual sticks,
 * action buttons, hotbar). DOM-free so the whole rule matrix is unit-testable;
 * main.ts feeds it one frame of facts and applies the verdict to touch.ts.
 *
 * THE RULE — "last actor wins, pad wins ties":
 *
 *   The device is shared on a couch. Whoever supplied input MOST RECENTLY is
 *   the current player, and the on-screen controls exist only for a touch
 *   player, so:
 *
 *   - No touch capability → never visible. (Pure desktop: keyboard/pads only.)
 *   - A joined pad producing input → hidden. Merely CONNECTED pads don't count
 *     (a pad plugged in at boot, or left idle on the table, must not steal the
 *     phone player's controls) — "in use" means it press-to-joined a player
 *     slot, and joining is itself a button press, so joining hides instantly.
 *   - A finger on the screen → visible again, until the pad NEXT produces
 *     input. This is the couch rule: handing the phone over needs no menu —
 *     touching it is the claim. The same press also flows to whatever is under
 *     it (the controls were hidden, hence hit-test-inert), which is fine: the
 *     first touch is a wake-up, the next ones land on live sticks.
 *   - Both in the same frame → the pad wins. The pad player is mid-action;
 *     a stray palm on the screen must not pop controls over their fight.
 *   - Every joined pad gone (unplugged) → back to the boot default below.
 *
 *   Boot default (no actor yet): visible only when the PRIMARY pointer is
 *   coarse (a phone/tablet). A touch-CAPABLE laptop keeps them hidden until a
 *   finger actually touches the screen — its primary input is the mouse, and
 *   "I don't want virtual joysticks on desktop" includes touchscreen desktops.
 */

import type { CoopDebugPad } from './gamepadCoop'
import type { PadState } from './readPad'

export interface TouchCaps {
  /** The hardware can produce touches at all (navigator.maxTouchPoints > 0). */
  touchCapable: boolean
  /** The PRIMARY pointer is coarse — a phone/tablet, not a touchscreen laptop. */
  coarsePrimary: boolean
}

/** Capability detection, injectable for tests. No user-agent sniffing. */
export const detectTouchCaps = (
  nav: { maxTouchPoints: number },
  matchMedia?: (q: string) => { matches: boolean },
): TouchCaps => ({
  touchCapable: nav.maxTouchPoints > 0,
  coarsePrimary: matchMedia?.('(pointer: coarse)').matches ?? false,
})

/** Who supplied input most recently. null = nobody yet (boot default rules). */
export type LastActor = 'touch' | 'pad' | null

export interface StickVisibilityState {
  lastActor: LastActor
}

export const initialVisibility = (): StickVisibilityState => ({ lastActor: null })

/** One frame of facts, gathered by the caller. */
export interface VisibilityFrame {
  /** Any pad currently holds a player slot (press-to-joined). */
  padJoined: boolean
  /** Any JOINED pad produced real input this frame (stick deflected past its
   * deadzone, or any button held). Idle-but-joined pads contribute nothing. */
  padActivity: boolean
  /** A finger went down on the screen since the last frame. */
  touchActivity: boolean
}

export const stepVisibility = (state: StickVisibilityState, frame: VisibilityFrame): StickVisibilityState => {
  if (frame.padActivity) return { lastActor: 'pad' } // pad wins ties (see header)
  if (frame.touchActivity) return { lastActor: 'touch' }
  // The pad that hid the controls is gone (all joined pads unplugged): forget
  // it — a phone shows its controls again, a laptop stays bare until touched.
  if (state.lastActor === 'pad' && !frame.padJoined) return { lastActor: null }
  return state
}

export const sticksVisible = (state: StickVisibilityState, caps: TouchCaps): boolean => {
  if (!caps.touchCapable) return false
  if (state.lastActor === 'pad') return false
  if (state.lastActor === 'touch') return true
  return caps.coarsePrimary
}

/** Is this PadState actually saying something? (readPad already deadzones the
 * axes, so any non-zero reading is a real deflection.) */
export const padStateActive = (s: PadState): boolean =>
  s.moveX !== 0 ||
  s.moveY !== 0 ||
  s.aimX !== 0 ||
  s.aimY !== 0 ||
  s.attack ||
  s.interact ||
  s.special ||
  s.roll ||
  s.pause ||
  s.throwItem ||
  s.hotbarPrev ||
  s.hotbarNext

/** Any JOINED pad producing input this frame. Connected-but-unjoined pads are
 * ignored even when their buttons are held — they aren't playing yet. */
export const anyPadProducing = (pads: readonly CoopDebugPad[]): boolean =>
  pads.some((p) => p.slot !== null && padStateActive(p.state))
