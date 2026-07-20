// Adversarial coverage of the procedural bullet-visual grammar: 1:1 registry
// coverage, order-independence, per-stack monotonic growth, clamps under
// max-stack monster builds, degenerate inputs (no mods, unknown ids, negative
// or fractional stacks), and per-mod distinctness (every mod must visibly
// change the vanilla look, and no two single mods may share a look).

import { describe, expect, it } from 'vitest'
import { MODS, modMaxStacks, normalizeMods } from '../game/data/mods'
import type { WeaponMod } from '../game/entity'
import {
  BASE_BULLET_COLOR,
  baseBulletTraits,
  composeBulletTraits,
  MOD_VISUALS,
  TRAIL_CAP,
  type BulletTraits,
} from './bulletVisuals'

const ALL_IDS = Object.keys(MODS)

const finiteTraits = (t: BulletTraits): void => {
  for (const [k, v] of Object.entries(t)) {
    expect(Number.isFinite(v), `${k} must be finite`).toBe(true)
  }
}

describe('MOD_VISUALS registry coverage', () => {
  it('every mod in MODS has a visual mapping', () => {
    for (const id of ALL_IDS) expect(MOD_VISUALS[id], `missing visual for mod '${id}'`).toBeDefined()
  })

  it('every visual mapping points at a real mod (no orphans)', () => {
    for (const id of Object.keys(MOD_VISUALS)) expect(MODS[id], `orphan visual '${id}'`).toBeDefined()
  })

  it('every mapping declares at least one visible contribution', () => {
    for (const [id, d] of Object.entries(MOD_VISUALS)) {
      const visible =
        d.sizeMul !== undefined ||
        d.lengthMul !== undefined ||
        d.hue !== undefined ||
        d.glowAdd !== undefined ||
        d.trailAdd !== undefined ||
        d.jitterAdd !== undefined ||
        d.pulseAdd !== undefined ||
        d.flecksAdd !== undefined
      expect(visible, `mod '${id}' contributes nothing visible`).toBe(true)
    }
  })
})

describe('degenerate inputs', () => {
  it('no mods → the exact vanilla base traits', () => {
    expect(composeBulletTraits(undefined)).toEqual(baseBulletTraits())
    expect(composeBulletTraits([])).toEqual(baseBulletTraits())
  })

  it('unknown mod ids are ignored', () => {
    expect(composeBulletTraits([{ id: 'nope', stacks: 3 }])).toEqual(baseBulletTraits())
    expect(composeBulletTraits([{ id: '', stacks: 1 }])).toEqual(baseBulletTraits())
  })

  it('non-positive / NaN stacks are ignored', () => {
    expect(composeBulletTraits([{ id: 'overload', stacks: 0 }])).toEqual(baseBulletTraits())
    expect(composeBulletTraits([{ id: 'overload', stacks: -5 }])).toEqual(baseBulletTraits())
    expect(composeBulletTraits([{ id: 'overload', stacks: NaN }])).toEqual(baseBulletTraits())
  })

  it('fractional stacks floor (0.9 → nothing, 2.7 → 2)', () => {
    expect(composeBulletTraits([{ id: 'overload', stacks: 0.9 }])).toEqual(baseBulletTraits())
    expect(composeBulletTraits([{ id: 'overload', stacks: 2.7 }])).toEqual(
      composeBulletTraits([{ id: 'overload', stacks: 2 }]),
    )
  })

  it('stacks above the registry cap clamp to maxStacks', () => {
    for (const id of ALL_IDS) {
      const cap = modMaxStacks(id)
      expect(composeBulletTraits([{ id, stacks: 999 }])).toEqual(composeBulletTraits([{ id, stacks: cap }]))
    }
  })

  it('vanilla traits keep the historical gold tracer look', () => {
    const t = baseBulletTraits()
    expect(t.color).toBe(BASE_BULLET_COLOR)
    expect(t.size).toBe(1)
    expect(t.length).toBe(1)
    expect(t.glow).toBe(0)
    expect(t.trail).toBe(0)
  })
})

