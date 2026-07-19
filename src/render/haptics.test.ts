import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../game/types'
import type { GameSettings } from '../app/settings'
import { createHaptics, hapticForEvent, type HapticCmd, type HapticDriver } from './haptics'

const SELF = { id: 7 }

describe('hapticForEvent', () => {
  it('getting hit is heavier than landing a hit', () => {
    const hurt = hapticForEvent({ type: 'hit', x: 0, y: 0, targetId: 7, amount: 10 }, SELF)
    const land = hapticForEvent({ type: 'hit', x: 0, y: 0, targetId: 9, amount: 10 }, SELF)
    expect(hurt).toMatchObject({ key: 'hurt', style: 'medium' })
    expect(land).toMatchObject({ key: 'hit', style: 'light' })
  })

  it('scales hit intensity with damage', () => {
    expect(hapticForEvent({ type: 'hit', x: 0, y: 0, targetId: 7, amount: 25 }, SELF)!.style).toBe('heavy')
    expect(hapticForEvent({ type: 'hit', x: 0, y: 0, targetId: 9, amount: 25 }, SELF)!.style).toBe('medium')
  })

  it('ignores zero-damage hits', () => {
    expect(hapticForEvent({ type: 'hit', x: 0, y: 0, targetId: 7, amount: 0 }, SELF)).toBeNull()
  })

  it('maps my death to a heavy distinct pattern and others to medium', () => {
    expect(hapticForEvent({ type: 'death', x: 0, y: 0, entityId: 7 }, SELF)).toMatchObject({
      key: 'death-self',
      style: 'heavy',
      vibrateMs: 120,
    })
    expect(hapticForEvent({ type: 'death', x: 0, y: 0, entityId: 3 }, SELF)).toMatchObject({ style: 'medium' })
  })

  it('maps explosion / shatter / shock to distinct heavy-ish patterns', () => {
    expect(hapticForEvent({ type: 'explosion', x: 0, y: 0, radius: 3 }, SELF)).toMatchObject({ key: 'explosion', vibrateMs: 70 })
    expect(hapticForEvent({ type: 'shatter', x: 0, y: 0, entityId: 1 }, SELF)).toMatchObject({ key: 'shatter', vibrateMs: 40 })
    expect(hapticForEvent({ type: 'shock', x: 0, y: 0, targetId: 1 }, SELF)).toMatchObject({ key: 'shock', vibrateMs: 30 })
  })

  it('only buzzes on my own pickups', () => {
    expect(hapticForEvent({ type: 'pickup', entityId: 1, byId: 7, itemId: 'cash' }, SELF)).toMatchObject({ key: 'pickup' })
    expect(hapticForEvent({ type: 'pickup', entityId: 1, byId: 2, itemId: 'cash' }, SELF)).toBeNull()
  })

  it('maps mission-complete and floor-change', () => {
    expect(hapticForEvent({ type: 'missionComplete', description: 'x' }, SELF)).toMatchObject({ key: 'mission' })
    expect(hapticForEvent({ type: 'floorChange', floor: 2 }, SELF)).toMatchObject({ key: 'floor', style: 'light' })
  })

  it('ignores events with no tasteful buzz', () => {
    const ignored: SimEvent[] = [
      { type: 'doorToggle', entityId: 1, open: true },
      { type: 'use', entityId: 1, byId: 2 },
      { type: 'noise', x: 0, y: 0 },
      { type: 'runOver', floor: 1 },
    ]
    for (const ev of ignored) expect(hapticForEvent(ev, SELF)).toBeNull()
  })
})

// --- runtime: debounce, guards ---------------------------------------------

interface Harness {
  haptics: ReturnType<typeof createHaptics>
  calls: HapticCmd[]
  setTime: (t: number) => void
  setNative: (n: boolean) => void
  settings: GameSettings
}

const harness = (over: Partial<GameSettings> = {}): Harness => {
  const calls: HapticCmd[] = []
  let time = 1000
  let native = true
  const settings: GameSettings = {
    hapticsEnabled: true,
    hapticsIntensity: 0.7,
    effectsQuality: 'high',
    shaderFx: 'full',
    theme: 'city',
    ...over,
  }
  const driver: HapticDriver = {
    isNative: () => native,
    now: () => time,
    impact: (cmd) => calls.push(cmd),
  }
  return {
    haptics: createHaptics(driver, () => settings),
    calls,
    setTime: (t) => (time = t),
    setNative: (n) => (native = n),
    settings,
  }
}

const boom = (): SimEvent => ({ type: 'explosion', x: 0, y: 0, radius: 3 })

describe('createHaptics runtime', () => {
  it('fires an impact for a mapped event on native', () => {
    const h = harness()
    h.haptics.handle([boom()], SELF)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ key: 'explosion', style: 'heavy' })
  })

  it('NEVER calls the motor when not native', () => {
    const h = harness()
    h.setNative(false)
    h.haptics.handle([boom(), boom(), { type: 'death', x: 0, y: 0, entityId: 7 }], SELF)
    expect(h.calls).toHaveLength(0)
  })

  it('collapses a same-key burst in one tick to a single buzz', () => {
    const h = harness()
    h.haptics.handle([boom(), boom(), boom(), boom()], SELF)
    expect(h.calls).toHaveLength(1)
  })

  it('debounces across ticks by the key gap but allows a later repeat', () => {
    const h = harness()
    h.haptics.handle([boom()], SELF)
    h.setTime(1050) // < KEY_GAP_MS later
    h.haptics.handle([boom()], SELF)
    expect(h.calls).toHaveLength(1)
    h.setTime(1200) // well past the gap
    h.haptics.handle([boom()], SELF)
    expect(h.calls).toHaveLength(2)
  })

  it('drops distinct-key events that arrive inside the global gap', () => {
    const h = harness()
    h.haptics.handle([boom()], SELF) // fires at t=1000
    h.setTime(1010) // < GLOBAL_GAP_MS
    h.haptics.handle([{ type: 'pickup', entityId: 1, byId: 7, itemId: 'cash' }], SELF)
    expect(h.calls).toHaveLength(1)
  })

  it('stays silent when haptics disabled or intensity is zero', () => {
    const off = harness({ hapticsEnabled: false })
    off.haptics.handle([boom()], SELF)
    expect(off.calls).toHaveLength(0)

    const mute = harness({ hapticsIntensity: 0 })
    mute.haptics.handle([boom()], SELF)
    expect(mute.calls).toHaveLength(0)
  })

  it('ignores unmapped events without firing', () => {
    const h = harness()
    h.haptics.handle([{ type: 'noise', x: 0, y: 0 }, { type: 'doorToggle', entityId: 1, open: true }], SELF)
    expect(h.calls).toHaveLength(0)
  })
})
