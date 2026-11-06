import { describe, expect, it } from 'vitest'
import { OBJECTS } from '../game/data/objects'
import type { ComplexInfo } from '../game/levelgen/level'
import { levelFromJson } from '../game/levelgen/levelText'
import { worldFromState } from '../game/world'
import { INDOOR_PROP_ART, indoorArtKey, indoorTileSkin, isIndoorLevel, parseIndoorArtKey } from './indoorSkin'

const COMPLEX: ComplexInfo = { biome: 'habitation', corridors: [], vents: [], wings: [] }

// One map holding every case: (2,2), (4,5) and (6,5) stand alone (the last
// with a wall only on its diagonal); runs at rows 3-4 and the (2,4)-(2,5)
// pair; (8,2) touches only the hull; (0,0) and (5,0) sit on the map edge;
// hall `=`, tiled `+`, plating `%`, stairs `^`/`v` and the bevel `1` never skin.
const ROWS = [
  '#.HH.#.HHH',
  '....=...+H',
  'H.#.....#H',
  'H...###..H',
  'H.#.....%H',
  'H.#.#.#.vH',
  'H...^..#1H',
  'HHHHHHHHHH',
]

const authored = (complex: ComplexInfo | undefined) =>
  worldFromState({ level: levelFromJson(complex ? { rows: ROWS, complex } : { rows: ROWS }) }).level

const GLYPH: Record<string, string> = { pillar: 'P', bulkhead: 'B', deck: 'D' }

/** The skin of every tile, as text: P pillar, B bulkhead, D deck, - plain. */
const skinMap = (level: ReturnType<typeof authored>): string[] =>
  Array.from({ length: level.h }, (_, ty) =>
    Array.from({ length: level.w }, (_, tx) => {
      const skin = indoorTileSkin(level, tx, ty)
      return skin === undefined ? '-' : GLYPH[skin]
    }).join(''),
  )

describe('indoorTileSkin on an authored complex floor', () => {
  it('skins floor as deck, wall runs as bulkhead, and only free-standing walls as pillars', () => {
    expect(skinMap(authored(COMPLEX))).toEqual([
      'BD--DBD---',
      'DDDD-DDD--',
      '-DPDDDDDB-',
      '-DDDBBBDD-',
      '-DBDDDDD--',
      '-DBDPDPD--',
      '-DDD-DDB--',
      '----------',
    ])
  })

  it('a wall whose only wall neighbour is hull is bulkhead, not a pillar', () => {
    expect(indoorTileSkin(authored(COMPLEX), 8, 2)).toBe('bulkhead')
  })

  it('a wall on the map edge is part of the boundary, never a pillar', () => {
    const level = authored(COMPLEX)
    expect(indoorTileSkin(level, 0, 0)).toBe('bulkhead')
    expect(indoorTileSkin(level, 5, 0)).toBe('bulkhead')
  })

  it('off-map coordinates draw nothing skinned', () => {
    const level = authored(COMPLEX)
    for (const [x, y] of [[-1, 0], [0, -1], [level.w, 0], [0, level.h], [-1, -1]])
      expect(indoorTileSkin(level, x, y), `${x},${y}`).toBeUndefined()
  })

  it('the same text without `complex` skins nothing', () => {
    const level = authored(undefined)
    expect(isIndoorLevel(level)).toBe(false)
    expect(skinMap(level).join('')).toBe('-'.repeat(level.w * level.h))
  })

  it('the complex block is the switch', () => {
    expect(isIndoorLevel(authored(COMPLEX))).toBe(true)
  })
})

describe('indoorArtKey', () => {
  it('prefixes every key with indoor art on an indoor level, and only there', () => {
    for (const key of Object.keys(INDOOR_PROP_ART)) {
      expect(indoorArtKey(key, true)).toBe(`indoor:${key}`)
      expect(indoorArtKey(key, false)).toBe(key)
    }
  })

  it('passes through keys with no indoor art, prototype names included', () => {
    for (const key of ['mutant', 'tv', 'atm', 'door.wood', 'Door', '', 'toString', 'constructor', '__proto__'])
      expect(indoorArtKey(key, true)).toBe(key)
  })

  it('round-trips through parseIndoorArtKey to the plain key and its prop art', () => {
    expect(parseIndoorArtKey(indoorArtKey('door.open', true))).toEqual({ base: 'door.open', prop: 'bulkhead-door-open' })
    expect(parseIndoorArtKey(indoorArtKey('barrel', true))).toEqual({ base: 'barrel', prop: 'coolant-tank' })
    expect(parseIndoorArtKey(indoorArtKey('generator', true))).toEqual({ base: 'generator', prop: 'generator' })
  })

  it('parses nothing that indoorArtKey would not produce', () => {
    for (const key of ['door', 'indoor:', 'indoor:mutant', 'indoor:toString', 'indoor:indoor:door', 'Indoor:door'])
      expect(parseIndoorArtKey(key), key).toBeUndefined()
  })

  it('every indoor art key is one EntityViews actually draws (a door state or an object archetype)', () => {
    const drawn = new Set(['door', 'door.open', 'door.locked', ...Object.keys(OBJECTS)])
    for (const key of Object.keys(INDOOR_PROP_ART)) expect(drawn.has(key), key).toBe(true)
  })
})
