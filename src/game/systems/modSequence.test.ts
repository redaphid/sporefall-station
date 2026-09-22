// Sequenced mod casting: drive the REAL fire path (combatSystem / tickWorld)
// with exact world state and assert which mod each shot carried.
//
// Fixture note: the loadouts are named after what a maintenance crew might have
// left in the corridor lockers. The names are flavour only; each test says what
// it checks.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import type { Entity, WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { arm } from '../testkit'
import { combatSystem } from './combat'
import {
  applyModSwap,
  isPayloadMod,
  liveEntries,
  packModSwap,
  pelletShares,
  planCasts,
  sequenceShape,
  unpackModSwap,
} from './modSequence'
import { weaponStack } from './inventory'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

/** A sequenced world with one player holding `weapon` loaded with `mods`. */
const rig = (weapon: string, mods: WeaponMod[], sequenced = true): { w: World; p: Entity } => {
  const w = createWorld(1, 1)
  if (sequenced) w.modCasting = 'sequence'
  const p = spawnPlayer(w, 0, 20.5, 20.5)
  p.health!.iframes = 0
  p.loadout!.inventory = []
  const stack = arm(p, weapon)
  stack.mods = mods.map((x) => ({ ...x }))
  p.facing = 0
  return { w, p }
}

/** One trigger pull on the combat system with the cooldown cleared. Returns the
 * projectiles it spawned. */
const pull = (w: World, p: Entity): Entity[] => {
  const before = new Set(w.entities.map((e) => e.id))
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  return w.entities.filter((e) => !before.has(e.id) && e.kind === 'projectile')
}

/** Element each projectile carries (undefined = plain round). */
const elements = (shots: Entity[]): (string | undefined)[] => shots.map((s) => s.projectile?.onHit?.status)

const stackOf = (p: Entity) => weaponStack(p)!

describe('payload vs modifier classification', () => {
  it('element mods are payloads; stat, behavior and trigger mods are modifiers', () => {
    expect(['frost', 'incendiary', 'shock'].every(isPayloadMod)).toBe(true)
    for (const id of ['overload', 'bulk', 'rapid', 'heavy', 'choke', 'velocity', 'glassCannon', 'bounce', 'pierce', 'homing', 'explosive', 'split', 'splinterShot', 'lifesteal', 'detonator'])
      expect(isPayloadMod(id), id).toBe(false)
  })
})

describe('planCasts (pure)', () => {
  const pistol = sequenceShape(WEAPONS.pistol)

  it('advances one payload per cast and wraps at the end', () => {
    const mods = [m('frost'), m('incendiary'), m('shock')]
    const a = planCasts(mods, pistol, 0)
    expect(a.casts[0].payload?.id).toBe('frost')
    expect(a.nextIndex).toBe(1)
    expect(a.wrapped).toBe(false)
    const c = planCasts(mods, pistol, 2)
    expect(c.casts[0].payload?.id).toBe('shock')
    expect(c.nextIndex).toBe(0)
    expect(c.wrapped).toBe(true)
  })

  it('modifiers ride on the next payload and do not use up a cast', () => {
    const plan = planCasts([m('overload'), m('pierce'), m('frost'), m('shock')], pistol, 0)
    expect(plan.casts).toHaveLength(1)
    expect(plan.casts[0].mods.map((x) => x.id)).toEqual(['overload', 'pierce', 'frost'])
    expect(plan.casts[0].payload?.id).toBe('frost')
    expect(plan.nextIndex).toBe(3)
  })

  it('a trailing modifier with no payload after it fires on a plain round and wraps', () => {
    const plan = planCasts([m('frost'), m('overload')], pistol, 1)
    expect(plan.casts[0].payload).toBeUndefined()
    expect(plan.casts[0].mods.map((x) => x.id)).toEqual(['overload'])
    expect(plan.wrapped).toBe(true)
  })

  it('only the first `slots` live entries sequence; the rest are stowed', () => {
    const mods = [m('frost'), m('bogus'), m('incendiary'), m('shock'), m('overload'), m('pierce')]
    expect(liveEntries(mods, 4)).toEqual([0, 2, 3, 4])
    const plan = planCasts(mods, { ...pistol, slots: 4 }, 3)
    expect(plan.casts[0].mods.map((x) => x.id)).toEqual(['overload'])
    expect(plan.wrapped).toBe(true)
  })

  it('castsPerTrigger > 1 takes consecutive casts and stops at a wrap', () => {
    const shot = sequenceShape(WEAPONS.shotgun)
    expect(shot.castsPerTrigger).toBe(2)
    const mods = [m('frost'), m('incendiary'), m('shock')]
    const first = planCasts(mods, shot, 0)
    expect(first.casts.map((c) => c.payload?.id)).toEqual(['frost', 'incendiary'])
    expect(first.wrapped).toBe(false)
    const second = planCasts(mods, shot, 2)
    expect(second.casts.map((c) => c.payload?.id)).toEqual(['shock'])
    expect(second.wrapped).toBe(true)
  })

  it('adversarial stored indices (negative, fractional, past the window) restart at 0', () => {
    const mods = [m('frost'), m('shock')]
    for (const bad of [-1, 0.5, 2, 99, NaN]) expect(planCasts(mods, pistol, bad).casts[0].payload?.id).toBe('frost')
  })

  it('an empty or all-unknown list plans nothing', () => {
    expect(planCasts([], pistol, 0).casts).toEqual([])
    expect(planCasts([m('nope'), m('frost', 0)], pistol, 0).casts).toEqual([])
  })

  it('pellet shares split evenly, front-loaded, never below one', () => {
    expect(pelletShares(5, 2)).toEqual([3, 2])
    expect(pelletShares(5, 3)).toEqual([2, 2, 1])
    expect(pelletShares(1, 3)).toEqual([1, 1, 1])
  })

  it('swap packing round-trips', () => {
    expect(unpackModSwap(packModSwap(3, 11))).toEqual({ a: 3, b: 11 })
  })
})

