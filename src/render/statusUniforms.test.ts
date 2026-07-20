// Adversarial coverage of the status-effect shader grammar (statusUniforms.ts):
// the pure map from a character's active statuses + the applying weapon's mods
// to the float uniforms that drive the per-character GPU shaders.
//   - no statuses → all-zero uniforms + no quads (renderer attaches nothing);
//   - each status → its intended effect branch; unknown ids fall back safely
//     (so the incoming `spore` status can never crash / draw a broken filter);
//   - intensity is MONOTONIC in the driving mod's stack count and bounded < 1;
//   - the effect hue matches the driving mod's pickup colour;
//   - multiple statuses compose independently.

import { describe, expect, it } from 'vitest'
import type { WeaponMod } from '../game/entity'
import { modPickupColor } from './modColors'
import {
  composeStatus,
  EFFECT,
  STATUS_BASE,
  STATUS_SHADERS,
  statusIntensity,
} from './statusUniforms'

type Fx = Record<string, { until: number; source?: number }>

const NO_MODS = (): undefined => undefined
const withMods =
  (mods: WeaponMod[]) =>
  (): readonly WeaponMod[] =>
    mods
const fx = (ids: string[], source?: number): Fx =>
  Object.fromEntries(ids.map((id) => [id, { until: 100, source }]))

const allFinite = (c: ReturnType<typeof composeStatus>): void => {
  for (const [k, v] of Object.entries(c.uniforms)) expect(Number.isFinite(v), `uniform ${k}`).toBe(true)
  expect(Number.isFinite(c.energy)).toBe(true)
  for (const q of c.quads) {
    expect(Number.isFinite(q.intensity), `quad ${q.statusId} intensity`).toBe(true)
    expect(Number.isFinite(q.effect)).toBe(true)
  }
}

describe('composeStatus — no active statuses', () => {
  it('undefined fx → all-zero uniforms, no quads, no colour', () => {
    const c = composeStatus(undefined, NO_MODS)
    expect(c.uniforms).toEqual({ shock: 0, burn: 0, frost: 0, poison: 0, wet: 0 })
    expect(c.quads).toEqual([])
    expect(c.energy).toBe(0)
    expect(c.color).toBe(0)
  })

  it('empty fx {} → nothing attaches', () => {
    const c = composeStatus({}, NO_MODS)
    expect(c.quads.length).toBe(0)
    expect(c.energy).toBe(0)
  })
})

describe('statusIntensity — monotonic & bounded', () => {
  it('0 stacks → the base intensity', () => {
    expect(statusIntensity(0)).toBeCloseTo(STATUS_BASE, 10)
  })

  it('strictly increases with each added stack and never reaches 1', () => {
    let prev = statusIntensity(0)
    for (let s = 1; s <= 12; s++) {
      const cur = statusIntensity(s)
      expect(cur, `stacks=${s} must exceed ${s - 1}`).toBeGreaterThan(prev)
      expect(cur).toBeLessThan(1)
      prev = cur
    }
  })

  it('sanitizes degenerate stack counts (negative/fractional/NaN → base)', () => {
    expect(statusIntensity(-3)).toBeCloseTo(STATUS_BASE, 10)
    expect(statusIntensity(0.9)).toBeCloseTo(STATUS_BASE, 10) // floors to 0
    expect(statusIntensity(Number.NaN)).toBeCloseTo(STATUS_BASE, 10)
    expect(statusIntensity(1.9)).toBeCloseTo(statusIntensity(1), 10) // floors to 1
  })
})

describe('composeStatus — shock scales with Tesla mods', () => {
  it('uShock rises monotonically with the shock-mod stack count', () => {
    const uShock = (stacks: number): number =>
      composeStatus(fx(['electrified'], 7), withMods(stacks > 0 ? [{ id: 'shock', stacks }] : [])).uniforms.shock
    const s0 = uShock(0)
    const s1 = uShock(1)
    const s2 = uShock(2)
    const s3 = uShock(3)
    expect(s0).toBeCloseTo(STATUS_BASE, 10)
    expect(s1).toBeGreaterThan(s0)
    expect(s2).toBeGreaterThan(s1)
    expect(s3).toBeGreaterThan(s2)
    // Only the shock uniform lit; the rest stay zero.
    const c = composeStatus(fx(['electrified'], 7), withMods([{ id: 'shock', stacks: 3 }]))
    expect(c.uniforms.burn).toBe(0)
    expect(c.uniforms.frost).toBe(0)
  })

  it('a non-matching mod on the weapon does NOT amplify the status', () => {
    // Electrified victim, but the shooter carries incendiary (not shock) mods:
    // the lightning shows at base, unmoved by the unrelated stacks.
    const c = composeStatus(fx(['electrified'], 7), withMods([{ id: 'incendiary', stacks: 5 }]))
    expect(c.uniforms.shock).toBeCloseTo(STATUS_BASE, 10)
  })

  it('an NPC / bare-weapon source (no mods) shows the base look', () => {
    const c = composeStatus(fx(['electrified'], 9), NO_MODS)
    expect(c.uniforms.shock).toBeCloseTo(STATUS_BASE, 10)
  })
})

