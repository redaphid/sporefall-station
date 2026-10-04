import { describe, expect, it } from 'vitest'
import { generateLevel } from './levelgen/generate'
import { levelChecksum, Tile } from './levelgen/level'
import { levelFromJson, levelToJson } from './levelgen/levelText'
import { populateWorld } from './populate'
import { spawnNpc } from './populate'
import { spawnPlayer } from './player'
import { deserializeWorld, serializeWorld, type WorldJson } from './serialize'
import { playerSpawnPoint } from './spawnPlacement'
import { nextFloor, setupFloor } from './systems/missions'
import { createCityWorld, expectWorldEqual, loadFixture, loadFixtureJson, runTicks } from './testkit'
import { emptyInput, type InputCmd } from './types'
import { createWorld, tickWorld, worldFromSeed, worldFromState, type World } from './world'

// A walled hall split by a wall with a one-tile gap. The gap is the only way
// from the player's side to the thug's, so the geometry is the test's subject.
const HALL = [
  '############',
  '#....#.....#',
  '#.@..#.....#',
  '#..........#',
  '#....#.....#',
  '############',
]

const DRIVE = new Map<number, Partial<InputCmd>>([[0, { moveX: 1, aimX: 1, attack: true }]])

const authoredHall = (): World => {
  const w = worldFromState({ level: levelFromJson({ rows: HALL }) })
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  spawnNpc(w, 'thug', 8.5, 2.5)
  return w
}

const reload = (j: WorldJson): World => deserializeWorld(JSON.parse(JSON.stringify(j)) as WorldJson)

describe('an authored world: the engine starts from state, no seed involved', () => {
  it('builds the level from the rows, not from any generator', () => {
    const w = authoredHall()
    expect(w.level.w).toBe(12)
    expect(w.level.h).toBe(6)
    expect(w.level.spawn).toEqual({ x: 2.5, y: 2.5 })
    expect(w.level.tiles[2 * 12 + 2]).toBe(Tile.Floor)
    expect(w.level.solid[1 * 12 + 5]).toBe(1)
    expect(w.level.solid[3 * 12 + 5]).toBe(0)
    expect(levelChecksum(w.level)).not.toBe(levelChecksum(generateLevel(w.seed, w.floor)))
  })

  it('same authored state + same inputs = identical worlds, tick for tick', () => {
    const a = authoredHall()
    const b = authoredHall()
    for (let t = 0; t < 120; t++) {
      runTicks(a, DRIVE, 1)
      runTicks(b, DRIVE, 1)
      expect(serializeWorld(a), `tick ${t}`).toEqual(serializeWorld(b))
    }
  })

  it('the save carries the level whole, and a mid-run reload continues bit-exact', () => {
    const straight = runTicks(authoredHall(), DRIVE, 60)
    const half = runTicks(authoredHall(), DRIVE, 30)
    const save = serializeWorld(half)
    expect(save.level?.rows).toEqual(HALL.map((r) => r.replace('@', '.')))
    expect(save.levelChecksum).toBeUndefined()
    const resumed = runTicks(reload(save), DRIVE, 30)
    expectWorldEqual(resumed, straight)
    expect(levelChecksum(resumed.level)).toBe(levelChecksum(straight.level))
  })

  it('the wall in the authored map actually blocks: the player walks to it and stops', () => {
    const w = worldFromState({ level: levelFromJson({ rows: HALL }) })
    const p = spawnPlayer(w, 0, 2.5, 1.5)
    runTicks(w, new Map([[0, { moveX: 1 }]]), 90)
    expect(p.pos.x).toBeLessThan(5)
    expect(p.pos.x).toBeGreaterThan(4)
  })

  it('a save edited by hand loads: change a row, no checksum to fix up', () => {
    const save = serializeWorld(authoredHall())
    if (!save.level) throw new Error('an authored world saves its level')
    save.level.rows[1] = '#..........#'
    const w = reload(save)
    expect(w.level.solid[1 * 12 + 5]).toBe(0)
    expect(serializeWorld(w).level?.rows[1]).toBe('#..........#')
  })

  it('leaving the authored floor generates the next one from the run seed', () => {
    const w = authoredHall()
    nextFloor(w)
    expect(w.floor).toBe(2)
    expect(levelChecksum(w.level)).toBe(levelChecksum(generateLevel(w.seed, 2)))
    const save = serializeWorld(w)
    expect(save.level).toBeUndefined()
    expect(save.levelChecksum).toBe(levelChecksum(w.level))
    expectWorldEqual(reload(save), w)
  })
})

describe('level text', () => {
  it('round-trips every generated level losslessly: tiles, collision and structure', () => {
    for (const seed of [1, 7, 1003]) {
      for (const floor of [1, 2, 3, 4, 5, 6]) {
        const level = generateLevel(seed, floor)
        const back = levelFromJson(JSON.parse(JSON.stringify(levelToJson(level))))
        expect(back, `seed ${seed} floor ${floor}`).toEqual(level)
      }
    }
  })

  it('defaults: @ is the spawn, the first E is the exit, no E means no exit tile', () => {
    const marked = levelFromJson({ rows: ['#####', '#@.E#', '#####'] })
    expect(marked.spawn).toEqual({ x: 1.5, y: 1.5 })
    expect(marked.exit).toEqual({ x: 3, y: 1 })
    expect(marked.tiles[1 * 5 + 1]).toBe(Tile.Floor)
    const bare = levelFromJson({ rows: ['...', '...', '...'] })
    expect(bare.spawn).toEqual({ x: 1.5, y: 1.5 })
    expect(bare.exit).toEqual({ x: -1, y: -1 })
    expect(bare.buildings).toEqual([])
  })

  it('refuses malformed level text, naming the row and column', () => {
    expect(() => levelFromJson({ rows: [] })).toThrow(/no rows/)
    expect(() => levelFromJson({ rows: [''] })).toThrow(/row 0 is empty/)
    expect(() => levelFromJson({ rows: ['###', '##'] })).toThrow(/row 1 is 2 wide, expected 3/)
    expect(() => levelFromJson({ rows: ['#.#', '#?#'] })).toThrow(/row 1 col 1: unknown glyph '\?'/)
    expect(() => levelFromJson({ rows: ['@.@'] })).toThrow(/second spawn '@' at row 0 col 2/)
  })

  it('refuses to write a tile id it has no glyph for', () => {
    const level = levelFromJson({ rows: ['...'] })
    level.tiles[1] = 99
    expect(() => levelToJson(level)).toThrow(/tile 99 at 1,0 has no glyph/)
  })
})

