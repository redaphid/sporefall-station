import { describe, expect, it } from 'vitest'
import { runVerb } from '../debug/verbs'
import { worldDigest } from '../debug/worldDigest'
import { levelChecksum, Tile } from './levelgen/level'
import { levelFromJson, levelToJson, MAX_LEVEL_SIDE, type LevelJson } from './levelgen/levelText'
import { populateWorld } from './populate'
import { spawnPlayer } from './player'
import { applyScenario, SCENARIO_NAMES } from './scenarios'
import { deserializeWorld, serializeWorld, type WorldJson } from './serialize'
import { playerSpawnPoint } from './spawnPlacement'
import { setupFloor } from './systems/missions'
import { expectWorldEqual, runTicks } from './testkit'
import { createWorld, type World } from './world'

/** Stage a scenario as the app does for `?mode=solo&seed=3&scenario=<name>`. */
const stage = (name: string): World => {
  const w = createWorld(3, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  applyScenario(w, name)
  return w
}

describe('every scenario survives a save and reload', () => {
  it('knows all 37 scenarios', () => {
    expect(SCENARIO_NAMES).toHaveLength(37)
  })

  it.each(SCENARIO_NAMES)('%s: reloaded world stays equal to the original for 120 ticks', (name) => {
    const original = stage(name)
    const reloaded = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(original))) as WorldJson)
    expect(levelChecksum(reloaded.level)).toBe(levelChecksum(original.level))
    runTicks(original, new Map(), 120)
    runTicks(reloaded, new Map(), 120)
    expectWorldEqual(reloaded, original)
  })
})

describe('a level whose collision disagrees with its tiles cannot be saved', () => {
  it('throws naming the tile instead of saving invisible walls', () => {
    const level = levelFromJson({ rows: ['#####', '#...#', '#####'] })
    level.solid[1 * 5 + 2] = 1
    expect(() => levelToJson(level)).toThrow(/level tile 2,1 is 2 but solid=1/)
  })
})

describe('the debug load verb replaces the whole world', () => {
  it('loading a floor-1 dump into a floor-3 world drops the old director and groups', () => {
    const deep = createWorld(1, 3)
    populateWorld(deep)
    setupFloor(deep)
    spawnPlayer(deep, 0, deep.level.spawn.x, deep.level.spawn.y)
    runTicks(deep, new Map(), 30)
    expect(deep.director).toBeDefined()
    expect(deep.groups).toBeDefined()

    const shallow = createWorld(7, 1)
    spawnPlayer(shallow, 0, shallow.level.spawn.x, shallow.level.spawn.y)
    runTicks(shallow, new Map(), 5)
    expect(shallow.director).toBeUndefined()
    expect(shallow.groups).toBeUndefined()

    runVerb(deep, `load ${JSON.stringify(serializeWorld(shallow))}`)
    expect(deep.director).toBeUndefined()
    expect(deep.groups).toBeUndefined()
    expect(deep.floor).toBe(1)
    expect(worldDigest(deep)).toBe(worldDigest(shallow))
    runTicks(deep, new Map(), 60)
    runTicks(shallow, new Map(), 60)
    expectWorldEqual(deep, shallow)
  })

  it('loading an authored save over a seeded world forgets the seeded level checksum', () => {
    const w = createWorld(7, 1)
    const save = serializeWorld(createWorld(9, 2))
    const authored = serializeWorld(deserializeWorld({ ...save, levelChecksum: undefined, level: { rows: ['#####', '#.@.#', '#####'] } }))
    runVerb(w, `load ${JSON.stringify(authored)}`)
    expect(w.levelChecksumFromSeed).toBeUndefined()
    expect(serializeWorld(w).level?.rows).toEqual(['#####', '#...#', '#####'])
  })
})

