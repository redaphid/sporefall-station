// Grabbing a scattered weapon-mod pickup (feat/mod-pickups): auto-pickup applies
// the mod to the GRABBER's own equipped weapon via the draft's append/cap path,
// emits a `modPickup` feedback event, and is safe on every degenerate input.
// Strict + adversarial: right mod applied, stacking + at-cap, no-weapon and
// unmoddable-weapon left on the ground (nothing wasted), co-op grabber-only,
// serialize round-trip, and byte-identical end-to-end determinism.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { emptyInput } from '../types'
import { serializeWorld, deserializeWorld } from '../serialize'
import { weaponStack } from './inventory'
import { modMaxStacks } from '../data/mods'

const player = (w: World, x = 20, y = 20, playerId = 0): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId, abilityCooldown: 0, inventory: [], cash: 0, crimeUntilTick: 0, activeSlot: -1 }
  return e
}

/** Arm a player with a slotted, equipped weapon (so its stack can carry mods). */
const arm = (e: Entity, itemId: string, mods?: WeaponMod[]): Entity => {
  e.playerCtl!.inventory = [{ itemId, qty: 8, ...(mods ? { mods } : {}) }]
  e.playerCtl!.activeSlot = 0
  e.combat!.weapon = itemId
  return e
}

/** Drop a mod pickup on top of `at` so auto-pickup fires on the next tick. */
const dropMod = (w: World, modId: string, at: Entity): Entity => {
  const e = makeEntity('pickup', `mod.${modId}`, at.pos.x, at.pos.y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  return addEntity(w, e)
}

const step = (w: World): World => {
  tickWorld(w, new Map([[0, emptyInput()]]))
  return w
}

const mods = (e: Entity): WeaponMod[] => weaponStack(e)?.mods ?? []

describe('mod pickup — applies to the equipped weapon', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('grabs a mod and stacks it onto the currently-equipped gun', () => {
    const p = arm(player(w), 'pistol')
    const pick = dropMod(w, 'frost', p)
    step(w)
    expect(mods(p)).toEqual([{ id: 'frost', stacks: 1 }])
    expect(w.byId.get(pick.id)).toBeUndefined() // consumed + swept
    const ev = w.events.find((e) => e.type === 'modPickup')
    expect(ev).toMatchObject({ type: 'modPickup', byId: p.id, modId: 'frost', weapon: 'pistol', maxed: false })
  })

  it('a mod applies to a MELEE weapon too (any slotted weapon is moddable)', () => {
    const p = arm(player(w), 'bat')
    dropMod(w, 'overload', p)
    step(w)
    expect(mods(p)).toEqual([{ id: 'overload', stacks: 1 }])
  })

  it('stacks a repeat of the same mod up toward its cap', () => {
    const p = arm(player(w), 'pistol', [{ id: 'homing', stacks: 1 }])
    dropMod(w, 'homing', p)
    step(w)
    expect(mods(p)).toEqual([{ id: 'homing', stacks: 2 }])
    expect((w.events.find((e) => e.type === 'modPickup') as { maxed: boolean }).maxed).toBe(false)
  })

  it('at the stack cap: grab is consumed with maxed feedback, never over-stacks', () => {
    const cap = modMaxStacks('homing')
    const p = arm(player(w), 'pistol', [{ id: 'homing', stacks: cap }])
    const pick = dropMod(w, 'homing', p)
    step(w)
    expect(mods(p)).toEqual([{ id: 'homing', stacks: cap }]) // unchanged, no over-stack
    expect(w.byId.get(pick.id)).toBeUndefined() // still consumed
    expect((w.events.find((e) => e.type === 'modPickup') as { maxed: boolean }).maxed).toBe(true)
  })
})

