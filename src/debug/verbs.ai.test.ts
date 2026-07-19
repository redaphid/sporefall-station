// The AI introspection verbs: `ai` (why did this NPC do that?), `behaviors`
// (what brains exist?), `setBehavior` (swap/bootstrap a brain at runtime).
// Adversarial cases — unknown ids, brainless entities, hostile params — sit
// next to the happy paths, because the debug surface takes untrusted input.

import { describe, expect, it } from 'vitest'
import { BEHAVIORS } from '../game/systems/behaviors'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { makeEntity } from '../game/entity'
import { emptyInput } from '../game/types'
import { addEntity, createWorld, tickWorld, type World } from '../game/world'
import { runVerb, WRITE_VERBS } from './verbs'

const world = (): World => createWorld(1234, 1)

const run = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, { ...emptyInput() }]]))
}

describe('behaviors verb', () => {
  it('lists the whole registry with descriptions and consideration lists', () => {
    const w = world()
    const reg = JSON.parse(runVerb(w, 'behaviors')) as Record<string, { about: string; considerations: string[] }>
    for (const id of ['basic', 'patrol', 'hunter', 'skittish', 'scavenger']) {
      expect(reg[id].about.length).toBeGreaterThan(0)
      expect(reg[id].considerations.length).toBeGreaterThan(0)
    }
  })
})

describe('ai verb', () => {
  it('dumps the resolved behavior, considerations, and live decision state', () => {
    const w = world()
    spawnPlayer(w, 0, 5.5, 5.5)
    const g = spawnNpc(w, 'gangster', 8.5, 5.5) // archetype default: hunter
    run(w, 10)
    const out = JSON.parse(runVerb(w, `ai ${g.id}`)) as Record<string, unknown>
    expect(out.behavior).toBe('hunter')
    expect(out.considerations).toEqual(BEHAVIORS.hunter.considerations)
    const state = out.state as { goal: string; lastScores: Record<string, number> }
    expect(state.goal).toBeDefined()
    expect(Object.keys(state.lastScores).length).toBeGreaterThan(0) // the "why" trail
    expect(out.unknownBehavior).toBeUndefined()
  })

  it('flags an unknown behavior id instead of lying about what runs', () => {
    const w = world()
    const npc = spawnNpc(w, 'thug', 3.5, 3.5)
    npc.ai!.behavior = 'totally-bogus'
    const out = JSON.parse(runVerb(w, `ai ${npc.id}`)) as Record<string, unknown>
    expect(out.behavior).toBe('totally-bogus')
    expect(out.unknownBehavior).toBe(true)
    expect(out.effective).toBe('basic')
    expect(out.considerations).toEqual(BEHAVIORS.basic.considerations)
  })

  it('errors clearly on an entity with no ai component', () => {
    const w = world()
    const rock = addEntity(w, makeEntity('interactable', 'crate', 2.5, 2.5))
    expect(() => runVerb(w, `ai ${rock.id}`)).toThrow(/no ai component/)
  })
})

describe('setBehavior verb', () => {
  it('is a write verb (deferred onto the sim step by the channel)', () => {
    expect(WRITE_VERBS.has('setBehavior')).toBe(true)
  })

  it('swaps a brain at runtime and the NPC starts living it', () => {
    const w = world()
    const civ = spawnNpc(w, 'civilian', 10.5, 10.5)
    const reply = JSON.parse(
      runVerb(w, `setBehavior ${civ.id} patrol {"waypoints":[{"x":10.5,"y":10.5},{"x":14.5,"y":10.5}]}`),
    ) as Record<string, unknown>
    expect(reply.behavior).toBe('patrol')
    expect(civ.ai!.behavior).toBe('patrol')
    expect(civ.ai!.params?.waypoints).toEqual([
      { x: 10.5, y: 10.5 },
      { x: 14.5, y: 10.5 },
    ])
    run(w, 40)
    expect(civ.ai!.goal).toBe('patrol') // actually walking the beat
  })

  it('bootstraps a whole ai component onto a brainless entity', () => {
    const w = world()
    const crate = addEntity(w, makeEntity('interactable', 'crate', 6.5, 6.5))
    runVerb(w, `setBehavior ${crate.id} scavenger`)
    expect(crate.ai).toBeDefined()
    expect(crate.ai!.behavior).toBe('scavenger')
    expect(crate.ai!.home).toEqual({ x: 6.5, y: 6.5 })
  })

  it('rejects an unknown behavior id and names the known ones', () => {
    const w = world()
    const npc = spawnNpc(w, 'thug', 3.5, 3.5)
    expect(() => runVerb(w, `setBehavior ${npc.id} zigzag`)).toThrow(/unknown behavior "zigzag".*basic.*hunter/s)
    expect(npc.ai!.behavior).toBeUndefined() // untouched on failure
  })

  it('rejects malformed waypoints so a bad patch can never NaN-poison the sim', () => {
    const w = world()
    const npc = spawnNpc(w, 'cop', 3.5, 3.5)
    expect(() => runVerb(w, `setBehavior ${npc.id} patrol {"waypoints":[{"x":"NaN","y":2}]}`)).toThrow(/waypoints/)
    expect(() => runVerb(w, `setBehavior ${npc.id} patrol {"waypoints":"nope"}`)).toThrow(/waypoints/)
    expect(npc.ai!.params).toBeUndefined()
  })

  it('rejects prototype-polluting params outright', () => {
    const w = world()
    const npc = spawnNpc(w, 'cop', 3.5, 3.5)
    expect(() => runVerb(w, `setBehavior ${npc.id} patrol {"__proto__":{"pwned":1}}`)).toThrow(/forbidden key/)
    expect(({} as Record<string, unknown>).pwned).toBeUndefined()
  })

  it('sheds stale decision state so the new brain starts clean', () => {
    const w = world()
    spawnPlayer(w, 0, 5.5, 5.5)
    const g = spawnNpc(w, 'gangster', 8.5, 5.5)
    run(w, 10) // mid-battle: targetId set
    expect(g.ai!.targetId).toBeDefined()
    runVerb(w, `setBehavior ${g.id} scavenger`)
    expect(g.ai!.targetId).toBeUndefined()
    expect(g.ai!.waypoint).toBeUndefined()
    expect(g.ai!.search).toBeUndefined()
  })
})

describe('schema reflection', () => {
  it('the live schema picks up the behavior component fields with no hardcoded list', () => {
    const w = world()
    spawnPlayer(w, 0, 5.5, 5.5)
    const s = spawnNpc(w, 'civilian', 8.5, 5.5)
    s.ai!.behavior = 'scavenger'
    run(w, 10) // let a think record lastScores/goalSince
    const schema = JSON.parse(runVerb(w, 'schema')) as { fields: Record<string, { keys?: string[] }> }
    const aiKeys = schema.fields.ai.keys ?? []
    for (const k of ['behavior', 'lastScores', 'goal', 'goalSince']) expect(aiKeys).toContain(k)
  })
})
