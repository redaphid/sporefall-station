// Exhaustive item-behavior coverage: every declarative onHit / onLand / onUse
// must actually reach a system and produce its effect. Complements items.test.ts
// (which covers shotgun/freezeRay/tranq/sledgehammer/freezeGrenade/chloroform)
// by driving the remaining element items and the two new guns end to end.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { CONSUMABLES, itemClass, THROWABLES, WEAPONS } from '../data/items'
import { ELEMENTS } from '../data/elements'
import { combatSystem } from './combat'
import { elementSystem, fireSystem } from './fire'
import { throwActive } from './inventory'
import { equipSlot } from './inventory'
import { projectileSystem } from './projectiles'
import { statusSystem } from './status'
import { hasStatus, isImmobilized } from './statusFx'

const player = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, inventory: [], cash: 0, crimeUntilTick: 0, activeSlot: -1 }
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
    e.playerCtl!.inventory = [{ itemId: 'flamethrower', qty: 40 }]
    equipSlot(e, 0)
    const target = dummy(w, 22, 20)
    fireUntil(w, () => hasStatus(target, 'burning'))
    expect(hasStatus(target, 'burning')).toBe(true)
  })

  it('flamethrower burn actually chews hp over time (DoT reaches elementSystem)', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'flamethrower', qty: 40 }]
    equipSlot(e, 0)
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
    e.playerCtl!.inventory = [{ itemId: 'stunGun', qty: 4 }]
    equipSlot(e, 0)
    const target = dummy(w, 22, 20)
    fireUntil(w, () => hasStatus(target, 'electrified'))
    expect(hasStatus(target, 'electrified')).toBe(true)
    expect(isImmobilized(target)).toBe(true)
  })

  it('an electrified player cannot act (combat gated on immobilize)', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'bat', qty: 12 }]
    equipSlot(e, 0)
    const target = dummy(w, 21, 20)
    e.fx = { electrified: { until: w.tick + 30 } }
    combatSystem(w, attack())
    expect(target.health!.hp).toBe(60) // swing never landed
  })

  it('machine gun empties its whole magazine round by round', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'machinegun', qty: 3 }]
    equipSlot(e, 0)
    let shots = 0
    for (let i = 0; i < 5; i++) {
      const before = w.entities.filter((x) => x.projectile).length
      combatSystem(w, attack())
      if (w.entities.filter((x) => x.projectile).length > before) shots++
      e.combat!.cooldown = 0
    }
    expect(shots).toBe(3) // only three rounds were in the mag
    expect(e.playerCtl!.inventory[0].qty).toBe(0)
  })
})

describe('item behavior — element throwables', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('molotov lands a fire hazard (onLand: fire)', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'molotov', qty: 1 }]
    e.playerCtl!.activeSlot = 0
    dummy(w, 22, 20) // give it something to land on nearby
    throwActive(w, e)
    for (let t = 0; t < 40 && !w.entities.some((x) => x.fire); t++) projectileSystem(w)
    expect(w.entities.some((x) => x.fire && !x.dead)).toBe(true)
  })

  it('molotov fire spreads to an adjacent flammable object', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'molotov', qty: 1 }]
    e.playerCtl!.activeSlot = 0
    const crate = addEntity(w, makeEntity('interactable', 'crate', 23, 20, 0.4))
    crate.health = { hp: 20, max: 20, iframes: 0 }
    crate.flammable = true
    throwActive(w, e)
    for (let t = 0; t < 200; t++) {
      projectileSystem(w)
      fireSystem(w)
      w.tick++
      if (hasStatus(crate, 'burning')) break
    }
    expect(hasStatus(crate, 'burning')).toBe(true)
  })

  it('grenade blast damages actors where it lands (onLand: explode)', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'grenade', qty: 1 }]
    e.playerCtl!.activeSlot = 0
    const victim = dummy(w, 22, 20)
    throwActive(w, e)
    for (let t = 0; t < 40 && victim.health!.hp === 60; t++) projectileSystem(w)
    expect(victim.health!.hp).toBeLessThan(60)
  })

  it('banana peel makes a nearby actor slip (onLand: slip -> stun timer)', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'banana', qty: 1 }]
    e.playerCtl!.activeSlot = 0
    const victim = dummy(w, 21, 20)
    throwActive(w, e)
    for (let t = 0; t < 40 && victim.status!.stun === 0; t++) projectileSystem(w)
    expect(victim.status!.stun).toBeGreaterThan(0)
  })

  it('gas grenade poisons and the poison damages over time', () => {
    const e = player(w)
    e.playerCtl!.inventory = [{ itemId: 'gasGrenade', qty: 1 }]
    e.playerCtl!.activeSlot = 0
    const victim = dummy(w, 22, 20)
    throwActive(w, e)
    for (let t = 0; t < 40 && !hasStatus(victim, 'poisoned'); t++) projectileSystem(w)
    expect(hasStatus(victim, 'poisoned')).toBe(true)
    const before = victim.health!.hp
    for (let t = 0; t < ELEMENTS.poisoned.interval * 3; t++) {
      elementSystem(w)
      w.tick++
    }
    expect(victim.health!.hp).toBeLessThan(before)
  })
})

describe('item behavior — freeze then shatter (element combo through items)', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a freeze-ray freeze followed by a melee impact shatters the target', () => {
    const e = player(w, 20, 20)
    const target = dummy(w, 21, 20)
    e.playerCtl!.inventory = [
      { itemId: 'freezeRay', qty: 6 },
      { itemId: 'bat', qty: 12 },
    ]
    equipSlot(e, 0)
    fireUntil(w, () => hasStatus(target, 'frozen'))
    expect(hasStatus(target, 'frozen')).toBe(true)
    // Let the freeze-ray's own hit iframes lapse (as ticks pass in-game); the
    // frost lasts far longer, so the body is still frozen when we swing.
    for (let t = 0; t < 6; t++) statusSystem(w)
    // Switch to the bat and swing: an impact on a frozen body is an instant kill.
    equipSlot(e, 1)
    e.combat!.cooldown = 0
    combatSystem(w, attack())
    expect(target.shattered).toBe(true)
    expect(target.dead).toBe(true)
  })
})

describe('item data — well-formedness', () => {
  it('every ranged weapon has a projectile speed and a magazine', () => {
    for (const wpn of Object.values(WEAPONS)) {
      if (wpn.kind !== 'ranged') continue
      expect(wpn.projectileSpeed, wpn.id).toBeGreaterThan(0)
      expect(wpn.magSize, wpn.id).toBeGreaterThan(0)
    }
  })

  it('every non-fists melee weapon has finite durability', () => {
    for (const wpn of Object.values(WEAPONS)) {
      if (wpn.kind !== 'melee' || wpn.id === 'fists') continue
      expect(wpn.durability, wpn.id).toBeGreaterThan(0)
    }
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