describe('sequenced fire path (combatSystem)', () => {
  it('the locker-7 pistol fires frost, fire, shock in order, one element per round', () => {
    const { w, p } = rig('pistol', [m('frost'), m('incendiary'), m('shock')])
    const got = [pull(w, p), pull(w, p), pull(w, p)]
    expect(got.map(elements)).toEqual([['frozen'], ['burning'], ['electrified']])
    // Each round advertises only its own cast's mods on the wire.
    expect(got[0][0].projectile!.mods).toEqual([m('frost')])
  })

  it('the index advances per shot and wraps to 0, starting a recharge', () => {
    const { w, p } = rig('pistol', [m('frost'), m('shock')])
    pull(w, p)
    expect(stackOf(p).castIndex).toBe(1)
    expect(stackOf(p).rechargeUntil).toBeUndefined()
    pull(w, p)
    expect(stackOf(p).castIndex).toBe(0)
    expect(stackOf(p).rechargeUntil).toBe(w.tick + WEAPONS.pistol.rechargeOnWrap!)
    expect(p.combat!.cooldown).toBe(WEAPONS.pistol.rechargeOnWrap!)
  })

  it('recharge blocks firing until it elapses, then the sequence restarts at the top', () => {
    const { w, p } = rig('pistol', [m('frost'), m('shock')])
    pull(w, p)
    pull(w, p) // wraps
    const until = stackOf(p).rechargeUntil!
    expect(pull(w, p)).toHaveLength(0) // cooldown cleared by hand, recharge still holds
    w.tick = until
    expect(elements(pull(w, p))).toEqual(['frozen'])
  })

  it('a held trigger through tickWorld respects cooldown and recharge timing', () => {
    const { w, p } = rig('pistol', [m('frost'), m('shock')])
    const fired: { tick: number; el?: string }[] = []
    for (let t = 0; t < 120; t++) {
      const before = new Set(w.entities.map((e) => e.id))
      const tick = w.tick
      tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
      for (const e of w.entities) if (!before.has(e.id) && e.projectile && e.projectile.ownerId === p.id) fired.push({ tick, el: e.projectile.onHit?.status })
    }
    const cd = WEAPONS.pistol.cooldownTicks
    const rc = WEAPONS.pistol.rechargeOnWrap!
    expect(fired.slice(0, 4)).toEqual([
      { tick: 0, el: 'frozen' },
      { tick: cd, el: 'electrified' },
      { tick: cd + rc, el: 'frozen' },
      { tick: cd + rc + cd, el: 'electrified' },
    ])
  })

  it('modifier then payload: overload boosts the frost round only, then shock fires plain-damage', () => {
    const { w, p } = rig('pistol', [m('overload', 2), m('frost'), m('shock')])
    const [a] = pull(w, p)
    const [b] = pull(w, p)
    expect(a.projectile!.onHit?.status).toBe('frozen')
    expect(a.projectile!.damage).toBe(Math.round(WEAPONS.pistol.damage * 1.25 * 1.25))
    expect(b.projectile!.onHit?.status).toBe('electrified')
    expect(b.projectile!.damage).toBe(WEAPONS.pistol.damage)
  })

  it('shotgun: each pellet group carries the next mod in sequence', () => {
    const { w, p } = rig('shotgun', [m('frost'), m('incendiary'), m('shock')])
    const first = pull(w, p)
    expect(first).toHaveLength(WEAPONS.shotgun.pellets!)
    expect(elements(first)).toEqual(['frozen', 'frozen', 'frozen', 'burning', 'burning'])
    const second = pull(w, p) // one cast left before the wrap: only the shock group
    expect(elements(second)).toEqual(['electrified', 'electrified', 'electrified'])
    expect(stackOf(p).castIndex).toBe(0)
    expect(stackOf(p).rechargeUntil).toBeDefined()
  })

  it('melee (mods reach melee today): one mod per swing', () => {
    const { w, p } = rig('sledgehammer', [m('incendiary'), m('shock')])
    pull(w, p)
    expect(stackOf(p).castIndex).toBe(1)
    pull(w, p)
    expect(stackOf(p).castIndex).toBe(0)
    expect(stackOf(p).rechargeUntil).toBe(w.tick + WEAPONS.sledgehammer.rechargeOnWrap!)
  })

  it('a weapon with no mods fires the default path and grows no sequence state', () => {
    const { w, p } = rig('pistol', [])
    delete stackOf(p).mods
    expect(pull(w, p)).toHaveLength(1)
    expect(stackOf(p).castIndex).toBeUndefined()
  })

  it('without the run rule the same loadout folds every mod into one shot (default mode)', () => {
    const { w, p } = rig('pistol', [m('frost'), m('incendiary')], false)
    const [a] = pull(w, p)
    expect(a.projectile!.mods!.map((x) => x.id)).toEqual(['frost', 'incendiary'])
    expect(stackOf(p).castIndex).toBeUndefined()
  })
})

