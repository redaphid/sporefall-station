import { describe, expect, it } from 'vitest'
import { baseWeaponSkin, composeWeaponSkin } from './weaponSkin'
import { modPickupColor } from './modColors'

describe('composeWeaponSkin — base look', () => {
  it('no mods → untinted, unscaled, no glow (the bare weapon)', () => {
    const base = baseWeaponSkin()
    expect(composeWeaponSkin(undefined)).toEqual(base)
    expect(composeWeaponSkin([])).toEqual(base)
    expect(base.tint).toBe(0xffffff)
    expect(base.scale).toBe(1)
    expect(base.glow).toBe(0)
    expect(base.power).toBe(0)
  })

  it('ignores unknown ids and non-positive stacks (→ base look)', () => {
    expect(composeWeaponSkin([{ id: 'not-a-mod', stacks: 3 }])).toEqual(baseWeaponSkin())
    expect(composeWeaponSkin([{ id: 'frost', stacks: 0 }])).toEqual(baseWeaponSkin())
  })
})

describe('composeWeaponSkin — single mod tints to its pickup colour', () => {
  it('one frost stack wears exactly the frost gem colour', () => {
    const skin = composeWeaponSkin([{ id: 'frost', stacks: 1 }])
    expect(skin.tint).toBe(modPickupColor('frost'))
    expect(skin.glowColor).toBe(modPickupColor('frost'))
  })

  it('grows size and glow with the mod, staying clamped', () => {
    const skin = composeWeaponSkin([{ id: 'overload', stacks: 3 }])
    expect(skin.scale).toBeGreaterThan(1)
    expect(skin.scale).toBeLessThanOrEqual(1.35)
    expect(skin.glow).toBeGreaterThan(0)
    expect(skin.glow).toBeLessThan(1)
    expect(skin.power).toBe(3)
  })

  it('matches the incendiary pickup hue (fire-orange)', () => {
    expect(composeWeaponSkin([{ id: 'incendiary', stacks: 2 }]).tint).toBe(modPickupColor('incendiary'))
  })
})

describe('composeWeaponSkin — multiple mods compose', () => {
  it('two mods blend to a colour BETWEEN the two pickup hues', () => {
    const skin = composeWeaponSkin([
      { id: 'frost', stacks: 1 },
      { id: 'incendiary', stacks: 1 },
    ])
    const blue = modPickupColor('frost') & 0xff
    const orange = modPickupColor('incendiary') & 0xff
    const b = skin.tint & 0xff
    // Blended blue channel sits between the two extremes (not equal to either).
    expect(b).toBeGreaterThan(Math.min(blue, orange))
    expect(b).toBeLessThan(Math.max(blue, orange))
  })

  it('is independent of mod order (folds in sorted id order)', () => {
    const a = composeWeaponSkin([
      { id: 'frost', stacks: 2 },
      { id: 'shock', stacks: 1 },
    ])
    const b = composeWeaponSkin([
      { id: 'shock', stacks: 1 },
      { id: 'frost', stacks: 2 },
    ])
    expect(a).toEqual(b)
  })

  it('power sums (capped) stacks; glowColor is the highest-weighted mod', () => {
    const skin = composeWeaponSkin([
      { id: 'overload', stacks: 2 }, // overload caps at 2 stacks
      { id: 'shock', stacks: 1 },
    ])
    expect(skin.power).toBe(3)
    expect(skin.glowColor).toBe(modPickupColor('overload')) // overload has the most stacks
  })

  it('caps stacks at the registry maxStacks (frost maxes at 1)', () => {
    const capped = composeWeaponSkin([{ id: 'frost', stacks: 9 }])
    const one = composeWeaponSkin([{ id: 'frost', stacks: 1 }])
    expect(capped).toEqual(one)
    expect(capped.power).toBe(1)
  })
})
