/**
 * Tasteful vibration driven off sim events. The event → pattern mapping is a
 * pure function (`hapticForEvent`) so it can be exhaustively unit-tested, and
 * the runtime side (`createHaptics`) takes an injected driver so tests can run
 * with no native platform and assert exactly what would fire. Every real call
 * is native-guarded by the driver, so web/desktop is a silent no-op.
 */

import type { EntityId, SimEvent } from '../game/types'
import type { GameSettings } from '../app/settings'

export type HapticStyle = 'light' | 'medium' | 'heavy'

export interface HapticCmd {
  /** Debounce bucket — bursts of the same key collapse to one buzz. */
  key: string
  style: HapticStyle
  /** Optional extra buzz (ms) for distinct patterns (explosion/shatter/stun). */
  vibrateMs?: number
}

/** Who the local player is, so "you got hit" can hit harder than "you hit". */
export interface HapticSelf {
  id: EntityId
}

/**
 * Map one sim event to a haptic pulse, or null to stay silent. Only REAL event
 * types from game/types.ts are handled; everything else (doorToggle, use,
 * noise, runOver, pickup-by-others) is intentionally ignored to keep it tasteful.
 */
export const hapticForEvent = (ev: SimEvent, self?: HapticSelf): HapticCmd | null => {
  switch (ev.type) {
    case 'hit': {
      if (ev.amount <= 0) return null // door-nudge / zero-damage taps don't buzz
      const mine = self != null && ev.targetId === self.id
      // Getting hit is heavier than landing one; big hits ramp up.
      if (mine) return { key: 'hurt', style: ev.amount >= 20 ? 'heavy' : 'medium' }
      return { key: 'hit', style: ev.amount >= 20 ? 'medium' : 'light' }
    }
    case 'death': {
      const mine = self != null && ev.entityId === self.id
      return mine
        ? { key: 'death-self', style: 'heavy', vibrateMs: 120 }
        : { key: 'death', style: 'medium' }
    }
    case 'explosion':
      return { key: 'explosion', style: 'heavy', vibrateMs: 70 }
    case 'shatter':
      return { key: 'shatter', style: 'heavy', vibrateMs: 40 }
    case 'shock':
      return { key: 'shock', style: 'medium', vibrateMs: 30 }
    case 'pickup':
      // Only my own pickups buzz.
      return self != null && ev.byId === self.id ? { key: 'pickup', style: 'light' } : null
    case 'missionComplete':
      return { key: 'mission', style: 'medium', vibrateMs: 90 }
    case 'floorChange':
      return { key: 'floor', style: 'light' }
    case 'roll':
      // Only my own roll buzzes — a light tap on the dodge's kick-off.
      return self != null && ev.entityId === self.id ? { key: 'roll', style: 'light' } : null
    default:
      return null
  }
}

/** The side-effecting surface — real impl wraps @capacitor/haptics; tests pass
 * a spy. `isNative` gates EVERY buzz so non-phone platforms never call in. */
export interface HapticDriver {
  isNative(): boolean
  impact(cmd: HapticCmd, intensity: number): void
  now(): number
}

/** Min ms between any two buzzes so an event storm can't machine-gun the motor. */
const GLOBAL_GAP_MS = 55
/** Min ms between two buzzes sharing a key (e.g. rapid-fire hits). */
const KEY_GAP_MS = 90

export interface Haptics {
  /** Feed a tick's events (call once per sim tick, like Sound.handle). */
  handle(events: readonly SimEvent[], self?: HapticSelf): void
}

/**
 * Wire the pure mapping + debounce to a driver. No native/settings work happens
 * unless a buzz actually clears the guards, so this is cheap on every platform.
 */
export const createHaptics = (driver: HapticDriver, getSettings: () => GameSettings): Haptics => {
  let lastAny = -Infinity
  const lastByKey = new Map<string, number>()

  const fire = (cmd: HapticCmd): void => {
    const settings = getSettings()
    if (!settings.hapticsEnabled || settings.hapticsIntensity <= 0) return
    if (!driver.isNative()) return
    const t = driver.now()
    if (t - lastAny < GLOBAL_GAP_MS) return
    if (t - (lastByKey.get(cmd.key) ?? -Infinity) < KEY_GAP_MS) return
    lastAny = t
    lastByKey.set(cmd.key, t)
    driver.impact(cmd, settings.hapticsIntensity)
  }

  return {
    handle(events, self): void {
      for (const ev of events) {
        const cmd = hapticForEvent(ev, self)
        if (cmd) fire(cmd)
      }
    },
  }
}
