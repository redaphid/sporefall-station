import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../game/types'
import {
  addHitstop,
  decayShake,
  decayTint,
  decayVignette,
  HITSTOP_MAX,
  hitstopForEvent,
  LOW_HP,
  lowHealthPulse,
  lowHealthVignette,
  type SelfVitals,
  SHAKE_MAX,
  shakeForEvent,
  stackShake,
  tickHitstop,
  tintForEvent,
  VIGNETTE_MAX,
} from './juice'

describe('shake', () => {
  it('stacks additively but clamps to SHAKE_MAX', () => {
    expect(stackShake(0.1, 0.2)).toBeCloseTo(0.3)
    expect(stackShake(0.4, 0.4)).toBe(SHAKE_MAX)
    expect(stackShake(SHAKE_MAX, 1)).toBe(SHAKE_MAX)
  })

  it('never goes below zero when stacking', () => {
    expect(stackShake(-5, 0.1)).toBeCloseTo(0.1)
    expect(stackShake(0, -1)).toBe(0)
  })

  it('decays toward and snaps to exactly zero', () => {
    let mag = 0.5
    for (let i = 0; i < 200; i++) mag = decayShake(mag, 1 / 30)
    expect(mag).toBe(0)
  })

  it('decay is monotonic and non-negative', () => {
    let mag = SHAKE_MAX
    let prev = Infinity
    for (let i = 0; i < 50; i++) {
      mag = decayShake(mag, 1 / 30)
      expect(mag).toBeLessThanOrEqual(prev)
      expect(mag).toBeGreaterThanOrEqual(0)
      prev = mag
    }
  })
})

describe('hitstop', () => {
  it('adds frames clamped to HITSTOP_MAX', () => {
    expect(addHitstop(0, 3)).toBe(3)
    expect(addHitstop(4, 5)).toBe(HITSTOP_MAX)
    expect(addHitstop(HITSTOP_MAX, 2)).toBe(HITSTOP_MAX)
  })

  it('floors fractional and ignores negative additions', () => {
    expect(addHitstop(0, 2.9)).toBe(2)
    expect(addHitstop(2, -5)).toBe(2)
  })

  it('ticks down and never goes negative', () => {
    let f = 3
    f = tickHitstop(f)
    f = tickHitstop(f)
    f = tickHitstop(f)
    expect(f).toBe(0)
    expect(tickHitstop(0)).toBe(0)
    expect(tickHitstop(-2)).toBe(0)
  })
})

describe('vignette + low-health pulse', () => {
  it('fades a flash to zero and clamps at zero', () => {
    expect(decayVignette(0.5, 1)).toBeLessThan(0.5)
    expect(decayVignette(0.01, 1)).toBe(0)
  })

  it('is exactly zero at or above LOW_HP', () => {
    expect(lowHealthPulse(LOW_HP, 0)).toBe(0)
    expect(lowHealthPulse(1, 12.3)).toBe(0)
  })

  it('is positive and bounded when hurt', () => {
    for (let t = 0; t < 10; t += 0.13) {
      const v = lowHealthPulse(0.1, t)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(VIGNETTE_MAX)
    }
    // Near death, peak of the wave approaches the max.
    const peaks = Array.from({ length: 200 }, (_, i) => lowHealthPulse(0.001, i * 0.01))
    expect(Math.max(...peaks)).toBeGreaterThan(VIGNETTE_MAX * 0.9)
  })
})

// #52 — the red-flash-forever gate. The raw pulse screams at any hp ≤ 0, exactly
// the state a downed/dead body holds through the whole bleed-out and at
// game-over. lowHealthVignette suppresses it unless the local player is LIVE.
describe('low-health vignette gate (#52 red-flash-forever)', () => {
  const live = (hpFrac: number): SelfVitals => ({ hpFrac, downed: false, dead: false })

  // A phase where the raw pulse is strongly positive, so any leak is caught.
  const HOT = 1 / (2 * 3) / 2 // quarter-period of the 3Hz pulse → sine near peak

  it('is OFF (0) when there is no local player', () => {
    expect(lowHealthVignette(null, false, HOT)).toBe(0)
    expect(lowHealthVignette(undefined, false, HOT)).toBe(0)
  })

  it('is OFF while DOWNED, even though a downed body sits at hp 0', () => {
    expect(lowHealthVignette({ hpFrac: 0, downed: true, dead: false }, false, HOT)).toBe(0)
  })

  it('is OFF while DEAD (body not yet swept)', () => {
    expect(lowHealthVignette({ hpFrac: 0, downed: false, dead: true }, false, HOT)).toBe(0)
  })

  it('is OFF once the run is over (restart overlay owns the screen)', () => {
    expect(lowHealthVignette(live(0.05), true, HOT)).toBe(0)
    // gameOver wins even for a nominally-live low-hp self.
    expect(lowHealthVignette(live(0.001), true, HOT)).toBe(0)
  })

  it('is ON only for a LIVE, upright, low-health player — and matches the raw pulse', () => {
    const on = lowHealthVignette(live(0.05), false, HOT)
    expect(on).toBeGreaterThan(0)
    expect(on).toBe(lowHealthPulse(0.05, HOT))
  })

  it('a healthy live player still gets no pulse (above LOW_HP)', () => {
    expect(lowHealthVignette(live(0.8), false, HOT)).toBe(0)
  })
})

describe('element tint decay', () => {
  it('fades to zero and clamps', () => {
    expect(decayTint(1, 0.1)).toBeCloseTo(0.88)
    expect(decayTint(0.05, 1)).toBe(0)
  })
})

const hit = (targetId: number, amount: number): SimEvent => ({ type: 'hit', x: 0, y: 0, targetId, amount })

describe('event → shake / hitstop / tint mapping', () => {
  it('shakes harder when it is you being hit', () => {
    expect(shakeForEvent(hit(1, 10), true)).toBeGreaterThan(shakeForEvent(hit(1, 10), false))
  })

  it('does not shake on a zero-damage hit', () => {
    expect(shakeForEvent(hit(1, 0), false)).toBe(0)
  })

  it('explosions shake and carry hitstop', () => {
    const boom: SimEvent = { type: 'explosion', x: 0, y: 0, radius: 3 }
    expect(shakeForEvent(boom, false)).toBeGreaterThan(0)
    expect(hitstopForEvent(boom, false)).toBeGreaterThan(0)
  })

  it('only weighty self-hits earn hitstop', () => {
    expect(hitstopForEvent(hit(1, 25), true)).toBeGreaterThan(0)
    expect(hitstopForEvent(hit(1, 5), true)).toBe(0)
    expect(hitstopForEvent(hit(1, 25), false)).toBe(0)
  })

  it('tints warm on fire, cold on frost, neutral otherwise', () => {
    expect(tintForEvent({ type: 'explosion', x: 0, y: 0, radius: 2 }).warm).toBeGreaterThan(0)
    expect(tintForEvent({ type: 'shatter', x: 0, y: 0, entityId: 1 }).cold).toBeGreaterThan(0)
    expect(tintForEvent(hit(1, 5))).toEqual({ warm: 0, cold: 0 })
  })
})
