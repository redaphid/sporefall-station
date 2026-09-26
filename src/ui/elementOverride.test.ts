// #88 on top of #106: a default-mode shot carries the NEWEST element on the mod
// list, and the list is pickup order. Every case grabs real pickups through the
// sim, fires the real weapon at a target, and holds the loadout, inspect and
// draft verdicts to the element that actually landed.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { draftCards } from '../game/systems/draft'
import { equipSlot, weaponStack } from '../game/systems/inventory'
import type { ModVerdict } from '../game/systems/modEffect'
import { hasStatus } from '../game/systems/statusFx'
import { emptyInput, type InputCmd } from '../game/types'
import { addEntity, createWorld, tickWorld, type World } from '../game/world'
import { buildInfoCard } from './inspectModel'
import { buildLoadout } from './loadoutModel'
import { buildSequence } from './sequenceModel'

const STATUS_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const ELEMENTS = Object.keys(STATUS_OF)
const LIVE: ModVerdict = { kind: 'live' }
const overriddenBy = (winner: string): ModVerdict => ({ kind: 'inert', reason: `${MODS[winner].name} overrides it` })

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const shoot = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]])

const rig = (sequenced = false, mods?: WeaponMod[]): World => {
  const w = createWorld(1, 1)
  if (sequenced) w.modCasting = 'sequence'
  const p = spawnPlayer(w, 0, 20.5, 20.5)
  p.loadout!.inventory = [{ itemId: 'pistol', qty: 99, ...(mods ? { mods } : {}) }]
  equipSlot(p, 0)
  p.facing = 0
  return deserializeWorld(serializeWorld(w))
}

const player = (w: World): Entity => w.entities.find((e) => e.playerCtl)!

const dropMod = (w: World, modId: string, x: number, y: number): Entity => {
  const e = makeEntity('pickup', `mod.${modId}`, x, y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  return addEntity(w, e)
}

/** Walk-over pickups, in order, through the real interaction system. */
const grab = (w: World, ...ids: string[]): void => {
  for (const id of ids) {
    const p = player(w)
    dropMod(w, id, p.pos.x, p.pos.y)
    tickWorld(w, idle())
    expect(w.events.some((e) => e.type === 'modPickup' && e.modId === id)).toBe(true)
  }
}

const listed = (w: World): string[] => (weaponStack(player(w))?.mods ?? []).map((m) => m.id)

const chips = (w: World): Record<string, ModVerdict> =>
  Object.fromEntries(buildLoadout(player(w), w.modCasting)!.mods.map((c) => [c.id, c.verdict]))

const onHitBadges = (w: World): string[] =>
  buildLoadout(player(w), w.modCasting)!.behaviors.filter((b) => b.key === 'onhit').map((b) => b.label)

/** One trigger pull at a fresh target; the element statuses that landed on it. */
const landed = (w: World): string[] => {
  const t = addEntity(w, makeEntity('npc', 'civilian', 22.5, 20.5))
  t.health = { hp: 400, max: 400, iframes: 0 }
  t.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  tickWorld(w, shoot())
  for (let i = 0; i < 10; i++) tickWorld(w, idle())
  return ELEMENTS.map((id) => STATUS_OF[id]).filter((s) => hasStatus(t, s))
}

/** The element each of `n` trigger pulls put on its bullets, waiting out the
 * cooldown (and any wrap recharge) between pulls. */
const pullElements = (w: World, n: number): (string | undefined)[][] => {
  const p = player(w)
  const out: (string | undefined)[][] = []
  for (let i = 0; i < n; i++) {
    for (let guard = 0; p.combat!.cooldown > 0 && guard < 600; guard++) tickWorld(w, idle())
    const before = new Set(w.entities.map((e) => e.id))
    tickWorld(w, shoot())
    out.push(w.entities.filter((e) => e.projectile?.ownerId === p.id && !before.has(e.id)).map((e) => e.projectile!.onHit?.status))
  }
  return out
}

const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]))

