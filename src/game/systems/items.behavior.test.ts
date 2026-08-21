// Exhaustive item-behavior coverage: every declarative onHit / onLand / onUse
// must actually reach a system and produce its effect. Complements items.test.ts
// (which covers shotgun/freezeRay/tranq/sledgehammer and the grenade) by driving
// the remaining element items and the two new guns end to end.
//
// The nine-item cull took molotov, banana and gasGrenade out of this file. Their
// EFFECTS did not all go with them, so the tests are re-pointed at whatever
// still produces each effect rather than deleted:
//   * fire — the molotov was one source, not the only one. Barrels/`ignite`
//     objects and the `incendiary` mod still start fires, so the hazard and the
//     SPREAD stay covered, lit from a surviving source.
//   * poisoned / slip — gasGrenade and banana were the ONLY producers of these
//     two, so nothing in the game applies them today. The element table and the
//     status routing are deliberately left standing (a mod or a future item is
//     one line away), so the coverage becomes "still correct when asked", which
//     is the honest claim now.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { CONSUMABLES, itemClass, THROWABLES, WEAPONS } from '../data/items'
import { ELEMENTS } from '../data/elements'
import { combatSystem } from './combat'
import { elementSystem, fireSystem } from './fire'
import { applyAreaEffect } from './itemEffects'
import { destroyObject, spawnObject } from './objects'
import { throwActive } from './inventory'
import { arm } from '../testkit'
import { projectileSystem } from './projectiles'
import { statusSystem } from './status'
import { hasStatus, isImmobilized } from './statusFx'

const player = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  e.facing = 0
  return e
}

const dummy = (w: World, x: number, y: number, hp = 60): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

const attack = (): Map<number, InputCmd> => {
  const cmd = emptyInput()
  cmd.attack = true
  return new Map([[0, cmd]])
}

/** Fire the equipped gun once and advance projectiles until `hit` is true. */
const fireUntil = (w: World, hit: () => boolean, maxTicks = 40): void => {
  combatSystem(w, attack())
  for (let t = 0; t < maxTicks && !hit(); t++) projectileSystem(w)
}