describe('composition', () => {
  it('is order-independent for every pairing of mods', () => {
    for (let i = 0; i < ALL_IDS.length; i++) {
      for (let j = i + 1; j < ALL_IDS.length; j++) {
        const ab = composeBulletTraits([
          { id: ALL_IDS[i], stacks: 2 },
          { id: ALL_IDS[j], stacks: 1 },
        ])
        const ba = composeBulletTraits([
          { id: ALL_IDS[j], stacks: 1 },
          { id: ALL_IDS[i], stacks: 2 },
        ])
        expect(ab).toEqual(ba)
      }
    }
  })

  it('is order-independent for a shuffled 5-mod build', () => {
    const build: WeaponMod[] = [
      { id: 'overload', stacks: 2 },
      { id: 'frost', stacks: 1 },
      { id: 'pierce', stacks: 3 },
      { id: 'homing', stacks: 1 },
      { id: 'velocity', stacks: 2 },
    ]
    const want = composeBulletTraits(build)
    expect(composeBulletTraits([...build].reverse())).toEqual(want)
    expect(composeBulletTraits([build[2], build[4], build[0], build[3], build[1]])).toEqual(want)
  })

  it('two mods COMBINE rather than switching to one preset', () => {
    const frost = composeBulletTraits([{ id: 'frost', stacks: 1 }])
    const pierce = composeBulletTraits([{ id: 'pierce', stacks: 1 }])
    const both = composeBulletTraits([
      { id: 'frost', stacks: 1 },
      { id: 'pierce', stacks: 1 },
    ])
    // Pierce's elongation survives alongside frost's hue/trail.
    expect(both.length).toBeGreaterThan(frost.length)
    expect(both.trail).toBeGreaterThanOrEqual(frost.trail)
    // And the combined look matches NEITHER single-mod preset.
    expect(both).not.toEqual(frost)
    expect(both).not.toEqual(pierce)
    // Frost's blue must actually pull the combined tint away from pierce's.
    expect(both.color).not.toBe(pierce.color)
  })

  it('stacking a mod grows its contribution monotonically', () => {
    const s1 = composeBulletTraits([{ id: 'overload', stacks: 1 }])
    const s3 = composeBulletTraits([{ id: 'overload', stacks: 3 }])
    const s5 = composeBulletTraits([{ id: 'overload', stacks: 5 }])
    expect(s3.size).toBeGreaterThan(s1.size)
    expect(s5.size).toBeGreaterThan(s3.size)
    expect(s3.glow).toBeGreaterThan(s1.glow)
    expect(s5.power).toBe(5)
  })

  it('duplicate entries for the same mod behave like a normalized single entry', () => {
    // spawnProjectile normalizes provenance; the composer must agree with that
    // normal form when handed the raw duplicates too.
    const dup = composeBulletTraits(normalizeMods([
      { id: 'rapid', stacks: 1 },
      { id: 'rapid', stacks: 2 },
    ]))
    expect(dup).toEqual(composeBulletTraits([{ id: 'rapid', stacks: 3 }]))
  })
})

