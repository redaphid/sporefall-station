// Coverage for the #49 world-lifecycle verbs added to the bridge: `dump`,
// `load`, `step`/`tick`, and the `schema` reflection verb. Per the project's
// exhaustive+adversarial rule, every verb gets a happy path AND a hostile one,
// and where the sim is exercised the world state is SET EXACTLY via a
// serialize→deserialize round-trip (never a from-scratch fixture).

import { afterEach, describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { expectWorldEqual, runTicks } from '../game/testkit'
import { createWorld, tickWorld, type World } from '../game/world'
import { runVerb } from './verbs'

// A deterministic mid-run world whose sim RNG has genuinely advanced past its
// seed (mirrors serialize.test.ts), so round-trips actually prove RNG restore.
const buildMidRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, 'soldier', sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  return runTicks(w, new Map([[0, { moveX: -1, attack: true }]]), 50)
}

describe('dump / load', () => {
  it('dump emits a versioned WorldJson with entities + RNG position', () => {
    const original = buildMidRun(1)
    const j = JSON.parse(runVerb(original, 'dump'))
    expect(j.v).toBe(1)
    expect(Array.isArray(j.entities)).toBe(true)
    expect(j.entities.length).toBe(original.entities.length)
    expect(typeof j.rng).toBe('number')
    expect(typeof j.baseRng).toBe('number')
  })

  it('dump → load ROUND-TRIPS to a world equal to the original (in place)', () => {
    const original = buildMidRun(20260715)
    const dumped = runVerb(original, 'dump')

    // Load into an unrelated world; the target OBJECT IDENTITY must survive so a
    // closed-over reference (the channel holds one) keeps pointing at it.
    const target = createWorld(999, 2)
    const ref = target
    const rep = JSON.parse(runVerb(target, `load ${dumped}`))
    expect(Object.is(ref, target)).toBe(true)
    expect(rep.ok).toBe(true)
    expect(rep.total).toBe(original.entities.length)
    expectWorldEqual(target, original)
  })

  it('load rejects usage / non-object / malformed JSON cleanly', () => {
    const w = deserializeWorld(serializeWorld(buildMidRun(2)))
    expect(() => runVerb(w, 'load')).toThrow(/usage/)
    for (const bad of ['5', '"hi"', '[1,2]', 'null', 'true']) {
      expect(() => runVerb(w, `load ${bad}`)).toThrow(/must be a WorldJson object/)
    }
    expect(() => runVerb(w, 'load {not json}')).toThrow()
  })

  it('load rejects a checksum-drifted snapshot (seed/floor mismatch)', () => {
    const j = JSON.parse(runVerb(buildMidRun(7), 'dump'))
    const drifted = JSON.stringify({ ...j, levelChecksum: (j.levelChecksum ^ 1) >>> 0 })
    expect(() => runVerb(createWorld(1, 1), `load ${drifted}`)).toThrow(/checksum drift/)
  })
})

