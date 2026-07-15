import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { MODS } from '../data/mods'
import type { WeaponMod } from '../entity'
import { resolveWeapon } from './resolveWeapon'

const pistol = WEAPONS.pistol
const shotgun = WEAPONS.shotgun
const mg = WEAPONS.machinegun

describe('resolveWeapon — vanilla passthrough', () => {
  it('no mods → base stats, no behaviors, no triggers', () => {
    const r = resolveWeapon(pistol, [])
    expect(r.damage).toBe(14)
    expect(r.cooldownTicks).toBe(18)
    expect(r.pellets).toBe(1)
    expect(r.spread).toBe(0)
    expect(r.projectileSpeed).toBe(14)
    expect(r.knockback).toBe(3)
    expect(r.onHit).toBeUndefined()
    expect(r.triggers).toEqual([])
    expect(r.behavior).toEqual({ pierce: 0, bounce: 0, homing: 0, explodeRadius: 0, explodeDamage: 0, split: 0, lifestealFrac: 0 })
  })

  it('undefined mods arg behaves as empty', () => {
    expect(resolveWeapon(pistol)).toEqual(resolveWeapon(pistol, []))
  })

  it('does NOT mutate the immutable base def', () => {
    const snap = JSON.stringify(pistol)
    resolveWeapon(pistol, [{ id: 'overload', stacks: 3 }, { id: 'bulk', stacks: 2 }])
    expect(JSON.stringify(pistol)).toBe(snap)
  })
})

describe('resolveWeapon — each STAT mod in isolation', () => {
  it('bulk: +2 pellets, ×0.8 damage, +spread', () => {
    const r = resolveWeapon(pistol, [{ id: 'bulk', stacks: 1 }])
    expect(r.pellets).toBe(3) // 1 + 2
    expect(r.damage).toBe(Math.round(14 * 0.8)) // 11
    expect(r.spread).toBeCloseTo(0.12)
  })

  it('overload: ×1.25 damage (compounding) + downside cooldown', () => {
    expect(resolveWeapon(pistol, [{ id: 'overload', stacks: 1 }]).damage).toBe(Math.round(14 * 1.25)) // 18
    expect(resolveWeapon(pistol, [{ id: 'overload', stacks: 2 }]).damage).toBe(Math.round(14 * 1.25 ** 2)) // 22
    expect(resolveWeapon(pistol, [{ id: 'overload', stacks: 1 }]).cooldownTicks).toBe(Math.ceil(18 * 1.08)) // 20
  })

  it('rapid: faster fire (lower cooldown)', () => {
    expect(resolveWeapon(mg, [{ id: 'rapid', stacks: 1 }]).cooldownTicks).toBe(Math.ceil(5 * 0.8)) // 4
  })

  it('choke: tightens shotgun spread', () => {
    expect(resolveWeapon(shotgun, [{ id: 'choke', stacks: 1 }]).spread).toBeCloseTo(0.5 * 0.6)
  })
})

describe('resolveWeapon — each BEHAVIOR mod in isolation', () => {
  it('pierce sets pierce count', () => {
    expect(resolveWeapon(pistol, [{ id: 'pierce', stacks: 3 }]).behavior.pierce).toBe(3)
  })
  it('bounce sets bounce count (2 per stack)', () => {
    expect(resolveWeapon(pistol, [{ id: 'bounce', stacks: 2 }]).behavior.bounce).toBe(4)
  })
  it('frost adds frozen onHit', () => {
    expect(resolveWeapon(pistol, [{ id: 'frost', stacks: 1 }]).onHit).toEqual({ status: 'frozen', ticks: 120 })
  })
  it('incendiary adds burning onHit', () => {
    expect(resolveWeapon(pistol, [{ id: 'incendiary', stacks: 1 }]).onHit).toEqual({ status: 'burning', ticks: 240 })
  })
  it('explosive sets explode radius + damage', () => {
    const b = resolveWeapon(pistol, [{ id: 'explosive', stacks: 1 }]).behavior
    expect(b.explodeRadius).toBeCloseTo(1.6)
    expect(b.explodeDamage).toBe(14)
  })
  it('homing sets a positive turn rate', () => {
    expect(resolveWeapon(pistol, [{ id: 'homing', stacks: 1 }]).behavior.homing).toBeGreaterThan(0)
  })
  it('split sets a child count', () => {
    expect(resolveWeapon(pistol, [{ id: 'split', stacks: 2 }]).behavior.split).toBe(4)
  })
})

describe('resolveWeapon — TRIGGER mods', () => {
  it('detonator yields an on-kill explode trigger scaled by stacks', () => {
    const r = resolveWeapon(pistol, [{ id: 'detonator', stacks: 2 }])
    expect(r.triggers).toHaveLength(1)
    expect(r.triggers[0].event).toBe('kill')
    expect(r.triggers[0].explode).toEqual({ radius: 2, damage: 24 * 2 })
  })
})