describe('level text is parsed fully at the boundary', () => {
  const ROWS = ['#####', '#...#', '#####']
  const bad = (j: unknown): (() => unknown) => () => levelFromJson(j as LevelJson)

  it('refuses a missing, non-array, or non-string rows', () => {
    expect(bad(null)).toThrow(/level must be an object with `rows`/)
    expect(bad({})).toThrow(/level\.rows must be an array of strings/)
    expect(bad({ rows: '#####' })).toThrow(/level\.rows must be an array of strings/)
    expect(bad({ rows: [['#', '#'], ['#', '#']] })).toThrow(/level\.rows\[0\] must be a string/)
    expect(bad({ rows: ['##', 7] })).toThrow(/level\.rows\[1\] must be a string/)
  })

  it('caps the map size before allocating', () => {
    const wide = 'x'.repeat(MAX_LEVEL_SIDE + 1)
    expect(bad({ rows: [wide] })).toThrow(new RegExp(`level\\.rows\\[0\\] is ${MAX_LEVEL_SIDE + 1} wide`))
    expect(bad({ rows: Array.from({ length: MAX_LEVEL_SIDE + 1 }, () => '.') })).toThrow(/has 1025 rows/)
    const t0 = performance.now()
    expect(bad({ rows: Array.from({ length: 20000 }, () => '.'.repeat(20000)) })).toThrow(/rows/)
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it('refuses a non-numeric or off-map spawn', () => {
    expect(bad({ rows: ROWS, spawn: { x: '2', y: 1.5 } })).toThrow(/level\.spawn\.x must be a finite number, got "2"/)
    expect(bad({ rows: ROWS, spawn: { x: Infinity, y: 1.5 } })).toThrow(/level\.spawn\.x must be a finite number/)
    expect(bad({ rows: ROWS, spawn: { x: 2.5, y: 9.5 } })).toThrow(/level\.spawn 2\.5,9\.5 is off the 5x3 map/)
    expect(bad({ rows: ROWS, spawn: [2, 1] })).toThrow(/level\.spawn must be an object/)
  })

  it('refuses a fractional or off-map exit, but accepts the no-exit marker', () => {
    expect(bad({ rows: ROWS, exit: { x: 1.5, y: 1 } })).toThrow(/level\.exit\.x must be an integer, got 1\.5/)
    expect(bad({ rows: ROWS, exit: { x: 7, y: 1 } })).toThrow(/level\.exit 7,1 is off the 5x3 map/)
    expect(levelFromJson({ rows: ROWS, exit: { x: -1, y: -1 } }).exit).toEqual({ x: -1, y: -1 })
  })

  it('refuses junk buildings, naming the field', () => {
    const b = { rect: { x: 1, y: 1, w: 3, h: 1 }, rooms: [], doors: [], role: 'shop' }
    expect(levelFromJson({ rows: ROWS, buildings: [b] } as unknown as LevelJson).buildings).toHaveLength(1)
    expect(bad({ rows: ROWS, buildings: 'shop' })).toThrow(/level\.buildings must be an array/)
    expect(bad({ rows: ROWS, buildings: [{ ...b, role: 'castle' }] })).toThrow(/level\.buildings\[0\]\.role must be one of/)
    expect(bad({ rows: ROWS, buildings: [{ ...b, rect: { x: 1, y: 1, w: 'big', h: 1 } }] })).toThrow(/level\.buildings\[0\]\.rect\.w must be an integer/)
    expect(bad({ rows: ROWS, buildings: [{ ...b, doors: [{ x: 1 }] }] })).toThrow(/level\.buildings\[0\]\.doors\[0\]\.y must be a finite number/)
  })

  it('refuses junk theme, plazas, complex, storeys and stairs', () => {
    expect(bad({ rows: ROWS, theme: 'castle' })).toThrow(/level\.theme must be one of/)
    expect(bad({ rows: ROWS, plazas: [{ x: 0 }] })).toThrow(/level\.plazas\[0\]\.y must be an integer/)
    const complex = { biome: 'flooded', corridors: [], vents: [], wings: [] }
    expect(bad({ rows: ROWS, complex: 'yes' })).toThrow(/level\.complex must be an object/)
    expect(bad({ rows: ROWS, complex: { ...complex, biome: 'lava' } })).toThrow(/level\.complex\.biome must be one of/)
    expect(bad({ rows: ROWS, complex: { ...complex, corridors: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, axis: 'z' }] } })).toThrow(
      /level\.complex\.corridors\[0\]\.axis must be one of h\/v/,
    )
    expect(bad({ rows: ROWS, complex: { ...complex, wings: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, buildings: [0] }] } })).toThrow(
      /level\.complex\.wings\[0\]\.buildings\[0\] is building 0, but the level has 0/,
    )
    expect(bad({ rows: ROWS, complex: { ...complex, objective: 3 } })).toThrow(/level\.complex\.objective is building 3/)
    expect(bad({ rows: ROWS, storeys: [{ slot: 0, z: 0, kind: 'attic', ox: 0 }] })).toThrow(/level\.storeys\[0\]\.kind must be one of/)
    expect(bad({ rows: ROWS, storeys: {} })).toThrow(/level\.storeys must be an array/)
    const stair = { from: { x: 1, y: 1 }, to: { x: 2, y: 1 }, landing: { x: 3, y: 1 }, dir: 'n' }
    expect(bad({ rows: ROWS, stairs: [{ ...stair, dir: 'up' }] })).toThrow(/level\.stairs\[0\]\.dir must be one of n\/e\/s\/w/)
    expect(bad({ rows: ROWS, stairs: [{ ...stair, landing: null }] })).toThrow(/level\.stairs\[0\]\.landing must be an object/)
  })

  it('still loads a minimal valid level', () => {
    const l = levelFromJson({ rows: ROWS })
    expect(l.tiles[1 * 5 + 1]).toBe(Tile.Floor)
  })
})
