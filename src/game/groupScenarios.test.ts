// The group-layer set-pieces (`?scenario=tide-*`, `hound-ring`, `hive-spread`)
// are the reproducible "interesting situations" a capture agent records and
// shares via `?state=` (docs/testing-video.md). Two promises are tested here:
//   1. they are SHAREABLE — they never touch a tile, so a world captured from
//      one restores through deserializeWorld (which refuses a level drift);
//   2. they are REPRODUCIBLE — on the documented seed, the moment each one
//      exists to show really happens, on the same tick, every time.

import { describe, expect, it } from 'vitest'
import { levelChecksum } from './levelgen/level'
import { spawnPlayer } from './player'
import { populateWorld } from './populate'
import { applyScenario, GROUP_SCENARIOS } from './scenarios'
import { deserializeWorld, serializeWorld } from './serialize'
import { emptyInput, type SimEvent } from './types'
import { createWorld, tickWorld, type World } from './world'

/** The seed every group scenario is documented against (docs/design/enemy-groups.md). */
const GROUP_SCENARIO_SEED = 3

const stage = (name: string, seed = GROUP_SCENARIO_SEED): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  applyScenario(w, name)
  return w
}

/** Run up to `n` ticks, returning the tick each event type FIRST fired. */
const firsts = (w: World, n: number, log?: SimEvent[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, emptyInput()]]))
    for (const e of w.events) {
      out[e.type] ??= w.tick
      log?.push(e)
    }
  }
  return out
}

const player = (w: World) => w.entities.find((e) => e.playerCtl)!

describe('group scenarios are shareable', () => {
  for (const name of Object.keys(GROUP_SCENARIOS)) {
    it(`${name}: leaves the level untouched and restores from a mid-scene capture`, () => {
      const fresh = createWorld(GROUP_SCENARIO_SEED, 1)
      const w = stage(name)
      expect(levelChecksum(w.level)).toBe(levelChecksum(fresh.level))
      firsts(w, 150)
      const json = JSON.parse(JSON.stringify(serializeWorld(w)))
      const back = deserializeWorld(json)
      firsts(w, 60)
      firsts(back, 60)
      expect(serializeWorld(back)).toEqual(serializeWorld(w))
    })
  }
})

describe('group scenarios reproduce their moment', () => {
  it('tide-staging: the muster gathers out of sight, then every fighter commits together', () => {
    const w = stage('tide-staging')
    const g = w.groups!.list[0]
    expect(g.phase).toBe('staging')
    const t = firsts(w, 30 * 20)
    expect(t.groupPhase).toBeGreaterThan(20) // a real gather, not a formality
    expect(g.phase).toBe('attack')
  })

  it('tide-siege: the battery sets up and shells the player', () => {
    const w = stage('tide-siege')
    const log: SimEvent[] = []
    const t = firsts(w, 30 * 20, log)
    expect(t.lob).toBeDefined()
    expect(log.some((e) => e.type === 'explosion')).toBe(true)
  })

  it('tide-medic: the wounded are patched by the Bog Mender', () => {
    const w = stage('tide-medic')
    const log: SimEvent[] = []
    firsts(w, 30 * 20, log)
    expect(log.filter((e) => e.type === 'heal').length).toBeGreaterThanOrEqual(3)
  })

  it('tide-sappers: the player is sealed in, and the Blast Diver blows the way through', () => {
    const w = stage('tide-sappers')
    const t = firsts(w, 30 * 30)
    expect(t.sapperCharge).toBeDefined()
    expect(t.doorBreach).toBeGreaterThan(t.sapperCharge)
  })

  it('hound-ring: the near pack surrounds the player before it closes', () => {
    const w = stage('hound-ring')
    const t = firsts(w, 30 * 10)
    expect(t.packHunt).toBeDefined()
    expect(t.packClose).toBeGreaterThan(t.packHunt)
  })

  it('hive-spread: the spire buds at the player, and 30s in it roots a second spire', () => {
    const w = stage('hive-spread')
    const t = firsts(w, 30 * 32)
    expect(t.hiveSpawn).toBeDefined()
    expect(t.hiveSpread).toBeDefined()
    expect(w.entities.filter((e) => e.hive && !e.dead).length).toBeGreaterThanOrEqual(2)
  })

  it('the same seed stages the same moment twice (byte-identical)', () => {
    for (const name of Object.keys(GROUP_SCENARIOS)) {
      const a = stage(name)
      const b = stage(name)
      firsts(a, 200)
      firsts(b, 200)
      expect(serializeWorld(a), name).toEqual(serializeWorld(b))
    }
  })

  it('every scenario keeps the player standing (a clip never ends on a down)', () => {
    for (const name of Object.keys(GROUP_SCENARIOS)) {
      const w = stage(name)
      firsts(w, 30 * 20)
      expect(player(w).playerCtl!.downed, name).toBeUndefined()
    }
  })
})
