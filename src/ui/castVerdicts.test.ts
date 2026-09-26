// #88 on sequenced casting: the mod list is the firing order and each cast
// carries its own element, so no element overrides another. Every case grabs
// real pickups through the sim, fires the real weapon, and holds the loadout,
// strip, inspect and draft verdicts to what each pull actually landed. A pick
// past the weapon's live window is stowed, and every surface says so before
// and after it is taken.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../game/data/items'
import { makeEntity, type Entity, type WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { draftCards } from '../game/systems/draft'
import { equipSlot, weaponStack } from '../game/systems/inventory'
import { STOWED_VERDICT, type ModVerdict } from '../game/systems/modEffect'
import { emptyInput, type InputCmd } from '../game/types'
import { addEntity, createWorld, tickWorld, type World } from '../game/world'
import { buildInfoCard } from './inspectModel'
import { buildLoadout } from './loadoutModel'
import { buildSequence } from './sequenceModel'

const STATUS_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const ELEMENTS = Object.keys(STATUS_OF)
const LIVE: ModVerdict = { kind: 'live' }

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const shoot = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]])

const rig = (mods?: WeaponMod[]): World => {
  const w = createWorld(1, 1)
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

const chips = (w: World): [string, ModVerdict][] => buildLoadout(player(w))!.mods.map((c) => [c.id, c.verdict])

/** What the inspect card of a mod pickup says it would do on the player's gun. */
const pickupCard = (w: World, modId: string): string | undefined =>
  buildInfoCard(dropMod(w, modId, 30.5, 30.5), { self: player(w) }).rows.find((r) => r.label === 'On your weapon')?.value

const draftVerdict = (w: World, modId: string): ModVerdict | undefined =>
  draftCards([modId], { weapon: WEAPONS.pistol, mods: weaponStack(player(w))?.mods ?? [] })[0].verdict

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

describe('each element fires on its own pull, so none is overridden', () => {
  for (const order of permutations(ELEMENTS)) {
    it(`${order.join(' then ')}: all three live, fired in pickup order`, () => {
      const w = rig()
      grab(w, ...order)
      expect(chips(w)).toEqual(order.map((id) => [id, LIVE]))
      const strip = buildSequence(player(w), w.tick)!
      expect(strip.entries.map((e) => [e.id, e.verdict])).toEqual(order.map((id) => [id, undefined]))
      expect(pullElements(w, 4)).toEqual([...order, order[0]].map((id) => [STATUS_OF[id]]))
    })
  }

  it('a modifier between two elements rides with the later one, and both elements still fire', () => {
    const w = rig()
    grab(w, 'shock', 'pierce', 'frost')
    expect(chips(w)).toEqual([['shock', LIVE], ['pierce', LIVE], ['frost', LIVE]])
    expect(pullElements(w, 2)).toEqual([['electrified'], ['frozen']])
  })

  it('a Cryo pickup reads live to a Tesla holder, and taking it leaves both live', () => {
    const w = rig()
    grab(w, 'shock')
    expect(pickupCard(w, 'frost')).toBeUndefined()
    expect(draftVerdict(w, 'frost')).toEqual(LIVE)
    expect(draftVerdict(w, 'shock')).toEqual({ kind: 'inert', reason: 'already maxed' })
    grab(w, 'frost')
    expect(chips(w)).toEqual([['shock', LIVE], ['frost', LIVE]])
    expect(pullElements(w, 2)).toEqual([['electrified'], ['frozen']])
  })

  it('an empty Cryo entry already on the list keeps its slot when picked, so it fires first', () => {
    const w = rig([{ id: 'frost', stacks: 0 }, { id: 'shock', stacks: 1 }])
    expect(draftVerdict(w, 'frost')).toEqual(LIVE)
    grab(w, 'frost')
    expect(weaponStack(player(w))!.mods).toEqual([{ id: 'frost', stacks: 1 }, { id: 'shock', stacks: 1 }])
    expect(pullElements(w, 2)).toEqual([['frozen'], ['electrified']])
  })
})

describe('a pick past the live window is stowed, and says so everywhere', () => {
  // The pistol has 4 slots; these four fill it.
  const full = ['pierce', 'bounce', 'homing', 'frost']

  it('before the pick: the draft card and the pickup card both say stowed', () => {
    const w = rig()
    grab(w, ...full)
    expect(draftVerdict(w, 'shock')).toEqual(STOWED_VERDICT)
    expect(pickupCard(w, 'shock')).toBe(STOWED_VERDICT.reason)
  })

  it('a repeat pick stacks in place, so it is live, not stowed', () => {
    const w = rig()
    grab(w, ...full)
    expect(draftVerdict(w, 'pierce')).toEqual(LIVE)
  })

  it('after the pick: the loadout chip, the strip and the fire path all agree it is stowed', () => {
    const w = rig()
    grab(w, ...full, 'shock')
    expect(listed(w)).toEqual([...full, 'shock'])
    expect(chips(w).at(-1)).toEqual(['shock', STOWED_VERDICT])
    const strip = buildSequence(player(w), w.tick)!
    expect(strip.entries.map((e) => e.live)).toEqual([true, true, true, true, false])
    expect(pullElements(w, 3).flat()).not.toContain('electrified')
  })

  it('swapping the stowed mod into the window makes it live and it fires', () => {
    const w = rig()
    grab(w, ...full, 'shock')
    const input = new Map([[0, { ...emptyInput(), modSwap: (3 << 8) | 4 }]])
    tickWorld(w, input)
    expect(listed(w)).toEqual(['pierce', 'bounce', 'homing', 'shock', 'frost'])
    expect(chips(w).map(([id, v]) => [id, v.kind])).toEqual([['pierce', 'live'], ['bounce', 'live'], ['homing', 'live'], ['shock', 'live'], ['frost', 'inert']])
    expect(pullElements(w, 2)).toEqual([['electrified'], ['electrified']])
  })
})
