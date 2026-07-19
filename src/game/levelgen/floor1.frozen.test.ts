import { describe, expect, it } from 'vitest'
import { generateLevel } from './generate'
import { levelChecksum, Tile } from './level'

/**
 * Floor 1 is FROZEN. These checksums were captured from the generator BEFORE
 * the levelgen-architecture work (hallways/bunkers/compounds/corner cuts) and
 * pin the surface city byte-for-byte: the scripted-demo regression guards
 * replay fixed inputs on floor-1 maps, and every committed world fixture
 * embeds a floor-1 levelChecksum that deserializeWorld refuses to load past.
 *
 * If one of these ever fails, the change ALTERED FLOOR 1 — that is a bug in
 * the change, not in this test. New generation features must gate on
 * `floor !== 1` (or live behind the themed-city path).
 */
const PINNED: [seed: number, checksum: number][] = [
  [1, 1106851220],
  [2, 1671242410],
  [3, 2379486430],
  [7, 2949895550], // combat-stage.json fixture seed
  [42, 2999058180],
  [424242, 1571592348], // fire-stage.json fixture seed
  [20260715, 3150501330], // mid-run/comm-scene fixture seed
  [3735928559, 3777937468], // 0xdeadbeef
]

describe('floor 1 is byte-frozen', () => {
  it.each(PINNED)('seed %d generates the pre-architecture checksum %d', (seed, checksum) => {
    expect(levelChecksum(generateLevel(seed, 1))).toBe(checksum)
  })

  it('floor 1 never contains the new bevelled corner tiles or bunkers', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const level = generateLevel(seed, 1)
      let maxTile = 0
      for (let i = 0; i < level.tiles.length; i++) maxTile = Math.max(maxTile, level.tiles[i])
      expect(maxTile, `seed ${seed}`).toBeLessThanOrEqual(Tile.Exit)
      for (const b of level.buildings) {
        expect(b.role).not.toBe('bunker')
        expect(b.poi === undefined || b.poi === 'courtyard' || b.poi === 'vault').toBe(true)
      }
    }
  })
})
