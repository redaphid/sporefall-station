// Each cast carries its own element. The mod list is the firing order: a cast
// takes the modifiers before an element plus that element, so one pull lands
// exactly one element and the next pull lands the next. No element overrides
// another. The owner's ruling: `bouncy -> bouncy -> fire -> splinter -> ice`
// shoots "bouncy bouncy fire" first, then "splinter ice".
//
// Every case sets exact world state, then runs the real sim (tickWorld) and
// asserts on the status that lands on a fresh target per pull.

import { describe, expect, it } from 'vitest'
import { normalizeMods } from '../data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { equipSlot, weaponStack } from './inventory'
import { hasStatus } from './statusFx'

const ELEMENT_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const ELEMENT_STATUSES = Object.values(ELEMENT_OF)
const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

const armed = (w: World, mods?: WeaponMod[]): Entity => {
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = [{ itemId: 'pistol', qty: 99, ...(mods ? { mods } : {}) }]
  equipSlot(p, 0)
  p.facing = 0
  return p
}

const target = (w: World): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
  e.health = { hp: 400, max: 400, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

const dropMod = (w: World, modId: string, at: Entity): void => {
  const e = makeEntity('pickup', `mod.${modId}`, at.pos.x, at.pos.y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  addEntity(w, e)
}

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const shoot = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]])

/** One trigger pull through the real systems at a fresh target, then let the
 * round land. The previous target steps out of the lane first. */
const pullAt = (w: World): { landed: string[]; round?: Entity } => {
  for (const e of w.entities) if (e.archetype === 'civilian') e.pos = { x: 5, y: 5 }
  const t = target(w)
  const p = w.entities.find((e) => e.playerCtl)!
  p.combat!.cooldown = 0
  const before = new Set(w.entities.map((e) => e.id))
  tickWorld(w, shoot())
  const round = w.entities.find((e) => !before.has(e.id) && e.projectile)
  for (let i = 0; i < 10; i++) tickWorld(w, idle())
  return { landed: ELEMENT_STATUSES.filter((s) => hasStatus(t, s)), round }
}

/** The element each of `pulls` consecutive pulls lands. */
const pullsLand = (mods: WeaponMod[], pulls: number): string[][] => {
  const w = createWorld(1, 1)
  armed(w, mods)
  return Array.from({ length: pulls }, () => pullAt(w).landed)
}

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))

describe('each cast lands its own element', () => {
  it("the owner's wand: pull 1 is bouncy bouncy fire, pull 2 is splinter ice", () => {
    const w = createWorld(1, 1)
    armed(w, [m('bounce', 2), m('incendiary'), m('splinterShot'), m('frost')])
    const first = pullAt(w)
    const second = pullAt(w)
    expect(first.landed).toEqual(['burning'])
    expect(first.round!.projectile!.bounceLeft).toBe(4)
    expect(first.round!.projectile!.splinter).toBeUndefined()
    expect(second.landed).toEqual(['frozen'])
    expect(second.round!.projectile!.splinter?.count).toBeGreaterThan(0)
    expect(second.round!.projectile!.bounceLeft).toBeUndefined()
  })

  it("a round's look lists only its own cast's mods (#118)", () => {
    const w = createWorld(1, 1)
    armed(w, [m('bounce', 2), m('incendiary'), m('splinterShot'), m('frost')])
    expect(pullAt(w).round!.projectile!.mods).toEqual(normalizeMods([m('bounce', 2), m('incendiary')]))
    expect(pullAt(w).round!.projectile!.mods).toEqual(normalizeMods([m('splinterShot'), m('frost')]))
  })

  it('Cryo picked after Tesla: the first pull electrifies, the second freezes', () => {
    expect(pullsLand([m('shock'), m('frost')], 2)).toEqual([['electrified'], ['frozen']])
  })

  for (const order of permutations(['frost', 'incendiary', 'shock'])) {
    it(`three elements in order ${order.join(' > ')} land one per pull, in that order`, () => {
      expect(pullsLand(order.map((id) => m(id)), 3)).toEqual(order.map((id) => [ELEMENT_OF[id]]))
    })
  }

  it('modifiers between the elements ride the next element and change no cast element', () => {
    const mods = [m('shock'), m('overload'), m('frost', 2), m('pierce'), m('rapid')]
    expect(pullsLand(mods, 3)).toEqual([['electrified'], ['frozen'], []])
  })

  it('a zero-stack or unknown entry is skipped, never a cast of its own', () => {
    expect(pullsLand([m('frost'), m('shock', 0), m('no-such-mod', 3)], 3)).toEqual([['frozen'], ['frozen'], ['frozen']])
  })

  it('real pickups: grabbing Tesla then Cryo fires Tesla first, then Cryo', () => {
    const w = createWorld(1, 1)
    const p = armed(w)
    dropMod(w, 'shock', p)
    tickWorld(w, idle())
    dropMod(w, 'frost', p)
    tickWorld(w, idle())
    expect(weaponStack(p)?.mods).toEqual([m('shock'), m('frost')])
    expect([pullAt(w).landed, pullAt(w).landed]).toEqual([['electrified'], ['frozen']])
  })

  it('the next cast survives a serialize round-trip mid-cycle', () => {
    const w = createWorld(1, 1)
    armed(w, [m('shock'), m('frost')])
    expect(pullAt(w).landed).toEqual(['electrified'])
    const restored = deserializeWorld(serializeWorld(w))
    expect(pullAt(restored).landed).toEqual(['frozen'])
  })
})
