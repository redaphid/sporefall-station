import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { GameHarness } from './harness'
import { applyFixture, replay, saveWorld, worldFromHeader, type Recording } from './record'
import { serializeEntity } from './verbs'

// Build a real recording by driving a full co-op session: host + two bots with
// distinct scripted movement + attacks, run for a while, and seal it.
const recordSession = (): Recording => {
  const h = new GameHarness()
  h.create({ seed: 20260715, classId: 'soldier', name: 'Host' })
  h.addBot({ name: 'Bravo', classId: 'thief' })
  h.addBot({ name: 'Charlie', classId: 'soldier' })
  h.start()
  h.startRecording()
  // Scripted programmatic inputs: everyone pushes into the populated city and
  // fires — deterministically triggering AI/combat (hits + deaths).
  h.setInput(0, { moveX: -1, attack: true })
  h.setInput(1, { moveX: -1, attack: true })
  h.setInput(2, { moveX: -1, moveY: 1 })
  h.stepTicks(200)
  return h.stopRecording()
}

describe('record + replay', () => {
  it('replays a recorded session to the SAME final state and events', () => {
    const rec = recordSession()
    expect(rec.ticks).toHaveLength(200)
    const result = replay(rec)
    expect(result.finalStateMatch).toBe(true)
    expect(result.eventMismatches).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('is deterministic: replaying the same recording twice is identical', () => {
    const rec = recordSession()
    const a = replay(rec)
    const b = replay(rec)
    expect(a).toEqual(b)
    expect(a.ok).toBe(true)
  })

  it('two independent recordings of the same script are byte-identical', () => {
    // Inputs are the only entropy — same script ⇒ same bytes on the wire.
    expect(JSON.stringify(recordSession())).toBe(JSON.stringify(recordSession()))
  })

  it('captures real events (deaths/hits) in the stream, and replay reproduces them', () => {
    const rec = recordSession()
    const allEvents = rec.ticks.flatMap((t) => t.events)
    expect(allEvents.length).toBeGreaterThan(0)
    // Replay's per-tick event comparison passing means every event lines up.
    expect(replay(rec).eventMismatches).toEqual([])
  })

  it('detects nondeterminism: a tampered final-state checksum fails replay', () => {
    const rec = recordSession()
    const tampered: Recording = {
      ...rec,
      finalState: rec.finalState.map((e, i) => (i === 0 ? { ...e, __injected: true } : e)),
    }
    expect(replay(tampered).finalStateMatch).toBe(false)
  })

  it('worldFromHeader rebuilds an identical genesis world from the seed', () => {
    const rec = recordSession()
    const a = worldFromHeader(rec.header)
    const b = worldFromHeader(rec.header)
    expect(a.entities.map(serializeEntity)).toEqual(b.entities.map(serializeEntity))
  })
})

describe('save / load fixtures', () => {
  it('round-trips full world state through a fixture', () => {
    const h = new GameHarness()
    h.create({ seed: 4242, classId: 'soldier' })
    h.start()
    spawnNpc(h.world, 'cop', 12, 12)
    h.stepTicks(30)
    const fixture = saveWorld(h.world)
    const before = h.world.entities.map(serializeEntity)

    // Mutate, then restore from the fixture: state returns to the snapshot.
    h.stepTicks(30)
    applyFixture(h.world, fixture)
    expect(h.world.tick).toBe(fixture.tick)
    expect(h.world.entities.map(serializeEntity)).toEqual(before)
    // byId is rebuilt so entity lookups keep working after a load.
    expect(h.world.byId.get(h.world.entities[0].id)).toBe(h.world.entities[0])
  })
})
