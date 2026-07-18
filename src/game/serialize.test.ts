import { describe, expect, it } from 'vitest'
import { spawnNpc } from './populate'
import { spawnPlayer } from './player'
import { deserializeWorld, serializeWorld } from './serialize'
import { expectWorldEqual, loadFixtureJson, runTicks } from './testkit'
import { emptyInput, type InputCmd } from './types'
import { createWorld, tickWorld, type World } from './world'

// A small, deterministic mid-run world: a player and two NPCs, driven for a
// while so the sim RNG stream has genuinely advanced past its seed.
const buildMidRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  return runTicks(w, new Map([[0, { moveX: -1, attack: true }]]), 50)
}

describe('serializeWorld / deserializeWorld', () => {
  it('round-trips the full world verbatim', () => {
    const w = buildMidRun(20260715)
    const restored = deserializeWorld(serializeWorld(w))
    // The snapshot of the restored world equals the original's, field for field.
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
    // Derived structures are rebuilt: byId points at the live entity instances.
    expect(restored.byId.get(restored.entities[0].id)).toBe(restored.entities[0])
    // RNG stream position survives (it is what the next tick draws from).
    expect(restored.rng.state()).toBe(w.rng.state())
    expect(restored.baseRng.state()).toBe(w.baseRng.state())
  })

  it('is BYTE-IDENTICAL on subsequent ticks (the RNG-state guarantee)', () => {
    const original = buildMidRun(0xdecaf)
    const restored = deserializeWorld(serializeWorld(original))

    // Tick both with the same inputs for a while; the seeded sim dice must line
    // up tick-for-tick, which only holds because the RNG position was restored.
    const inputs = new Map<number, InputCmd>([[0, { ...emptyInput(), moveX: 1, attack: true }]])
    for (let i = 0; i < 40; i++) {
      tickWorld(original, new Map(inputs))
      tickWorld(restored, new Map(inputs))
    }
    expectWorldEqual(restored, original)
  })

  it('rejects a fixture whose level checksum drifts from seed+floor', () => {
    const j = serializeWorld(buildMidRun(7))
    expect(() => deserializeWorld({ ...j, levelChecksum: j.levelChecksum ^ 1 })).toThrow(/checksum drift/)
  })

  it('survives a real JSON string round-trip (no NaN/Map/undefined leaks)', () => {
    const j = serializeWorld(buildMidRun(1))
    const reparsed = JSON.parse(JSON.stringify(j))
    const restored = deserializeWorld(reparsed)
    expect(serializeWorld(restored)).toEqual(j)
  })
})

describe('fixture-driven test: load JSON → act → assert JSON', () => {
  it('loads mid-run.json, applies 10 ticks of the action, and matches mid-run-plus-10.json', () => {
    const w = deserializeWorld(loadFixtureJson('mid-run'))
    runTicks(w, new Map([[0, { moveX: -1, attack: true }]]), 10)
    expect(serializeWorld(w)).toEqual(loadFixtureJson('mid-run-plus-10'))
  })
})
