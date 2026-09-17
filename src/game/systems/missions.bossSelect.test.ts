// PER-FLOOR BOSS SELECTION — and, mostly, the determinism proof around it.
//
// The feature is small: the floor draws its boss from `data/bosses.ts` instead
// of spawning the literal archetype `'boss'`, and the mission description names
// whichever one spawned. The 2026-08-23 playtest is why: six runs produced
// "Purge the Mireclaw Alpha" four times, because there was nothing else to draw.
//
// THE RISK IS NOT THE FEATURE, IT IS THE RNG. This repo pins level generation
// and mission placement HARD:
//
//   - `levelgen/floor1.frozen.test.ts` pins floor-1 level checksums by seed;
//   - every committed world fixture embeds a `levelChecksum` that
//     `deserializeWorld` REFUSES to load past;
//   - `missions.property.test.ts` pins an exact steal/assassinate placement
//     table (template, building index, target position) for 48 seed/floor pairs;
//   - `missions.ts` carries an explicit warning that the deep-floor branch
//     short-circuits precisely so the mission stream stays byte-identical.
//
// A single extra draw from `w.rng` while choosing a boss would silently move all
// of it. So the selection is drawn from a DEDICATED `w.rng.fork('boss')`, and
// the first two tests below assert the non-consumption DIRECTLY rather than
// trusting the comment that claims it.

import { describe, expect, it } from 'vitest'
import { BOSSES } from '../data/bosses'
import { generateLevel } from '../levelgen/generate'
import { levelChecksum } from '../levelgen/level'
import { populateWorld } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual } from '../testkit'
import { createWorld, type World } from '../world'
import { setupFloor } from './missions'

const buildFloor = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w
}

/** The boss entity a generated floor placed, if its template has one. */
const bossOf = (w: World) => {
  if (w.mission.template !== 'assassinate' && w.mission.template !== 'infiltrate') return undefined
  return w.mission.targetEntityId !== undefined ? w.byId.get(w.mission.targetEntityId) : undefined
}

describe('the boss draw consumes NOTHING from the streams that place a floor', () => {
  it('forking never advances the parent stream — the property the whole design rests on', () => {
    // `Rng.fork(label)` derives a fresh stream from the parent's SEED, not from
    // its current position. If this were ever changed to draw a value first,
    // every frozen checksum and pinned placement in the repo would move, and
    // this is the single assertion that would catch it.
    const w = createWorld(1234, 5)
    const before = w.rng.state()
    w.rng.fork('boss')
    w.rng.fork('boss')
    w.rng.fork('boss')
    expect(w.rng.state()).toBe(before)
  })

  it('the boss fork is INDEPENDENT of the mission fork (one cannot shift the other)', () => {
    const w = createWorld(99, 6)
    const missionFirst = [w.rng.fork('mission').int(0, 1000), w.rng.fork('boss').int(0, 1000)]
    const w2 = createWorld(99, 6)
    const bossFirst = [w2.rng.fork('boss').int(0, 1000), w2.rng.fork('mission').int(0, 1000)]
    // Same values regardless of the order the forks were taken in: they are
    // separate streams, not two readers of one.
    expect(missionFirst[0]).toBe(bossFirst[1])
    expect(missionFirst[1]).toBe(bossFirst[0])
  })

  it('floor 1 still generates its frozen checksums (the level is untouched)', () => {
    // Duplicated from floor1.frozen.test.ts deliberately: that file states the
    // rule, this one states that THIS feature honours it.
    expect(levelChecksum(generateLevel(1, 1))).toBe(1106851220)
    expect(levelChecksum(generateLevel(42, 1))).toBe(2999058180)
    expect(levelChecksum(generateLevel(3735928559, 1))).toBe(3777937468)
  })

  it('reproduces the pinned steal/assassinate placements byte-identically', () => {
    // A spot-check of rows from missions.property.test.ts's pinned table. If
    // boss selection had perturbed the mission stream, the TEMPLATE itself would
    // flip on some of these — which is the loudest possible signal.
    const pinned: [seed: number, floor: number, tpl: string, bld: number, pos: [number, number]][] = [
      [1, 1, 'assassinate', 7, [57, 57]],
      [2, 3, 'assassinate', 1, [59, 19]],
      [3, 2, 'assassinate', 12, [56, 57]],
      [1, 2, 'steal', 12, [7, 56.5]],
      [5, 4, 'assassinate', 11, [23, 58]],
      [12, 4, 'assassinate', 9, [57, 56]],
    ]
    for (const [seed, floor, tpl, bld, pos] of pinned) {
      const w = buildFloor(seed, floor)
      const ctx = `seed=${seed} floor=${floor}`
      expect(w.mission.template, ctx).toBe(tpl)
      expect(w.mission.targetBuilding, ctx).toBe(bld)
      const t = w.byId.get(w.mission.targetEntityId!)!
      expect([t.pos.x, t.pos.y], ctx).toEqual(pos)
    }
  })

  it('a generated floor is still bit-reproducible and snapshot-stable', () => {
    expectWorldEqual(buildFloor(11, 5), buildFloor(11, 5))
    const w = buildFloor(7, 6)
    const restored = deserializeWorld(serializeWorld(w))
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })
})

describe('the floor names the boss it actually spawned', () => {
  it('description and spawned archetype agree, across every seed and floor', () => {
    // The bug this forbids is a silent desync between the creature in the room
    // and the text on the mission chip — the failure mode of hardcoding either.
    let checked = 0
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [1, 2, 3, 5, 6, 7]) {
        const w = buildFloor(seed, floor)
        const boss = bossOf(w)
        if (!boss) continue
        checked++
        const def = BOSSES[boss.archetype]
        const ctx = `seed=${seed} floor=${floor} archetype=${boss.archetype}`
        expect(def, `${ctx}: spawned an unregistered boss`).toBeDefined()
        expect(w.mission.description, ctx).toContain(def.missionName)
      }
    }
    expect(checked).toBeGreaterThan(20) // the sweep genuinely exercised boss floors
  })

  it('never spawns an archetype that has no NPC definition', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [2, 4, 6, 9]) {
        const boss = bossOf(buildFloor(seed, floor))
        if (boss) expect(Object.keys(BOSSES)).toContain(boss.archetype)
      }
    }
  })
})

describe('variety — the playtest complaint this feature answers', () => {
  it('floor 1 always fields the Mireclaw, keeping the tutorial floor fixed', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const boss = bossOf(buildFloor(seed, 1))
      if (boss) expect(boss.archetype, `seed=${seed}`).toBe('boss')
    }
  })

  it('deeper floors genuinely field MORE THAN ONE boss across seeds', () => {
    // The whole point. A picker that compiled but always returned the first
    // eligible boss would satisfy every other test in this file.
    const seen = new Set<string>()
    for (let seed = 1; seed <= 60; seed++) {
      for (const floor of [2, 3, 5, 6]) {
        const boss = bossOf(buildFloor(seed, floor))
        if (boss) seen.add(boss.archetype)
      }
    }
    expect([...seen].sort()).toEqual(['boss', 'vigil'])
  })

  it('the same seed and floor always field the same boss', () => {
    for (const [seed, floor] of [
      [5, 6],
      [17, 3],
      [23, 7],
    ] as const) {
      const a = bossOf(buildFloor(seed, floor))?.archetype
      const b = bossOf(buildFloor(seed, floor))?.archetype
      expect(a).toBe(b)
    }
  })
})
