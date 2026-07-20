import { describe, expect, it } from 'vitest'
import { MODS } from '../game/data/mods'
import { MOD_PICKUP_COLORS, MOD_PICKUP_FALLBACK, modPickupColor } from './modColors'

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

describe('mod-pickup diamond colours', () => {
  it('assigns an explicit colour to EVERY registered mod type', () => {
    const missing = Object.keys(MODS).filter((id) => !(id in MOD_PICKUP_COLORS))
    expect(missing, `mods without a colour: ${missing.join(', ')}`).toEqual([])
  })

  it('has no stray colours for ids that are not real mods', () => {
    const stray = Object.keys(MOD_PICKUP_COLORS).filter((id) => !(id in MODS))
    expect(stray, `colours for unknown mods: ${stray.join(', ')}`).toEqual([])
  })

  it('gives every mod a DISTINCT colour (no two read as the same)', () => {
    const values = Object.values(MOD_PICKUP_COLORS)
    const seen = new Map<number, string>()
    const dupes: string[] = []
    for (const [id, c] of Object.entries(MOD_PICKUP_COLORS)) {
      const prior = seen.get(c)
      if (prior) dupes.push(`${id} == ${prior} (${hex(c)})`)
      else seen.set(c, id)
    }
    expect(dupes, `duplicate colours: ${dupes.join('; ')}`).toEqual([])
    expect(new Set(values).size).toBe(values.length)
  })

  it('all colours are valid 24-bit RGB', () => {
    for (const [id, c] of Object.entries(MOD_PICKUP_COLORS)) {
      expect(Number.isInteger(c), id).toBe(true)
      expect(c, `${id} out of range`).toBeGreaterThanOrEqual(0)
      expect(c, `${id} out of range`).toBeLessThanOrEqual(0xffffff)
    }
  })

  it('the fallback is distinct from every assigned mod colour', () => {
    expect(Object.values(MOD_PICKUP_COLORS)).not.toContain(MOD_PICKUP_FALLBACK)
  })

  it('modPickupColor returns the exact table colour for a known mod', () => {
    for (const [id, c] of Object.entries(MOD_PICKUP_COLORS)) {
      expect(modPickupColor(id), id).toBe(c)
    }
  })

  it('modPickupColor returns the fallback for an unknown / new mod id', () => {
    expect(modPickupColor('not-a-real-mod')).toBe(MOD_PICKUP_FALLBACK)
    expect(modPickupColor('')).toBe(MOD_PICKUP_FALLBACK)
  })

  it('the elemental mods keep their intuitive semantic hues', () => {
    // Frost reads cool (blue-ish), incendiary warm (red-ish) — a kid-legibility
    // guard so a future palette shuffle can't swap fire and ice.
    const r = (c: number) => (c >> 16) & 0xff
    const b = (c: number) => c & 0xff
    expect(b(MOD_PICKUP_COLORS.frost)).toBeGreaterThan(r(MOD_PICKUP_COLORS.frost))
    expect(r(MOD_PICKUP_COLORS.incendiary)).toBeGreaterThan(b(MOD_PICKUP_COLORS.incendiary))
  })
})
