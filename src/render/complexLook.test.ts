import { describe, expect, it } from 'vitest'
import { generateLevel } from '../game/levelgen/generate'
import { BIOMES } from '../game/levelgen/complex'
import type { SimEvent } from '../game/types'
import { BIOME_TINT, floorTintFor, mulTint, updateDarkWing, type DarkWing } from './complexLook'

describe('complex look: biome floor grade', () => {
  it('mulTint is a channel-wise multiply with white as identity and black as zero', () => {
    expect(mulTint(0xffffff, 0x123456)).toBe(0x123456)
    expect(mulTint(0x123456, 0xffffff)).toBe(0x123456)
    expect(mulTint(0x000000, 0xabcdef)).toBe(0)
    expect(mulTint(0x808080, 0x808080)).toBe(0x404040)
    expect(mulTint(0xff0000, 0x00ff00)).toBe(0)
  })

  it('city floors keep the theme tint untouched; every biome grades it distinctly', () => {
    expect(floorTintFor(generateLevel(1, 1), 0xabcdef)).toBe(0xabcdef)
    expect(floorTintFor(generateLevel(1, 2), 0xffffff)).toBe(0xffffff)
    expect(floorTintFor(undefined, 0x445566)).toBe(0x445566)
    const tints = new Set<number>()
    for (let f = 3; f <= 9; f += 2) {
      const level = generateLevel(1, f)
      const t = floorTintFor(level, 0xffffff)
      expect(t).toBe(BIOME_TINT[level.complex!.biome])
      tints.add(t)
    }
    expect(tints.size).toBe(BIOMES.length)
  })
})

describe('complex look: lights-out darkness model', () => {
  const out = (wing: number, until: number): SimEvent => ({ type: 'lightsOut', wing, until, x: 1, y: 2, w: 3, h: 4 })

  it('goes dark on lightsOut and lifts on the matching lightsOn', () => {
    let d: DarkWing | null = updateDarkWing(null, [out(2, 100)], 10)
    expect(d).toEqual({ wing: 2, rect: { x: 1, y: 2, w: 3, h: 4 }, until: 100 })
    d = updateDarkWing(d, [], 50)
    expect(d?.wing).toBe(2)
    expect(updateDarkWing(d, [{ type: 'lightsOn', wing: 2 }], 60)).toBeNull()
  })

  it('a lightsOn for a DIFFERENT wing does not lift the dark', () => {
    const d = updateDarkWing(null, [out(2, 100)], 10)
    expect(updateDarkWing(d, [{ type: 'lightsOn', wing: 5 }], 20)?.wing).toBe(2)
  })

  it('expires by itself at `until` even if the lightsOn event was lost (net drop)', () => {
    const d = updateDarkWing(null, [out(1, 100)], 10)
    expect(updateDarkWing(d, [], 99)).not.toBeNull()
    expect(updateDarkWing(d, [], 100)).toBeNull()
    // A late-joining client that only sees a stale lightsOut never goes dark.
    expect(updateDarkWing(null, [out(1, 100)], 150)).toBeNull()
  })

  it('a newer blackout replaces the old one; unrelated events are ignored', () => {
    const d = updateDarkWing(null, [out(1, 100), { type: 'noise', x: 0, y: 0 }, out(3, 200)], 10)
    expect(d?.wing).toBe(3)
    expect(d?.until).toBe(200)
  })
})