describe('seeded worlds: the generator path is unchanged', () => {
  const fnv = (s: string): number => {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }

  /** Populate, set up and play `w` for 120 ticks; its save, serialized. */
  const play120 = (w: World): string => {
    populateWorld(w)
    setupFloor(w)
    const at = playerSpawnPoint(w.level, 0)
    spawnPlayer(w, 0, at.x, at.y)
    for (let t = 0; t < 120; t++) {
      const cmd = { ...emptyInput(), seq: t, moveX: t % 40 < 20 ? 1 : -1, moveY: t % 60 < 30 ? 0.5 : -0.5, attack: t % 7 === 0 }
      tickWorld(w, new Map([[0, cmd]]))
    }
    return JSON.stringify(serializeWorld(w))
  }

  // FNV-1a and length of the serialized world after a populated 120-tick run,
  // captured on main at b29a651, before the engine took authored state.
  const MAIN: Array<[seed: number, floor: number, hash: number, length: number]> = [
    [1, 1, 0x42622a9f, 82071],
    [7, 2, 0x94e68ce0, 61403],
  ]

  it.each(MAIN)('seed %i floor %i serializes byte-identically to main', (seed, floor, hash, length) => {
    const s = play120(createWorld(seed, floor))
    expect(s.length).toBe(length)
    expect(fnv(s)).toBe(hash)
  })

  // The same run on deeper floors, on levels frozen as authored fixtures (the
  // station floors 3 and 5 and the city floor 4 those seeds built before the
  // floor plan sent every floor from 3 indoors), so the pin no longer moves
  // with the generator.
  const FROZEN: Array<[fixture: string, hash: number, length: number]> = [
    ['frozen-1003-3', 0xb8977860, 119919],
    ['frozen-42-5', 0xc1e3854e, 178788],
    ['frozen-9-4', 0xf203d64f, 133727],
  ]

  it.each(FROZEN)('%s plays 120 ticks to the pinned save', (fixture, hash, length) => {
    const s = play120(loadFixture(fixture))
    expect(s.length).toBe(length)
    expect(fnv(s)).toBe(hash)
  })

  it('createWorld is exactly worldFromState(worldFromSeed(...))', () => {
    expectWorldEqual(createWorld(5, 3, 'casual', false), worldFromState(worldFromSeed(5, 3, 'casual', false)))
  })

  it('an untouched seeded level saves as a checksum; a carved one saves whole and keeps its carving', () => {
    const w = createWorld(11, 1)
    expect(serializeWorld(w).level).toBeUndefined()
    const i = w.level.tiles.findIndex((t) => t === Tile.Wall)
    w.level.tiles[i] = Tile.Floor
    w.level.solid[i] = 0
    const save = serializeWorld(w)
    expect(save.levelChecksum).toBeUndefined()
    const back = reload(save)
    expect(back.level.tiles[i]).toBe(Tile.Floor)
    expect(back.level.solid[i]).toBe(0)
    expectWorldEqual(back, w)
  })

  it('a city-generator world on a complex floor now round-trips (its level travels whole)', () => {
    const w = createCityWorld(4, 3)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    const back = reload(serializeWorld(w))
    expectWorldEqual(back, w)
    expect(back.level.complex).toBeUndefined()
  })

  it('every committed seeded fixture still loads and re-saves to itself exactly', () => {
    for (const name of ['mid-run', 'mid-run-plus-10', 'combat-stage', 'comm-scene', 'fire-stage', 'crew-scene', 'crew-scene-8']) {
      const j = loadFixtureJson(name)
      expect(j.level, name).toBeUndefined()
      expect(serializeWorld(deserializeWorld(j)), name).toEqual(loadFixtureJson(name))
    }
  })

  it('every committed frozen-level fixture carries its level whole and re-saves to itself exactly', () => {
    for (const name of ['bunker-heist', 'frozen-1-3', 'frozen-3-3', 'frozen-10-3', 'frozen-2-4', 'frozen-1003-3', 'frozen-42-5', 'frozen-9-4']) {
      const j = loadFixtureJson(name)
      expect(j.level, name).toBeDefined()
      expect(j.levelChecksum, name).toBeUndefined()
      expect(serializeWorld(deserializeWorld(j)), name).toEqual(loadFixtureJson(name))
    }
  })

  it('a snapshot with neither a level nor a checksum is refused', () => {
    const j = serializeWorld(createWorld(3, 1)) as Partial<WorldJson>
    delete j.levelChecksum
    expect(() => deserializeWorld(j as WorldJson)).toThrow(/neither a level nor a levelChecksum/)
  })
})