describe('reordering', () => {
  const swapInput = (a: number, b: number): Map<number, InputCmd> =>
    new Map([[0, { ...emptyInput(), modSwap: packModSwap(a, b) }]])

  it('a swap input reorders the list; the index stays put and fires what now sits there', () => {
    const { w, p } = rig('pistol', [m('frost'), m('incendiary'), m('shock')])
    pull(w, p) // frost; index -> 1
    combatSystem(w, swapInput(1, 2))
    expect(stackOf(p).mods!.map((x) => x.id)).toEqual(['frost', 'shock', 'incendiary'])
    expect(stackOf(p).castIndex).toBe(1)
    expect(elements(pull(w, p))).toEqual(['electrified'])
  })

  it('reordering does not cancel a recharge', () => {
    const { w, p } = rig('pistol', [m('frost'), m('shock')])
    pull(w, p)
    pull(w, p)
    const until = stackOf(p).rechargeUntil
    combatSystem(w, swapInput(0, 1))
    expect(stackOf(p).rechargeUntil).toBe(until)
    expect(pull(w, p)).toHaveLength(0)
  })

  it('a stowed mod can be swapped into the live window', () => {
    const { w, p } = rig('pistol', [m('frost'), m('incendiary'), m('shock'), m('overload'), m('pierce')])
    combatSystem(w, swapInput(0, 4))
    expect(liveEntries(stackOf(p).mods, 4).map((i) => stackOf(p).mods![i].id)).toEqual(['pierce', 'incendiary', 'shock', 'overload'])
  })

  it('a swap is applied even mid-roll or stunned', () => {
    const { w, p } = rig('pistol', [m('frost'), m('shock')])
    p.status!.stun = 10
    combatSystem(w, swapInput(0, 1))
    expect(stackOf(p).mods!.map((x) => x.id)).toEqual(['shock', 'frost'])
  })

  it('adversarial swaps (out of range, self, garbage) are ignored', () => {
    const { p } = rig('pistol', [m('frost'), m('shock')])
    for (const v of [packModSwap(0, 0), packModSwap(0, 9), packModSwap(200, 1), -5, 1.5, NaN]) expect(applyModSwap(p, v)).toBe(false)
    expect(stackOf(p).mods!.map((x) => x.id)).toEqual(['frost', 'shock'])
  })

  it('without the run rule a swap input is inert', () => {
    const { w, p } = rig('pistol', [m('frost'), m('shock')], false)
    combatSystem(w, swapInput(0, 1))
    expect(stackOf(p).mods!.map((x) => x.id)).toEqual(['frost', 'shock'])
  })
})

describe('save/load', () => {
  it('castIndex, rechargeUntil and the run rule survive a serialize round-trip and resume identically', () => {
    const { w, p } = rig('pistol', [m('frost'), m('incendiary'), m('shock')])
    pull(w, p)
    pull(w, p)
    pull(w, p) // wrapped: index 0, recharging
    const json = JSON.parse(JSON.stringify(serializeWorld(w)))
    expect(json.modCasting).toBe('sequence')
    const back = deserializeWorld(json)
    const bp = back.byId.get(p.id)!
    expect(weaponStack(bp)!.castIndex).toBe(0)
    expect(weaponStack(bp)!.rechargeUntil).toBe(stackOf(p).rechargeUntil)
    const input = new Map([[0, { ...emptyInput(), attack: true }]])
    for (let i = 0; i < 90; i++) {
      tickWorld(w, input)
      tickWorld(back, input)
    }
    expect(serializeWorld(back)).toEqual(serializeWorld(w))
  })

  it('a mid-sequence index survives the round-trip', () => {
    const { w, p } = rig('pistol', [m('frost'), m('incendiary'), m('shock')])
    pull(w, p)
    const back = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))
    expect(weaponStack(back.byId.get(p.id)!)!.castIndex).toBe(1)
    expect(elements(pull(back, back.byId.get(p.id)!))).toEqual(['burning'])
  })
})