describe('load — prototype pollution (adversarial)', () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted
  })

  it('does NOT pollute Object.prototype via a __proto__ key in the payload', () => {
    const dumped = runVerb(buildMidRun(3), 'dump')
    // Splice a literal `__proto__` OWN key into the JSON text (an object literal
    // could not — it would set the prototype, not an own key).
    const evil = dumped.replace('"entities":[', '"entities":[{"__proto__":{"polluted":true}},')
    expect(() => runVerb(createWorld(1, 1), `load ${evil}`)).toThrow(/forbidden key/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does NOT pollute via a nested constructor.prototype key', () => {
    const dumped = runVerb(buildMidRun(4), 'dump')
    const evil = dumped.replace('"mission":', '"constructor":{"prototype":{"polluted":true}},"mission":')
    expect(() => runVerb(createWorld(1, 1), `load ${evil}`)).toThrow(/forbidden key/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('a clean snapshot loads WITHOUT tripping the guard', () => {
    const dumped = runVerb(buildMidRun(5), 'dump')
    expect(() => runVerb(createWorld(1, 1), `load ${dumped}`)).not.toThrow()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('step / tick', () => {
  it('advances the tick counter by N and reports it', () => {
    const w = deserializeWorld(serializeWorld(buildMidRun(11)))
    const before = w.tick
    const rep = JSON.parse(runVerb(w, 'step 5'))
    expect(rep.advanced).toBe(5)
    expect(rep.tick).toBe(before + 5)
    expect(w.tick).toBe(before + 5)
  })

  it('defaults to a single tick, and `tick` is an alias', () => {
    const a = deserializeWorld(serializeWorld(buildMidRun(12)))
    const b = deserializeWorld(serializeWorld(buildMidRun(12)))
    const t = a.tick
    runVerb(a, 'step')
    runVerb(b, 'tick')
    expect(a.tick).toBe(t + 1)
    expect(b.tick).toBe(t + 1)
  })

  it('steps DETERMINISTICALLY — equal to hand-driven tickWorld with neutral input', () => {
    const stepped = deserializeWorld(serializeWorld(buildMidRun(13)))
    const manual = deserializeWorld(serializeWorld(buildMidRun(13)))
    runVerb(stepped, 'step 7')
    for (let i = 0; i < 7; i++) tickWorld(manual, new Map())
    expectWorldEqual(stepped, manual)
  })

  it('rejects a negative / fractional / non-numeric count WITHOUT advancing', () => {
    const w = deserializeWorld(serializeWorld(buildMidRun(14)))
    const before = w.tick
    expect(() => runVerb(w, 'step -1')).toThrow(/non-negative integer/)
    expect(() => runVerb(w, 'step 1.5')).toThrow(/non-negative integer/)
    expect(() => runVerb(w, 'step abc')).toThrow(/expected a number/)
    expect(w.tick).toBe(before)
  })
})

describe('schema (reflection)', () => {
  it('is empty on an empty world', () => {
    const s = JSON.parse(runVerb(createWorld(1234, 1), 'schema'))
    expect(s.entityCount).toBe(0)
    expect(s.kinds).toEqual({})
    expect(s.archetypes).toEqual({})
    expect(s.fields).toEqual({})
  })

  it('enumerates kinds, archetypes, and component fields from LIVE entities', () => {
    const w = createWorld(1234, 1)
    spawnNpc(w, 'cop', 5, 5)
    spawnNpc(w, 'cop', 6, 6)
    spawnNpc(w, 'thug', 7, 7)
    spawnPlayer(w, 0, 'soldier', 8, 8)
    const s = JSON.parse(runVerb(w, 'schema'))

    expect(s.entityCount).toBe(4)
    expect(s.kinds).toEqual({ npc: 3, player: 1 })
    expect(s.archetypes.cop).toEqual({ kind: 'npc', count: 2 })
    expect(s.archetypes.thug).toEqual({ kind: 'npc', count: 1 })
    // The player's archetype is 'player'; its classId lives in playerCtl.
    expect(s.archetypes.player).toEqual({ kind: 'player', count: 1 })
    expect(s.fields.playerCtl.keys).toContain('classId')

    // Core fields present on every entity.
    expect(s.fields.id.count).toBe(4)
    expect(s.fields.pos.types).toContain('object')
    expect(s.fields.pos.keys).toEqual(['x', 'y'])
    // Component fields carry their nested sub-keys, counted only on carriers.
    expect(s.fields.health.count).toBe(4)
    expect(s.fields.health.keys).toEqual(['hp', 'iframes', 'max'])
    expect(s.fields.ai.count).toBe(3) // NPCs only
    expect(s.fields.playerCtl.count).toBe(1) // the player only
  })

  it('enumerates UNKNOWN/future components dynamically (no hardcoded list)', () => {
    const w = createWorld(1234, 1)
    const e = spawnNpc(w, 'cop', 1, 1)
    ;(e as unknown as { futureThing: { z: number; tags: string[] } }).futureThing = { z: 42, tags: ['a'] }
    const s = JSON.parse(runVerb(w, 'schema'))
    expect(s.fields.futureThing.count).toBe(1)
    expect(s.fields.futureThing.types).toEqual(['object'])
    expect(s.fields.futureThing.keys).toEqual(['tags', 'z'])
  })
})
