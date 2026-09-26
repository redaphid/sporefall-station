// Shock-chain damage reads the `electrified` key of the #78 resist table, the
// same way elementSystem reads `burning`/`poisoned`/`spore` and applyDamage reads
// `physical`. State is set exactly through deserializeWorld, the chain is fired
// through the e2e debug API (its only in-game caller), and the world is ticked.

import { beforeEach, describe, expect, it } from 'vitest'
import { createDebugApi } from '../debug'
import { makeEntity, type Entity } from '../entity'
import { deserializeWorld, serializeWorld } from '../serialize'
import { runTicks } from '../testkit'
import { addEntity, createWorld, type World } from '../world'
import { wet } from './interactions'

const HP = 100
const BASE_SHOCK = 20

const npc = (w: World, x: number, resist?: Record<string, number>): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, 20))
  e.health = { hp: HP, max: HP, iframes: 0 }
  if (resist) e.resist = resist
  wet(w, e)
  return e
}

/** Round-trip through WorldJson so each case starts from an exact, serialized state. */
const exact = (w: World): World => deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))

const hp = (w: World, id: number): number | undefined => w.byId.get(id)?.health?.hp

const shockEvents = (w: World) => w.events.filter((ev) => ev.type === 'shock')

describe('shock chain honours the electrified resist key', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('no resist table takes exactly the base shock', () => {
    const id = npc(w, 20).id
    const s = exact(w)
    createDebugApi(s).shock(id)
    expect(hp(s, id)).toBe(HP - BASE_SHOCK)
  })

  it('electrified: 2 takes double shock damage', () => {
    const id = npc(w, 20, { electrified: 2 }).id
    const s = exact(w)
    createDebugApi(s).shock(id)
    expect(hp(s, id)).toBe(HP - 2 * BASE_SHOCK)
  })

  it('electrified: 0 takes no shock damage and emits no shock hit', () => {
    const id = npc(w, 20, { electrified: 0 }).id
    const s = exact(w)
    createDebugApi(s).shock(id)
    expect(hp(s, id)).toBe(HP)
    expect(shockEvents(s)).toHaveLength(0)
    expect(s.byId.get(id)!.health!.lastHurtTick).toBeUndefined()
  })

  it('fractional multipliers round like the DOT path', () => {
    const id = npc(w, 20, { electrified: 0.33 }).id
    const s = exact(w)
    createDebugApi(s).shock(id)
    expect(hp(s, id)).toBe(HP - Math.round(BASE_SHOCK * 0.33))
  })

  it('other resist keys do not bleed into shock damage', () => {
    const id = npc(w, 20, { physical: 0, burning: 0, poisoned: 0, spore: 0 }).id
    const s = exact(w)
    createDebugApi(s).shock(id)
    expect(hp(s, id)).toBe(HP - BASE_SHOCK)
  })

  it('an immune body still conducts the arc to the wet body beyond it', () => {
    const a = npc(w, 20).id
    const insulated = npc(w, 21, { electrified: 0 }).id
    const far = npc(w, 22, { electrified: 2 }).id
    const s = exact(w)
    createDebugApi(s).shock(a)
    expect(hp(s, a)).toBe(HP - BASE_SHOCK)
    expect(hp(s, insulated)).toBe(HP)
    expect(hp(s, far)).toBe(HP - 2 * BASE_SHOCK)
    expect(shockEvents(s).map((ev) => ('targetId' in ev ? ev.targetId : -1))).toEqual([a, far])
  })

  it('a weakness can make the arc lethal where the base shock is not', () => {
    const weak = addEntity(w, makeEntity('npc', 'civilian', 20, 20))
    weak.health = { hp: 30, max: 30, iframes: 0 }
    weak.resist = { electrified: 2 }
    wet(w, weak)
    const neutral = addEntity(w, makeEntity('npc', 'civilian', 21, 20))
    neutral.health = { hp: 30, max: 30, iframes: 0 }
    wet(w, neutral)
    const s = exact(w)
    createDebugApi(s).shock(weak.id)
    runTicks(s, new Map(), 1)
    expect(s.byId.get(weak.id)?.dead === true || !s.byId.has(weak.id)).toBe(true)
    expect(hp(s, neutral.id)).toBe(30 - BASE_SHOCK)
  })

  it('negative multipliers never heal', () => {
    const id = npc(w, 20, { electrified: -3 }).id
    const s = exact(w)
    createDebugApi(s).shock(id)
    expect(hp(s, id)).toBe(HP)
  })
})
