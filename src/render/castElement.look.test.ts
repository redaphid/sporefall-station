// Every shard, shrapnel fragment and blast applies the element that ends its
// round's cast (#119), and looks like exactly that element (#118). Each cast of
// each ordering fires through the real combat and projectile systems in
// sequenced casting; the look is composed with the renderer's own functions.

import { describe, expect, it } from 'vitest'
import { MODS } from '../game/data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { combatSystem } from '../game/systems/combat'
import { weaponStack } from '../game/systems/inventory'
import { projectileSystem } from '../game/systems/projectiles'
import { hasStatus } from '../game/systems/statusFx'
import { arm } from '../game/testkit'
import { emptyInput, type SimEvent } from '../game/types'
import { addEntity, createWorld, type World } from '../game/world'
import { blastTint, composeBulletTraits } from './bulletVisuals'
import { tintForEvent } from './juice'
import { modPickupColor } from './modColors'

const STATUS_OF: Record<string, string> = { frost: 'frozen', incendiary: 'burning', shock: 'electrified' }
const isElement = (id: string): boolean => id in STATUS_OF

/** The test's own statement of the casts: each ends at an element, and any
 * modifiers after the last element form a bare cast. `start` is the cast's
 * position in the list (the machine gun's six slots hold every list here). */
const castsOf = (list: string[]): { start: number; ids: string[]; element?: string }[] => {
  const out: { start: number; ids: string[]; element?: string }[] = []
  let start = 0
  list.forEach((id, i) => {
    if (!isElement(id)) return
    out.push({ start, ids: list.slice(start, i + 1), element: id })
    start = i + 1
  })
  if (start < list.length) out.push({ start, ids: list.slice(start) })
  return out
}

const orderings = (xs: string[]): string[][] =>
  [[] as string[]].concat(xs.flatMap((x, i) => orderings([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])))

const body = (w: World, x: number, y: number, hp: number): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

/** A machine gun facing east at a 1-hp body, with a pack around it inside
 * every blast. */
const BASE: WorldJson = (() => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = []
  arm(p, 'machinegun')
  p.facing = 0
  body(w, 24, 20, 1)
  for (const [x, y] of [[24.8, 20.9], [24.8, 19.1], [23.4, 21.1]]) body(w, x, y, 400)
  return serializeWorld(w)
})()

/** Fire the cast that starts at list position `at`, until its round dies. */
const castAt = (list: string[], at: number): { round: Entity; kids: Entity[]; events: SimEvent[]; pack: Entity[] } => {
  const w = deserializeWorld(BASE)
  const p = w.entities.find((e) => e.playerCtl)!
  p.health!.iframes = 0
  const stack = weaponStack(p)!
  stack.mods = list.map((id): WeaponMod => ({ id, stacks: 1 }))
  stack.castIndex = at
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  const round = w.entities.find((e) => e.kind === 'projectile')!
  const events: SimEvent[] = [...w.events]
  for (let i = 0; i < 40 && !round.dead; i++) {
    w.events = []
    projectileSystem(w)
    events.push(...w.events)
    w.tick++
  }
  return {
    round,
    kids: w.entities.filter((e) => e.kind === 'projectile' && e !== round),
    events,
    pack: w.entities.filter((e) => e.kind === 'npc' && e.health!.max === 400),
  }
}

const applied = (k: Entity): string | undefined => {
  const status = k.projectile!.onHit?.status
  return Object.keys(STATUS_OF).find((id) => STATUS_OF[id] === status)
}
const shown = (k: Entity): string[] => (k.projectile!.mods ?? []).map((x) => x.id).filter(isElement)

describe('every cast of every ordering: shards and shrapnel apply the cast element and look it', () => {
  it('all 326 orderings of every subset of frost, shock, split, splinterShot, rapid', () => {
    const lists = orderings(['frost', 'shock', 'split', 'splinterShot', 'rapid'])
    expect(lists).toHaveLength(326)
    let checked = 0
    for (const list of lists) {
      for (const cast of castsOf(list)) {
        const label = `${list.join(' > ')} @${cast.start}`
        const { round, kids } = castAt(list, cast.start)
        expect(applied(round), `${label}: round`).toBe(cast.element)
        const groups: [string, number, number][] = [['split', 0.12, 2], ['splinterShot', 0.1, 4]]
        for (const [id, radius, count] of groups) {
          const mine = kids.filter((k) => k.radius === radius)
          expect(mine, `${label}: ${id} children`).toHaveLength(cast.ids.includes(id) ? count : 0)
          for (const k of mine) {
            expect(applied(k), `${label}: ${id} applies`).toBe(cast.element)
            expect(shown(k), `${label}: ${id} shows`).toEqual(cast.element ? [cast.element] : [])
            expect(composeBulletTraits(k.projectile!.mods), `${label}: ${id} look`).toEqual(composeBulletTraits(round.projectile!.mods))
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })
})

describe('every cast of every ordering: blasts apply the cast element to every body they damage and look it', () => {
  for (const blaster of ['explosive', 'detonator']) {
    it(`all 326 orderings of every subset of frost, incendiary, shock, ${blaster}, rapid`, () => {
      const lists = orderings(['frost', 'incendiary', 'shock', blaster, 'rapid'])
      expect(lists).toHaveLength(326)
      let checked = 0
      for (const list of lists) {
        for (const cast of castsOf(list)) {
          const label = `${list.join(' > ')} @${cast.start}`
          const { events, pack } = castAt(list, cast.start)
          const booms = events.filter((e): e is Extract<SimEvent, { type: 'explosion' }> => e.type === 'explosion')
          expect(booms, `${label}: blasts`).toHaveLength(cast.ids.includes(blaster) ? 1 : 0)
          if (!booms.length) continue
          const [boom] = booms
          const want = cast.element
          expect(boom.element, `${label}: blast element`).toBe(want)
          expect(blastTint(boom.element), `${label}: blast tint`).toBe(want ? modPickupColor(want) : undefined)
          const cold = want === 'frost' || want === 'shock'
          expect(tintForEvent(boom), `${label}: blast wash`).toEqual(cold ? { warm: 0, cold: 0.8 } : { warm: 0.8, cold: 0 })
          for (const b of pack) {
            expect(b.health!.hp, `${label}: pack damaged`).toBeLessThan(400)
            const on = Object.values(STATUS_OF).filter((s) => hasStatus(b, s))
            expect(on, `${label}: pack statuses`).toEqual(want ? [STATUS_OF[want]] : [])
          }
          checked++
        }
      }
      expect(checked).toBeGreaterThan(200)
    })
  }
})

describe('blast look', () => {
  it('each element blast takes its element hue; a plain blast and a non-element id keep the art colour', () => {
    for (const id of Object.keys(MODS)) expect(blastTint(id)).toBe(MODS[id].onHit ? modPickupColor(id) : undefined)
    expect(blastTint(undefined)).toBeUndefined()
    expect(blastTint('no-such-mod')).toBeUndefined()
  })
})
