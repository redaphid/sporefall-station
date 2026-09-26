// Named verdicts for the cases a player actually meets. The exhaustive
// display-equals-behaviour sweep lives in modEffect.truth.test.ts.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { MODS } from '../data/mods'
import type { WeaponMod } from '../entity'
import { executedShot, modVerdict } from './modEffect'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })
const verdicts = (weapon: string, sequenced = false): Record<string, string> =>
  Object.fromEntries(
    Object.keys(MODS).map((id) => {
      const v = modVerdict(WEAPONS[weapon], [m(id)], id, sequenced)
      return [id, v.kind === 'live' ? 'live' : `${v.kind}: ${v.reason}`]
    }),
  )

describe('melee (PR #78 inventory: 9 work, 9 silently inert, bulk worse than nothing)', () => {
  it('sledgehammer: bullet mods are inert, Barrage only costs damage', () => {
    expect(verdicts('sledgehammer')).toEqual({
      overload: 'live',
      bulk: 'penalty: only lowers damage',
      rapid: 'live',
      heavy: 'live',
      choke: 'inert: no effect on melee',
      velocity: 'inert: no effect on melee',
      glassCannon: 'live',
      frost: 'live',
      incendiary: 'live',
      shock: 'live',
      bounce: 'inert: no effect on melee',
      pierce: 'inert: no effect on melee',
      homing: 'inert: no effect on melee',
      explosive: 'inert: no effect on melee',
      split: 'inert: no effect on melee',
      splinterShot: 'inert: no effect on melee',
      lifesteal: 'inert: no effect on melee',
      detonator: 'live',
    })
  })

  it('every melee weapon agrees with the sledgehammer on which mods do nothing', () => {
    const inert = (w: string): string[] => Object.entries(verdicts(w)).filter(([, v]) => v.startsWith('inert')).map(([k]) => k)
    for (const w of Object.keys(WEAPONS).filter((id) => WEAPONS[id].kind === 'melee')) expect(inert(w), w).toEqual(inert('sledgehammer'))
  })
})

describe('the pistol every player holds', () => {
  it('every mod works except Choke, which has no fan to tighten', () => {
    const v = verdicts('pistol')
    expect(v.choke).toBe('inert: no effect on this gun')
    expect(Object.entries(v).filter(([, x]) => x !== 'live').map(([k]) => k)).toEqual(['choke'])
  })

  it('Choke comes alive once Barrage turns the shot into a fan', () => {
    expect(modVerdict(WEAPONS.pistol, [m('bulk'), m('choke')], 'choke').kind).toBe('live')
  })

  it('a bullet ignores knockback, so the gun never reports it', () => {
    expect(executedShot(WEAPONS.pistol, [m('heavy', 5)]).knockback).toBeUndefined()
    expect(executedShot(WEAPONS.sledgehammer, [m('heavy')]).knockback).toBeGreaterThan(WEAPONS.sledgehammer.knockback)
  })
})

describe('elements share one slot in default casting', () => {
  it('the losing element reads as overridden, naming the winner', () => {
    const mods = [m('frost'), m('shock')]
    expect(modVerdict(WEAPONS.pistol, mods, 'frost')).toEqual({ kind: 'inert', reason: 'Tesla Rounds overrides it' })
    expect(modVerdict(WEAPONS.pistol, mods, 'shock').kind).toBe('live')
    const three = [m('shock'), m('incendiary'), m('frost')]
    expect(modVerdict(WEAPONS.pistol, three, 'incendiary')).toEqual({ kind: 'inert', reason: 'Tesla Rounds overrides it' })
    expect(modVerdict(WEAPONS.pistol, [m('incendiary'), m('frost')], 'frost')).toEqual({ kind: 'inert', reason: 'Incendiary overrides it' })
  })

  it('sequenced casting fires each element on its own shot, so both are live', () => {
    for (const id of ['frost', 'shock']) expect(modVerdict(WEAPONS.pistol, [m('frost'), m('shock')], id, true).kind).toBe('live')
  })

  it('an element the gun already fires adds nothing', () => {
    expect(modVerdict(WEAPONS.freezeRay, [m('frost')], 'frost')).toEqual({ kind: 'inert', reason: 'no effect on this gun' })
    expect(modVerdict(WEAPONS.flamethrower, [m('incendiary')], 'incendiary').kind).toBe('inert')
    expect(modVerdict(WEAPONS.stunGun, [m('shock')], 'shock').kind).toBe('inert')
  })

  it('a new element on a stunning sledgehammer replaces the stun, which is an effect', () => {
    expect(modVerdict(WEAPONS.sledgehammer, [m('frost')], 'frost').kind).toBe('live')
  })
})