describe('item behavior — new guns', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('flamethrower sets its target burning (onHit)', () => {
    const e = player(w)
    arm(e, 'flamethrower')
    const target = dummy(w, 22, 20)
    fireUntil(w, () => hasStatus(target, 'burning'))
    expect(hasStatus(target, 'burning')).toBe(true)
  })

  it('flamethrower burn actually chews hp over time (DoT reaches elementSystem)', () => {
    const e = player(w)
    arm(e, 'flamethrower')
    const target = dummy(w, 22, 20)
    fireUntil(w, () => hasStatus(target, 'burning'))
    const afterHit = target.health!.hp // includes the small impact damage
    for (let t = 0; t < ELEMENTS.burning.interval * 3; t++) {
      elementSystem(w)
      w.tick++
    }
    expect(target.health!.hp).toBeLessThan(afterHit)
  })

  it('stun gun electrifies and immobilizes its target (onHit)', () => {
    const e = player(w)
    arm(e, 'stunGun')
    const target = dummy(w, 22, 20)
    fireUntil(w, () => hasStatus(target, 'electrified'))
    expect(hasStatus(target, 'electrified')).toBe(true)
    expect(isImmobilized(target)).toBe(true)
  })

  it('an electrified player cannot act (combat gated on immobilize)', () => {
    const e = player(w)
    arm(e, 'bat')
    const target = dummy(w, 21, 20)
    e.fx = { electrified: { until: w.tick + 30 } }
    combatSystem(w, attack())
    expect(target.health!.hp).toBe(60) // swing never landed
  })

  // Was 'molotov lands a fire hazard'. The molotov was culled; a destroyed
  // barrel is the surviving in-world source of a fire, so the hazard is asserted
  // from there. Had fire ONLY ever come from the molotov, this is the test that
  // would prove the cull killed the fire system outright — it does not.
  it('a destroyed barrel still lands a fire hazard (ignite)', () => {
    const barrel = spawnObject(w, 'barrel', 22, 20)
    destroyObject(w, barrel, 1)
    expect(w.entities.some((x) => x.fire && !x.dead)).toBe(true)
  })

  // Was 'molotov fire spreads…'. Only the IGNITION SOURCE changed: the tile is
  // lit through the same `onLand: fire` area effect the molotov used to deliver,
  // so what is under test — fireSystem propagating to an adjacent flammable
  // body — is untouched.
  it('fire spreads to an adjacent flammable object', () => {
    const crate = addEntity(w, makeEntity('interactable', 'crate', 23, 20, 0.4))
    crate.health = { hp: 20, max: 20, iframes: 0 }
    crate.flammable = true
    applyAreaEffect(w, 23, 20, { kind: 'fire' }, 0)
    for (let t = 0; t < 200; t++) {
      fireSystem(w)
      w.tick++
      if (hasStatus(crate, 'burning')) break
    }
    expect(hasStatus(crate, 'burning')).toBe(true)
  })

  it('grenade blast damages actors where it lands (onLand: explode)', () => {
    const e = player(w)
    e.loadout!.inventory = [{ itemId: 'grenade', qty: 1 }]
    e.loadout!.activeSlot = 0
    const victim = dummy(w, 22, 20)
    throwActive(w, e)
    for (let t = 0; t < 40 && victim.health!.hp === 60; t++) projectileSystem(w)
    expect(victim.health!.hp).toBeLessThan(60)
  })

  // banana (slip) and gasGrenade (poisoned) were culled, and each was the ONLY
  // thing in the game producing its status — so neither can be driven from an
  // item any more. They are NOT deleted: the routing and the poison DoT are live
  // code a mod or a future item will reach for, and an orphaned effect that
  // silently stopped working would be found by whoever adds that item rather
  // than by this suite. Driven through the same `applyAreaEffect` entry point
  // the thrown item used to call.
  it('slip still routes to the legacy stun timer when something applies it', () => {
    const victim = dummy(w, 21, 20)
    applyAreaEffect(w, 21, 20, { kind: 'status', status: 'slip', ticks: 45, radius: 1.2 }, 0)
    expect(victim.status!.stun).toBeGreaterThan(0)
  })

  it('poison still applies and damages over time when something applies it', () => {
    const victim = dummy(w, 22, 20)
    applyAreaEffect(w, 22, 20, { kind: 'status', status: 'poisoned', ticks: 150, radius: 2 }, 0)
    expect(hasStatus(victim, 'poisoned')).toBe(true)
    const before = victim.health!.hp
    for (let t = 0; t < ELEMENTS.poisoned.interval * 3; t++) {
      elementSystem(w)
      w.tick++
    }
    expect(victim.health!.hp).toBeLessThan(before)
  })

  it('no item produces slip or poison any more — they are orphaned by the cull', () => {
    // Pins the finding above so it is a stated fact rather than a silent gap. If
    // a new item brings either status back, this fails and the note is updated.
    const fromThrowables = Object.values(THROWABLES).flatMap((t) => (t.onLand.kind === 'status' ? [t.onLand.status] : []))
    const fromWeapons = Object.values(WEAPONS).flatMap((wp) => (wp.onHit ? [wp.onHit.status] : []))
    const produced = [...fromThrowables, ...fromWeapons]
    expect(produced).not.toContain('slip')
    expect(produced).not.toContain('poisoned')
  })
})