describe('clamps under monster builds', () => {
  const monster: WeaponMod[] = ALL_IDS.map((id) => ({ id, stacks: modMaxStacks(id) }))

  it('a max-stack everything build stays finite and inside every rail', () => {
    const t = composeBulletTraits(monster)
    finiteTraits(t)
    expect(t.size).toBeGreaterThanOrEqual(0.6)
    expect(t.size).toBeLessThanOrEqual(2.4)
    expect(t.length).toBeGreaterThanOrEqual(1)
    expect(t.length).toBeLessThanOrEqual(3.2)
    expect(t.glow).toBeGreaterThan(0)
    expect(t.glow).toBeLessThan(1)
    expect(t.trail).toBeLessThanOrEqual(TRAIL_CAP)
    expect(t.jitter).toBeLessThan(1)
    expect(t.pulse).toBeLessThan(1)
    expect(t.flecks).toBeLessThanOrEqual(1)
    expect(t.chroma).toBeGreaterThan(0)
    expect(t.chroma).toBeLessThan(1)
    // Colors stay valid 24-bit RGB.
    for (const c of [t.color, t.glowColor, t.trailColor]) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(0xffffff)
      expect(Number.isInteger(c)).toBe(true)
    }
  })

  it('every single-mod build stays inside the rails too', () => {
    for (const id of ALL_IDS) {
      const t = composeBulletTraits([{ id, stacks: modMaxStacks(id) }])
      finiteTraits(t)
      expect(t.size).toBeGreaterThanOrEqual(0.6)
      expect(t.size).toBeLessThanOrEqual(2.4)
      expect(t.length).toBeLessThanOrEqual(3.2)
      expect(t.trail).toBeLessThanOrEqual(TRAIL_CAP)
    }
  })

  it('chroma stays zero for shallow builds and unlocks only when deep', () => {
    expect(composeBulletTraits([{ id: 'frost', stacks: 1 }]).chroma).toBe(0)
    expect(composeBulletTraits([{ id: 'overload', stacks: 2 }]).chroma).toBe(0)
    expect(composeBulletTraits([{ id: 'overload', stacks: 5 }]).chroma).toBeGreaterThan(0)
  })
})

describe('combinatorial colour — the core tint blends each mod\'s PICKUP colour', () => {
  const R = (c: number): number => (c >> 16) & 0xff
  const B = (c: number): number => c & 0xff

  it('two elements blend: the mix carries BOTH pickup hues, not one last-wins preset', () => {
    const frost = composeBulletTraits([{ id: 'frost', stacks: 1 }]).color
    const fire = composeBulletTraits([{ id: 'incendiary', stacks: 1 }]).color
    const both = composeBulletTraits([
      { id: 'frost', stacks: 1 },
      { id: 'incendiary', stacks: 1 },
    ]).color
    // Frost's blue shows through the fire, and fire's red shows through the frost:
    // a genuine mix — impossible if one mod simply overrode the other.
    expect(B(both), 'frost blue must survive the blend').toBeGreaterThan(B(fire))
    expect(R(both), 'fire red must survive the blend').toBeGreaterThan(R(frost))
    expect(both).not.toBe(frost)
    expect(both).not.toBe(fire)
  })

  it('each added mod SHIFTS the composed tint (combinatorial, never last-wins)', () => {
    const a = composeBulletTraits([{ id: 'frost', stacks: 1 }]).color
    const ab = composeBulletTraits([
      { id: 'frost', stacks: 1 },
      { id: 'lifesteal', stacks: 1 },
    ]).color
    const abc = composeBulletTraits([
      { id: 'frost', stacks: 1 },
      { id: 'lifesteal', stacks: 1 },
      { id: 'shock', stacks: 1 },
    ]).color
    // Every mod added changes the colour — three distinct tints, monotonic build-up.
    expect(ab).not.toBe(a)
    expect(abc).not.toBe(ab)
    // Vampiric maroon pulls red UP relative to lone frost; that pull persists.
    expect(R(ab)).toBeGreaterThan(R(a))
  })

  it('the composed core hue tracks each element\'s canonical pickup colour', () => {
    // frost → blue-dominant, incendiary → red-dominant, matching modColors.
    const frost = composeBulletTraits([{ id: 'frost', stacks: 1 }]).color
    const fire = composeBulletTraits([{ id: 'incendiary', stacks: 1 }]).color
    expect(B(frost)).toBeGreaterThan(R(frost))
    expect(R(fire)).toBeGreaterThan(B(fire))
  })
})

describe('splinterShot — the new shatter mod reads as shards', () => {
  it('sheds shard flecks and jitter, and changes the vanilla look', () => {
    const t = composeBulletTraits([{ id: 'splinterShot', stacks: 1 }])
    expect(t.flecks).toBeGreaterThan(0)
    expect(t.jitter).toBeGreaterThan(0)
    expect(t).not.toEqual(baseBulletTraits())
  })

  it('participates in the blend: splinterShot + frost differs from either alone', () => {
    const shard = composeBulletTraits([{ id: 'splinterShot', stacks: 1 }])
    const frost = composeBulletTraits([{ id: 'frost', stacks: 1 }])
    const both = composeBulletTraits([
      { id: 'splinterShot', stacks: 1 },
      { id: 'frost', stacks: 1 },
    ])
    expect(both).not.toEqual(shard)
    expect(both).not.toEqual(frost)
    // Both signatures survive: frost's trail/glow AND the shard flecks.
    expect(both.flecks).toBeGreaterThan(0)
    expect(both.trail).toBeGreaterThanOrEqual(frost.trail)
  })
})