describe('default casting: the newest element is live and names itself as the override', () => {
  it('Tesla then Cryo: the shot freezes, Cryo is live, Tesla reads as overridden by Cryo Rounds', () => {
    let w = rig()
    grab(w, 'shock', 'frost')
    w = deserializeWorld(serializeWorld(w))
    expect(listed(w)).toEqual(['shock', 'frost'])
    expect(chips(w)).toEqual({ frost: LIVE, shock: overriddenBy('frost') })
    expect(onHitBadges(w)).toEqual(['frozen on hit'])
    expect(landed(w)).toEqual(['frozen'])
  })

  it('Cryo then Tesla: the shot electrifies, Tesla is live, Cryo reads as overridden by Tesla Rounds', () => {
    let w = rig()
    grab(w, 'frost', 'shock')
    w = deserializeWorld(serializeWorld(w))
    expect(listed(w)).toEqual(['frost', 'shock'])
    expect(chips(w)).toEqual({ frost: overriddenBy('shock'), shock: LIVE })
    expect(onHitBadges(w)).toEqual(['electrified on hit'])
    expect(landed(w)).toEqual(['electrified'])
  })

  for (const order of permutations(ELEMENTS)) {
    const newest = order[2]
    it(`${order.join(' then ')}: only ${newest} is live, and it overrides both others`, () => {
      const w = rig()
      grab(w, ...order)
      expect(listed(w)).toEqual(order)
      expect(chips(w)).toEqual(Object.fromEntries(order.map((id) => [id, id === newest ? LIVE : overriddenBy(newest)])))
      expect(onHitBadges(w)).toEqual([`${STATUS_OF[newest]} on hit`])
      expect(landed(w)).toEqual([STATUS_OF[newest]])
    })
  }

  it('non-element mods between and after the elements neither win nor get overridden', () => {
    const w = rig()
    grab(w, 'shock', 'pierce', 'frost', 'rapid')
    expect(chips(w)).toEqual({ frost: LIVE, pierce: LIVE, rapid: LIVE, shock: overriddenBy('frost') })
    expect(landed(w)).toEqual(['frozen'])
  })

  it('re-grabbing the overridden element stacks it in place, so it stays overridden', () => {
    const w = rig()
    grab(w, 'shock', 'frost', 'shock')
    expect(w.events.filter((e) => e.type === 'modPickup' && e.modId === 'shock').at(-1)).toMatchObject({ maxed: true })
    expect(listed(w)).toEqual(['shock', 'frost'])
    expect(chips(w).shock).toEqual(overriddenBy('frost'))
    expect(landed(w)).toEqual(['frozen'])
  })
})

describe('before the pick: a new element is judged as the newest, because a pick appends', () => {
  it('a Cryo pickup reads live to a Tesla holder, and grabbing it flips Tesla to overridden', () => {
    const w = rig()
    grab(w, 'shock')
    const p = player(w)
    const pk = dropMod(w, 'frost', 30.5, 30.5)
    expect(buildInfoCard(pk, { self: p }).rows.find((r) => r.label === 'On your weapon')).toBeUndefined()
    const loadout = { weapon: WEAPONS.pistol, mods: weaponStack(p)!.mods!, sequenced: false }
    expect(draftCards(['frost', 'shock'], loadout).map((c) => c.verdict)).toEqual([LIVE, { kind: 'inert', reason: 'already maxed' }])
    expect(chips(w)).toEqual({ shock: LIVE })

    grab(w, 'frost')
    expect(chips(w)).toEqual({ frost: LIVE, shock: overriddenBy('frost') })
    expect(landed(w)).toEqual(['frozen'])
  })

  it('an Incendiary draft card is live over Cryo and Tesla in either order, and taking it overrides both', () => {
    for (const held of [['frost', 'shock'], ['shock', 'frost']]) {
      const w = rig()
      grab(w, ...held)
      const loadout = { weapon: WEAPONS.pistol, mods: weaponStack(player(w))!.mods!, sequenced: false }
      expect(draftCards(['incendiary'], loadout)[0].verdict, held.join()).toEqual(LIVE)
      grab(w, 'incendiary')
      expect(chips(w), held.join()).toEqual({ frost: overriddenBy('incendiary'), incendiary: LIVE, shock: overriddenBy('incendiary') })
      expect(landed(w), held.join()).toEqual(['burning'])
    }
  })

  it('an empty Cryo entry already on the list keeps its slot when picked, so the preview says Tesla still wins', () => {
    const w = rig(false, [{ id: 'frost', stacks: 0 }, { id: 'shock', stacks: 1 }])
    const p = player(w)
    const loadout = { weapon: WEAPONS.pistol, mods: weaponStack(p)!.mods!, sequenced: false }
    expect(draftCards(['frost'], loadout)[0].verdict).toEqual(overriddenBy('shock'))
    const pk = dropMod(w, 'frost', 30.5, 30.5)
    expect(buildInfoCard(pk, { self: p }).rows.find((r) => r.label === 'On your weapon')?.value).toBe('Tesla Rounds overrides it')

    grab(w, 'frost')
    expect(weaponStack(p)!.mods).toEqual([{ id: 'frost', stacks: 1 }, { id: 'shock', stacks: 1 }])
    expect(chips(w)).toEqual({ frost: overriddenBy('shock'), shock: LIVE })
    expect(landed(w)).toEqual(['electrified'])
  })
})

describe('sequenced casting: each element fires on its own pull, so none is overridden', () => {
  for (const order of permutations(ELEMENTS)) {
    it(`${order.join(' then ')}: all three live, fired in pickup order`, () => {
      const w = rig(true)
      grab(w, ...order)
      expect(chips(w)).toEqual(Object.fromEntries(order.map((id) => [id, LIVE])))
      const strip = buildSequence(player(w), w.modCasting, w.tick)!
      expect(strip.entries.map((e) => [e.id, e.verdict])).toEqual(order.map((id) => [id, undefined]))
      expect(pullElements(w, 4)).toEqual([...order, order[0]].map((id) => [STATUS_OF[id]]))
    })
  }

  it('a modifier between two elements rides with the later one, and both elements still fire', () => {
    const w = rig(true)
    grab(w, 'shock', 'pierce', 'frost')
    expect(chips(w)).toEqual({ frost: LIVE, pierce: LIVE, shock: LIVE })
    expect(pullElements(w, 2)).toEqual([['electrified'], ['frozen']])
  })
})