describe('downside-only mods', () => {
  it('Overload on a zero-damage gun only slows it down', () => {
    expect(modVerdict(WEAPONS.freezeRay, [m('overload')], 'overload')).toEqual({ kind: 'penalty', reason: 'only lowers fire rate' })
    expect(modVerdict(WEAPONS.pistol, [m('overload')], 'overload').kind).toBe('live')
  })
})

describe('sequenced casting', () => {
  it('a mod past the live window is stowed and never fires', () => {
    const mods = ['pierce', 'bounce', 'homing', 'split', 'explosive'].map((id) => m(id))
    expect(modVerdict(WEAPONS.pistol, mods, 'explosive', true)).toEqual({ kind: 'inert', reason: 'stowed: swap it in' })
    expect(modVerdict(WEAPONS.pistol, mods, 'explosive', false).kind).toBe('live')
  })

  it('a faster cast that wraps anyway is outlasted by the recharge', () => {
    expect(modVerdict(WEAPONS.pistol, [m('rapid')], 'rapid', true)).toEqual({ kind: 'inert', reason: 'recharge hides it' })
    expect(modVerdict(WEAPONS.pistol, [m('rapid')], 'rapid', false).kind).toBe('live')
  })

  it('a fire-rate mod on a cast that does not wrap still counts', () => {
    expect(modVerdict(WEAPONS.pistol, [m('rapid'), m('frost'), m('shock')], 'rapid', true).kind).toBe('live')
  })
})

describe('degenerate input', () => {
  it('an unknown mod id is inert, never a crash', () => {
    expect(modVerdict(WEAPONS.pistol, [m('bogus')], 'bogus')).toEqual({ kind: 'inert', reason: 'unknown mod' })
  })

  it('a mod not yet on the weapon is judged as if picked up', () => {
    expect(modVerdict(WEAPONS.pistol, [], 'pierce').kind).toBe('live')
    expect(modVerdict(WEAPONS.sledgehammer, [], 'pierce').kind).toBe('inert')
    expect(modVerdict(WEAPONS.pistol, [m('pierce', 0)], 'pierce').kind).toBe('live')
  })

  it('unknown and empty neighbours do not change a verdict', () => {
    const junk = [m('bogus', 3), m('rapid', 0), m('pierce', -2)]
    for (const id of Object.keys(MODS)) {
      for (const seq of [false, true]) {
        expect(modVerdict(WEAPONS.pistol, [...junk, m(id)], id, seq), `${id} ${seq}`).toEqual(modVerdict(WEAPONS.pistol, [m(id)], id, seq))
      }
    }
  })

  it('huge stacks are clamped the way the fire path clamps them', () => {
    expect(modVerdict(WEAPONS.pistol, [m('pierce', 1e9)], 'pierce').kind).toBe('live')
    expect(modVerdict(WEAPONS.sledgehammer, [m('pierce', 1e9)], 'pierce').kind).toBe('inert')
  })

  it('is pure: the same input always gives the same verdict and never mutates the list', () => {
    const mods = [m('frost'), m('shock')]
    const before = JSON.stringify(mods)
    const a = modVerdict(WEAPONS.pistol, mods, 'frost', true)
    expect(modVerdict(WEAPONS.pistol, mods, 'frost', true)).toEqual(a)
    expect(JSON.stringify(mods)).toBe(before)
  })
})