describe('mod pickup — degenerate inputs are safe', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('bare fists (no slotted weapon): pickup is LEFT on the ground, no event', () => {
    const p = player(w) // fists, activeSlot -1, empty inventory
    const pick = dropMod(w, 'frost', p)
    step(w)
    expect(weaponStack(p)).toBeUndefined()
    expect(w.byId.get(pick.id)).toBeDefined() // untouched — grab it later with a gun
    expect(w.byId.get(pick.id)!.dead).toBeFalsy()
    expect(w.events.some((e) => e.type === 'modPickup')).toBe(false)
  })

  it('an unslotted class-starter gun (combat.weapon set, not in inventory) is left too', () => {
    const p = player(w)
    p.combat!.weapon = 'pistol' // held but not a slot → no mod list to write to
    const pick = dropMod(w, 'incendiary', p)
    step(w)
    expect(w.byId.get(pick.id)).toBeDefined()
    expect(w.events.some((e) => e.type === 'modPickup')).toBe(false)
  })

  it('a downed player does not vacuum up mods', () => {
    const p = arm(player(w), 'pistol')
    p.playerCtl!.downed = { bleedTicks: 300, reviveProgress: 0 }
    const pick = dropMod(w, 'frost', p)
    step(w)
    expect(mods(p)).toEqual([])
    expect(w.byId.get(pick.id)).toBeDefined()
  })
})

describe('mod pickup — co-op applies to the grabber only', () => {
  it('each player mods their OWN weapon; the other is untouched', () => {
    const w = createWorld(1, 1)
    const a = arm(player(w, 10, 10, 0), 'pistol')
    const b = arm(player(w, 40, 40, 1), 'shotgun')
    dropMod(w, 'frost', a) // sits on A
    dropMod(w, 'explosive', b) // sits on B
    step(w)
    expect(mods(a)).toEqual([{ id: 'frost', stacks: 1 }])
    expect(mods(b)).toEqual([{ id: 'explosive', stacks: 1 }])
    const grabbers = w.events.filter((e) => e.type === 'modPickup').map((e) => (e as { byId: number }).byId).sort()
    expect(grabbers).toEqual([a.id, b.id].sort())
  })

  it('a mod dropped on A is not stolen by a distant B', () => {
    const w = createWorld(1, 1)
    const a = arm(player(w, 10, 10, 0), 'pistol')
    const b = arm(player(w, 40, 40, 1), 'shotgun')
    dropMod(w, 'frost', a)
    step(w)
    expect(mods(a)).toEqual([{ id: 'frost', stacks: 1 }])
    expect(mods(b)).toEqual([])
  })
})

describe('mod pickup — serialize & determinism', () => {
  it('the resulting modded weapon round-trips byte-for-byte', () => {
    const w = createWorld(5, 2)
    const p = arm(player(w), 'machinegun')
    dropMod(w, 'lifesteal', p)
    step(w)
    const json = serializeWorld(w)
    expect(serializeWorld(deserializeWorld(json))).toEqual(json)
    const restored = deserializeWorld(json)
    const rp = restored.entities.find((e) => e.playerCtl)!
    expect(weaponStack(rp)?.mods).toEqual([{ id: 'lifesteal', stacks: 1 }])
  })

  it('end-to-end: two identical worlds pick up the same mod to identical state', () => {
    const build = (): World => {
      const w = createWorld(9, 3)
      const p = arm(player(w), 'pistol')
      dropMod(w, 'shock', p)
      return w
    }
    const a = build()
    const b = build()
    step(a)
    step(b)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('replaying a serialized post-pickup world stays byte-identical for more ticks', () => {
    const w = createWorld(2, 1)
    const p = arm(player(w), 'pistol')
    dropMod(w, 'bounce', p)
    step(w)
    const snap = serializeWorld(w)
    const live = deserializeWorld(snap)
    const fork = deserializeWorld(snap)
    for (let i = 0; i < 20; i++) {
      tickWorld(live, new Map([[0, emptyInput()]]))
      tickWorld(fork, new Map([[0, emptyInput()]]))
    }
    expect(serializeWorld(live)).toEqual(serializeWorld(fork))
  })
})
