// A bullet's provenance (`projectile.mods`) is what the renderer and every
// co-op peer build its look from, so it must list only what the shot executes
// (#118). A gun holds every mod the player picked, but each pull fires one cast:
// the modifiers before an element plus that element. A round carries only its
// own cast's mods, so a Tesla round never looks like it freezes.
//
// Every case sets exact world state and fires through the real combat system.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { MODS } from '../data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm } from '../testkit'
import { emptyInput } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { combatSystem } from './combat'
import { cycleCasts, liveEntries, sequenceShape } from './modSequence'
import { projectileSystem } from './projectiles'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

const rig = (weapon = 'pistol', mods?: WeaponMod[], castIndex?: number): { w: World; p: Entity } => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = []
  const stack = arm(p, weapon)
  if (mods) stack.mods = mods.map((x) => ({ ...x }))
  if (castIndex !== undefined) stack.castIndex = castIndex
  p.facing = 0
  return { w, p }
}

/** One trigger pull; returns the rounds it spawned. */
const pull = (w: World, p: Entity): Entity[] => {
  const before = new Set(w.entities.map((e) => e.id))
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  return w.entities.filter((e) => !before.has(e.id) && e.kind === 'projectile')
}

/** The first round of each of `n` consecutive pulls. */
const rounds = (mods: WeaponMod[], n: number, weapon = 'pistol'): Entity[] => {
  const { w, p } = rig(weapon, mods)
  return Array.from({ length: n }, () => pull(w, p)[0])
}

const isElement = (id: string): boolean => MODS[id]?.onHit !== undefined
const ids = (b: Entity): string[] => (b.projectile!.mods ?? []).map((x) => x.id)
const shownElements = (b: Entity): string[] => ids(b).filter(isElement)
/** The element mod whose status this round applies on a hit, or none. */
const landingElement = (b: Entity): string[] => {
  const status = b.projectile!.onHit?.status
  if (!status) return []
  return Object.values(MODS).filter((d) => d.onHit?.status === status).map((d) => d.id)
}

describe("a round's provenance lists only its own cast", () => {
  it('Tesla then Cryo: the first round zaps and carries only shock, the second freezes and carries only frost', () => {
    const [a, b] = rounds([m('shock'), m('frost')], 2)
    expect(a.projectile!.onHit?.status).toBe('electrified')
    expect(a.projectile!.mods).toEqual([m('shock')])
    expect(b.projectile!.onHit?.status).toBe('frozen')
    expect(b.projectile!.mods).toEqual([m('frost')])
  })

  it('modifiers, with their stacks, ride only the element after them', () => {
    const [a, b, c] = rounds([m('shock'), m('pierce', 2), m('incendiary'), m('rapid', 3), m('frost')], 3, 'machinegun')
    expect(a.projectile!.mods).toEqual([m('shock')])
    expect(a.projectile!.pierceLeft).toBeUndefined()
    expect(b.projectile!.mods).toEqual([m('incendiary'), m('pierce', 2)])
    expect(b.projectile!.pierceLeft).toBe(2)
    expect(c.projectile!.mods).toEqual([m('frost'), m('rapid', 3)])
  })

  it('a gun with only non-element mods keeps every one on every round', () => {
    for (const b of rounds([m('pierce'), m('bounce'), m('lifesteal')], 3)) expect(b.projectile!.mods).toEqual([m('bounce'), m('lifesteal'), m('pierce')])
  })

  it("a cast's element overrides the base weapon element, and only the mod shows", () => {
    const [b] = rounds([m('shock')], 1, 'freezeRay')
    expect(b.projectile!.onHit?.status).toBe('electrified')
    expect(b.projectile!.mods).toEqual([m('shock')])
  })

  it('a repeated element entry is a cast of its own each time', () => {
    const got = rounds([m('frost'), m('shock'), m('frost')], 3)
    expect(got.map((b) => b.projectile!.mods)).toEqual([[m('frost')], [m('shock')], [m('frost')]])
  })

  it.each([
    ['a zero-stack element', [m('frost'), m('shock', 0)]],
    ['a negative-stack element', [m('frost'), m('shock', -2)]],
    ['a NaN-stack element', [m('frost'), m('shock', NaN)]],
    ['an unknown id', [m('frost'), m('no-such-mod')]],
  ])('%s after an element neither lands nor shows, on any pull', (_label, mods) => {
    for (const b of rounds(mods, 3)) {
      expect(b.projectile!.onHit?.status).toBe('frozen')
      expect(b.projectile!.mods).toEqual([m('frost')])
    }
  })

  it('every ordering of every subset, every pull of the cycle: the element shown is the element that lands', () => {
    const pool = ['frost', 'incendiary', 'shock', 'pierce', 'rapid']
    const arrangements = (xs: string[]): string[][] =>
      [[] as string[]].concat(xs.flatMap((x, i) => arrangements([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])))
    const shape = sequenceShape(WEAPONS.pistol)
    const lists = arrangements(pool)
    expect(lists).toHaveLength(326)
    for (const list of lists) {
      const mods = list.map((id) => m(id))
      const cycle = Math.max(1, cycleCasts(mods, shape))
      const shown: string[] = []
      for (const b of rounds(mods, cycle)) {
        const label = list.join(' > ') || '(none)'
        expect(shownElements(b), label).toEqual(landingElement(b))
        expect(shownElements(b).length, label).toBeLessThanOrEqual(1)
        shown.push(...ids(b))
      }
      // Across one cycle the rounds show exactly the live window, each mod once.
      expect(shown.sort(), list.join(' > ')).toEqual(liveEntries(mods, shape.slots).map((i) => list[i]).sort())
    }
  })
})

describe('provenance survives the paths a round takes after it spawns', () => {
  it("split shards carry their cast's provenance, never another cast's element", () => {
    const { w, p } = rig('pistol', [m('shock'), m('split'), m('frost')], 1)
    const victim = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
    victim.health = { hp: 1, max: 40, iframes: 0 }
    const [parent] = pull(w, p)
    expect(parent.projectile!.mods).toEqual([m('frost'), m('split')])
    for (let i = 0; i < 30 && w.entities.some((e) => e.projectile?.split && !e.dead); i++) {
      projectileSystem(w)
      w.tick++
    }
    const shards = w.entities.filter((e) => e.kind === 'projectile' && !e.dead)
    expect(shards.length).toBeGreaterThan(0)
    for (const s of shards) expect(ids(s)).not.toContain('shock')
  })

  it("splinter fragments carry their cast's element and only its provenance", () => {
    const { w, p } = rig('pistol', [m('frost'), m('splinterShot'), m('shock')], 1)
    const [parent] = pull(w, p)
    parent.projectile!.ttl = 1
    projectileSystem(w)
    const frags = w.entities.filter((e) => e.kind === 'projectile' && !e.dead && e.id !== parent.id)
    expect(frags.length).toBeGreaterThan(0)
    for (const f of frags) {
      expect(f.projectile!.onHit?.status).toBe('electrified')
      expect(ids(f)).toEqual(['shock', 'splinterShot'])
    }
  })

  it("a cast's provenance round-trips through world serialization byte for byte", () => {
    const { w, p } = rig('pistol', [m('shock'), m('pierce'), m('frost')], 1)
    pull(w, p)
    const json = serializeWorld(w)
    const back = deserializeWorld(json)
    const [b] = back.entities.filter((e) => e.kind === 'projectile')
    expect(b.projectile!.mods).toEqual([m('frost'), m('pierce')])
    expect(JSON.stringify(serializeWorld(back))).toBe(JSON.stringify(json))
  })
})