describe('item behavior — freeze then shatter (element combo through items)', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a thrown freeze followed by an impact from the permanent weapon shatters the target', () => {
    // Retargeted TWICE. First for ONE PERMANENT WEAPON: this used to freeze with
    // a freeze RAY and then swap to a bat — two carried weapons, which a player
    // can no longer have. Then for the item cull, which took freezeGrenade and
    // with it the thrown source of `frozen` this used as its stand-in.
    //
    // The combo is still fully reachable in play: `frozen` now comes from the
    // freezeRay's `onHit` or the `frost` mod, and the shattering impact from the
    // one weapon the player carries all run. The freeze is applied here as an
    // area effect (exactly as landing applied it) so the test still exercises
    // the status→shatter path rather than the gun's aiming; the assertion below
    // ties the literal back to a source the game really has.
    const e = player(w, 20, 20)
    const target = dummy(w, 26, 20)
    arm(e, 'bat')
    expect(WEAPONS.freezeRay.onHit!.status).toBe('frozen') // a real, surviving source
    // Applied from a distance — a blast radius would freeze the thrower too —
    // then the player closes in and swings.
    applyAreaEffect(w, target.pos.x, target.pos.y, { kind: 'status', status: 'frozen', ticks: 120, radius: 2 }, e.id)
    expect(hasStatus(target, 'frozen')).toBe(true)
    expect(hasStatus(e, 'frozen')).toBe(false) // the thrower stayed clear
    for (let t = 0; t < 6; t++) statusSystem(w)
    e.pos = { x: 25, y: 20 }
    e.combat!.cooldown = 0
    combatSystem(w, attack())
    expect(target.shattered).toBe(true)
    expect(target.dead).toBe(true)
  })
})

describe('item data — well-formedness', () => {
  it('every ranged weapon has a projectile speed and NO magazine (ammo is gone)', () => {
    for (const wpn of Object.values(WEAPONS)) {
      if (wpn.kind !== 'ranged') continue
      expect(wpn.projectileSpeed, wpn.id).toBeGreaterThan(0)
      // A stray magSize/ammoPerShot would silently reintroduce a magazine on a
      // gun that has no way to reload.
      expect(wpn, wpn.id).not.toHaveProperty('magSize')
      expect(wpn, wpn.id).not.toHaveProperty('ammoPerShot')
    }
  })

  it('every CARRIED melee weapon has finite durability', () => {
    for (const wpn of Object.values(WEAPONS)) {
      // Natural armament (fists, a Mireclaw's claws) is grown, not carried:
      // there is nothing to wear out, so durability is meaningless for it.
      if (wpn.kind !== 'melee' || wpn.natural) continue
      expect(wpn.durability, wpn.id).toBeGreaterThan(0)
    }
  })

  it('natural armament is durability-free and never a held sprite', () => {
    const natural = Object.values(WEAPONS).filter((w) => w.natural)
    expect(natural.map((w) => w.id).sort()).toEqual(['claws', 'fists'])
    for (const wpn of natural) expect(wpn.durability, wpn.id).toBeUndefined()
  })

  it('every weapon onHit / throwable onLand names a status the systems can apply', () => {
    // Statuses either route to the legacy timers or exist in the element table.
    const legacy = new Set(['sleep', 'slip', 'stun'])
    const known = (s: string): boolean => legacy.has(s) || ELEMENTS[s] !== undefined
    for (const wpn of Object.values(WEAPONS)) {
      if (wpn.onHit) expect(known(wpn.onHit.status), `${wpn.id}:${wpn.onHit.status}`).toBe(true)
    }
    for (const th of Object.values(THROWABLES)) {
      if (th.onLand.kind === 'status') expect(known(th.onLand.status), `${th.id}:${th.onLand.status}`).toBe(true)
    }
  })

  it('the two new guns are present, ranged, and carry an element onHit', () => {
    for (const id of ['flamethrower', 'stunGun']) {
      const wpn = WEAPONS[id]
      expect(wpn, id).toBeDefined()
      expect(wpn.kind).toBe('ranged')
      expect(wpn.onHit).toBeDefined()
      expect(ELEMENTS[wpn.onHit!.status], `${id} element`).toBeDefined()
    }
  })

  it('itemClass agrees with which table an id lives in', () => {
    for (const id of Object.keys(WEAPONS)) expect(['melee', 'ranged']).toContain(itemClass(id))
    for (const id of Object.keys(THROWABLES)) expect(itemClass(id)).toBe('throwable')
    for (const id of Object.keys(CONSUMABLES)) expect(itemClass(id)).toBe('consumable')
    expect(itemClass('nonexistent')).toBe('unknown')
  })
})