describe('distort — the backbuffer refraction gate is a MOD TRAIT, not stack count', () => {
  // The exact set of air-warping mods (energy / heat / blast). distortion.ts's
  // sustainedSpecs gates the on-screen refraction lens on traits.distort > 0.
  const DISTORT_MODS = ['glassCannon', 'explosive', 'detonator', 'shock', 'incendiary', 'homing']

  it('every distort mod contributes a positive, sub-1 distort weight', () => {
    for (const id of DISTORT_MODS) {
      const t = composeBulletTraits([{ id, stacks: 1 }])
      expect(t.distort, `mod '${id}' should warp air`).toBeGreaterThan(0)
      expect(t.distort).toBeLessThan(1)
    }
  })

  it('mundane stat/mechanic mods never warp, however deep the stack', () => {
    for (const id of ALL_IDS.filter((m) => !DISTORT_MODS.includes(m))) {
      const t = composeBulletTraits([{ id, stacks: modMaxStacks(id) }])
      expect(t.distort, `mundane mod '${id}' must not warp`).toBe(0)
    }
    // A genuinely DEEP mundane build (power 5) still leaves distort at exactly 0
    // — proving the gate is the trait, not the old raw power>=3 threshold.
    const deepMundane = composeBulletTraits([
      { id: 'bulk', stacks: 2 }, { id: 'rapid', stacks: 2 }, { id: 'heavy', stacks: 1 },
    ])
    expect(deepMundane.power).toBe(5)
    expect(deepMundane.distort).toBe(0)
  })

  it('vanilla rounds never warp', () => {
    expect(baseBulletTraits().distort).toBe(0)
    expect(composeBulletTraits(undefined).distort).toBe(0)
  })

  it('distort accumulates monotonically as a distort mod stacks', () => {
    const s1 = composeBulletTraits([{ id: 'explosive', stacks: 1 }]).distort
    const s3 = composeBulletTraits([{ id: 'explosive', stacks: 3 }]).distort
    expect(s3).toBeGreaterThan(s1)
    expect(s3).toBeLessThan(1)
  })
})

describe('distinctness — the player can SEE each mod', () => {
  it('every single mod changes the vanilla look', () => {
    const base = baseBulletTraits()
    for (const id of ALL_IDS) {
      expect(composeBulletTraits([{ id, stacks: 1 }]), `mod '${id}' looks vanilla`).not.toEqual(base)
    }
  })

  it('no two single mods share the same composed look', () => {
    const looks = ALL_IDS.map((id) => ({ id, json: JSON.stringify(composeBulletTraits([{ id, stacks: 1 }])) }))
    for (let i = 0; i < looks.length; i++) {
      for (let j = i + 1; j < looks.length; j++) {
        expect(looks[i].json, `'${looks[i].id}' and '${looks[j].id}' look identical`).not.toBe(looks[j].json)
      }
    }
  })

  it('the three elements keep their canonical hues apart', () => {
    const frost = composeBulletTraits([{ id: 'frost', stacks: 1 }])
    const fire = composeBulletTraits([{ id: 'incendiary', stacks: 1 }])
    const shock = composeBulletTraits([{ id: 'shock', stacks: 1 }])
    // Frost pulls blue-dominant, incendiary red-dominant relative to each other.
    expect(frost.color & 0xff).toBeGreaterThan(fire.color & 0xff)
    expect((fire.color >> 16) & 0xff).toBeGreaterThanOrEqual((frost.color >> 16) & 0xff)
    expect(shock.jitter).toBeGreaterThan(frost.jitter)
    expect(shock.jitter).toBeGreaterThan(fire.jitter)
  })
})