describe('resolveWeapon — order independence (the key invariant)', () => {
  const set: WeaponMod[] = [
    { id: 'bulk', stacks: 2 },
    { id: 'overload', stacks: 1 },
    { id: 'frost', stacks: 1 },
    { id: 'bounce', stacks: 1 },
    { id: 'pierce', stacks: 2 },
  ]
  it('any pick order → identical ResolvedWeapon', () => {
    const a = resolveWeapon(shotgun, set)
    const b = resolveWeapon(shotgun, [...set].reverse())
    const c = resolveWeapon(shotgun, [set[2], set[0], set[4], set[1], set[3]])
    expect(a).toEqual(b)
    expect(a).toEqual(c)
  })
})

describe('resolveWeapon — conflicting / duplicate mods', () => {
  it('choke vs bulk spread net out deterministically', () => {
    const r = resolveWeapon(shotgun, [{ id: 'bulk', stacks: 1 }, { id: 'choke', stacks: 1 }])
    // add spread 0.5+0.12 = 0.62, then ×0.6 = 0.372
    expect(r.spread).toBeCloseTo((0.5 + 0.12) * 0.6)
  })
  it('duplicate mod entries: registry sort makes it order-independent', () => {
    const a = resolveWeapon(pistol, [{ id: 'overload', stacks: 2 }])
    // two separate entries do NOT merge (draft/addMod merge them), but a single
    // entry with the same total stacks is the canonical form.
    expect(a.damage).toBe(Math.round(14 * 1.25 ** 2))
  })
})

describe('resolveWeapon — huge stacks: finite, clamped, no NaN', () => {
  const assertFinite = (r: ReturnType<typeof resolveWeapon>): void => {
    for (const v of [r.damage, r.cooldownTicks, r.pellets, r.spread, r.projectileSpeed, r.knockback]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    for (const v of Object.values(r.behavior)) expect(Number.isFinite(v)).toBe(true)
  }

  it('overload ×1000 is capped at maxStacks (5), damage stays finite', () => {
    const r = resolveWeapon(pistol, [{ id: 'overload', stacks: 1000 }])
    expect(r.damage).toBe(Math.round(14 * 1.25 ** (MODS.overload.maxStacks ?? 5))) // 43
    assertFinite(r)
  })

  it('rapid ×1000 floors cooldown at ≥1 (never divide-by-zero)', () => {
    const r = resolveWeapon(mg, [{ id: 'rapid', stacks: 1000 }])
    expect(r.cooldownTicks).toBeGreaterThanOrEqual(1)
    assertFinite(r)
  })

  it('bulk ×1000 clamps pellets to the cap', () => {
    const r = resolveWeapon(shotgun, [{ id: 'bulk', stacks: 1000 }])
    expect(r.pellets).toBeLessThanOrEqual(32)
    expect(r.pellets).toBeGreaterThanOrEqual(1)
    assertFinite(r)
  })

  it('bounce/pierce/split ×1000 clamp to the behavior cap', () => {
    const r = resolveWeapon(pistol, [
      { id: 'bounce', stacks: 1000 },
      { id: 'pierce', stacks: 1000 },
      { id: 'split', stacks: 1000 },
    ])
    expect(r.behavior.bounce).toBeLessThanOrEqual(50)
    expect(r.behavior.pierce).toBeLessThanOrEqual(50)
    expect(r.behavior.split).toBeLessThanOrEqual(50)
    assertFinite(r)
  })

  it('lifesteal is hyperbolic: approaches but NEVER reaches 100% at 1000 stacks', () => {
    const r = resolveWeapon(pistol, [{ id: 'lifesteal', stacks: 1000 }])
    expect(r.behavior.lifestealFrac).toBeGreaterThan(0)
    expect(r.behavior.lifestealFrac).toBeLessThan(0.95)
    expect(Number.isFinite(r.behavior.lifestealFrac)).toBe(true)
  })

  it('a fully loaded signature build has no NaN/Infinity anywhere', () => {
    const r = resolveWeapon(shotgun, Object.keys(MODS).map((id) => ({ id, stacks: 999 })))
    assertFinite(r)
    expect(r.cooldownTicks).toBeGreaterThanOrEqual(1)
  })
})

describe('resolveWeapon — bad input is ignored', () => {
  it('unknown mod ids are skipped', () => {
    expect(resolveWeapon(pistol, [{ id: 'nope', stacks: 3 }])).toEqual(resolveWeapon(pistol, []))
  })
  it('non-positive stacks are skipped', () => {
    expect(resolveWeapon(pistol, [{ id: 'overload', stacks: 0 }, { id: 'overload', stacks: -5 }])).toEqual(resolveWeapon(pistol, []))
  })
})