describe('composeStatus — effect hue tracks the driving mod', () => {
  it('a shock-driven bolt is coloured by modPickupColor(shock)', () => {
    const c = composeStatus(fx(['electrified'], 7), withMods([{ id: 'shock', stacks: 2 }]))
    expect(c.quads[0].color).toBe(modPickupColor('shock'))
    expect(c.color).toBe(modPickupColor('shock'))
  })

  it('a burn driven by incendiary is coloured by modPickupColor(incendiary)', () => {
    const c = composeStatus(fx(['burning'], 7), withMods([{ id: 'incendiary', stacks: 1 }]))
    expect(c.quads[0].color).toBe(modPickupColor('incendiary'))
  })

  it('with no driving mod it uses the status canonical hue', () => {
    const c = composeStatus(fx(['electrified'], 7), NO_MODS)
    expect(c.quads[0].color).toBe(STATUS_SHADERS.electrified.color)
  })
})

describe('composeStatus — status → effect branch mapping', () => {
  const cases: [string, number][] = [
    ['electrified', EFFECT.lightning],
    ['burning', EFFECT.fire],
    ['frozen', EFFECT.frost],
    ['poisoned', EFFECT.poison],
    ['wet', EFFECT.wet],
  ]
  for (const [id, effect] of cases) {
    it(`${id} → effect ${effect}`, () => {
      const c = composeStatus(fx([id], 1), NO_MODS)
      expect(c.quads).toHaveLength(1)
      expect(c.quads[0].effect).toBe(effect)
      allFinite(c)
    })
  }
})

describe('composeStatus — unknown / new statuses fall back safely', () => {
  it('the incoming `spore` status reads as a poison miasma', () => {
    const c = composeStatus(fx(['spore'], 1), NO_MODS)
    expect(c.quads).toHaveLength(1)
    expect(c.quads[0].effect).toBe(EFFECT.poison)
    allFinite(c)
  })

  it('a totally unrecognised status id still produces a finite fallback quad', () => {
    const c = composeStatus(fx(['cursed_by_a_future_branch'], 1), NO_MODS)
    expect(c.quads).toHaveLength(1)
    expect(c.quads[0].effect).toBe(EFFECT.poison) // fallback miasma
    // It touches none of the five named uniforms — those stay zero.
    expect(c.uniforms).toEqual({ shock: 0, burn: 0, frost: 0, poison: 0, wet: 0 })
    allFinite(c)
  })
})

describe('composeStatus — multiple statuses compose independently', () => {
  it('electrified + burning → two quads, both named uniforms set side by side', () => {
    const c = composeStatus(
      fx(['electrified', 'burning'], 7),
      withMods([
        { id: 'shock', stacks: 3 },
        { id: 'incendiary', stacks: 1 },
      ]),
    )
    expect(c.quads).toHaveLength(2)
    const byId = Object.fromEntries(c.quads.map((q) => [q.statusId, q]))
    expect(byId.electrified.effect).toBe(EFFECT.lightning)
    expect(byId.burning.effect).toBe(EFFECT.fire)
    // Shock (3 stacks) outshines burn (1 stack) — energy/colour follow the max.
    expect(c.uniforms.shock).toBeGreaterThan(c.uniforms.burn)
    expect(c.uniforms.frost).toBe(0)
    expect(c.uniforms.wet).toBe(0)
    expect(c.energy).toBeCloseTo(c.uniforms.shock, 10)
    expect(c.color).toBe(modPickupColor('shock'))
    allFinite(c)
  })

  it('composition is independent of fx key order (replay-stable)', () => {
    const a = composeStatus(fx(['burning', 'frozen', 'wet'], 1), NO_MODS)
    const b = composeStatus(fx(['wet', 'burning', 'frozen'], 1), NO_MODS)
    expect(a.quads.map((q) => q.statusId)).toEqual(b.quads.map((q) => q.statusId))
    expect(a.uniforms).toEqual(b.uniforms)
  })
})
