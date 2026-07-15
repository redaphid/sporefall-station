import { describe, expect, it } from 'vitest'
import { loadFixture, loadFixtureJson } from './fixtures'
import { serializeWorld } from './serialize'

// The `?world=` boot hook (main.ts) and the e2e recipe both lean on this loader,
// so pin its contract: names resolve, misses throw, reads are isolated clones,
// and the committed feature fixtures round-trip cleanly through deserialize.
describe('fixture loader', () => {
  it('loads a committed fixture by name', () => {
    const j = loadFixtureJson('mid-run')
    expect(j.v).toBe(1)
    expect(j.entities.length).toBeGreaterThan(0)
  })

  it('throws a clear error for an unknown fixture', () => {
    expect(() => loadFixtureJson('does-not-exist')).toThrow(/no such fixture/)
  })

  it('returns an isolated clone each call (mutations do not leak)', () => {
    const a = loadFixtureJson('mid-run')
    a.tick = 99999
    const b = loadFixtureJson('mid-run')
    expect(b.tick).not.toBe(99999)
  })

  it('rehydrates a committed fixture into a live world (checksum passes)', () => {
    const w = loadFixture('mid-run')
    expect(w.entities.length).toBeGreaterThan(0)
    expect(w.byId.get(w.entities[0].id)).toBe(w.entities[0])
  })

  it.each(['combat-stage', 'fire-stage'])('feature fixture %s deserializes and round-trips', (name) => {
    const json = loadFixtureJson(name)
    const world = loadFixture(name)
    // A restored world re-serializes byte-identically to its committed snapshot —
    // proof the `?world=` injection reproduces the pinned state exactly.
    expect(serializeWorld(world)).toEqual(json)
  })
})
