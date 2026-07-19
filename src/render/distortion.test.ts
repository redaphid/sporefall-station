import { describe, expect, it } from 'vitest'
import { makeEntity } from '../game/entity'
import type { SimEvent } from '../game/types'
import {
  DistortionPool,
  KIND_INDEX,
  MAX_PRIMS,
  packPrims,
  seedHash,
  specsForEvents,
  sustainedSpecs,
  type DistortionSpec,
  type UvProjector,
} from './distortion'

const spec = (over: Partial<DistortionSpec> = {}): DistortionSpec => ({
  kind: 'refraction',
  x: 5,
  y: 5,
  radius: 1,
  strength: 0.5,
  seed: 0.25,
  life: 10,
  ...over,
})

/** Identity-ish projector: centre of a 10x10-tile view, radius = tiles/10. */
const proj: UvProjector = {
  toUv: (x, y) => ({ x: x / 10, y: y / 10 }),
  radiusToUv: (r) => r / 10,
}

const pack = (pool: DistortionPool, time: number): { a: Float32Array; b: Float32Array; n: number } => {
  const a = new Float32Array(MAX_PRIMS * 4)
  const b = new Float32Array(MAX_PRIMS * 4)
  const n = packPrims(pool, time, proj, a, b)
  return { a, b, n }
}

describe('DistortionPool', () => {
  it('spawns, lives for its ttl, then expires', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ life: 5 }), 100)
    expect(pool.list()).toHaveLength(1)
    pool.update(104)
    expect(pool.list()).toHaveLength(1)
    pool.update(105)
    expect(pool.list()).toHaveLength(0)
  })

  it('caps at MAX_PRIMS by evicting the soonest-to-expire prim', () => {
    const pool = new DistortionPool()
    for (let i = 0; i < MAX_PRIMS; i++) pool.spawn(spec({ x: i, life: 20 + i }), 0)
    expect(pool.list()).toHaveLength(MAX_PRIMS)
    pool.spawn(spec({ x: 99, life: 100 }), 0)
    expect(pool.list()).toHaveLength(MAX_PRIMS)
    // The life-20 prim (soonest expiry) is gone; the newcomer survives.
    expect(pool.list().some((p) => p.x === 0)).toBe(false)
    expect(pool.list().some((p) => p.x === 99)).toBe(true)
  })

  it('eviction is deterministic on ties (lowest slot goes first)', () => {
    const pool = new DistortionPool()
    for (let i = 0; i < MAX_PRIMS; i++) pool.spawn(spec({ x: i, life: 10 }), 0)
    pool.spawn(spec({ x: 50, life: 10 }), 0)
    pool.spawn(spec({ x: 51, life: 10 }), 0)
    const xs = pool.list().map((p) => p.x)
    expect(xs).not.toContain(0)
    expect(xs).not.toContain(1)
    expect(xs).toContain(50)
    expect(xs).toContain(51)
  })

  it('keyed prims refresh in place — no duplicates, phase (bornTick) kept', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ key: 'fire:7', x: 1, life: 4 }), 10)
    pool.spawn(spec({ key: 'fire:7', x: 2, life: 4 }), 12)
    expect(pool.list()).toHaveLength(1)
    const p = pool.list()[0]
    expect(p.x).toBe(2) // followed the source
    expect(p.bornTick).toBe(10) // animation phase never restarts
    expect(p.expireTick).toBe(16) // expiry pushed ahead
    // Stop refreshing: it expires a beat later.
    pool.update(16)
    expect(pool.list()).toHaveLength(0)
  })

  it('clear() empties the pool', () => {
    const pool = new DistortionPool()
    pool.spawn(spec(), 0)
    pool.clear()
    expect(pool.list()).toHaveLength(0)
  })
})

describe('specsForEvents — event → primitive mapping', () => {
  const at = { x: 3, y: 4 }

  it('an explosion spawns a shockwave AND a kaleidoscopic bloom, radius-scaled', () => {
    const ev: SimEvent[] = [{ type: 'explosion', x: at.x, y: at.y, radius: 2 }]
    const specs = specsForEvents(ev, 50)
    expect(specs.map((s) => s.kind).sort()).toEqual(['bloom', 'shockwave'])
    const wave = specs.find((s) => s.kind === 'shockwave')!
    const bloom = specs.find((s) => s.kind === 'bloom')!
    expect(wave.radius).toBeGreaterThan(2) // the pressure wave outruns the damage
    expect(bloom.radius).toBeGreaterThan(2)
    expect(wave.seed).toBe(bloom.seed) // one blast, one phase
  })

  it('impacts and doused burns map to refraction / shimmer', () => {
    const evs: SimEvent[] = [
      { type: 'hit', x: 1, y: 1, targetId: 9, amount: 3 },
      { type: 'shatter', x: 2, y: 2, entityId: 8 },
      { type: 'shock', x: 3, y: 3, targetId: 7 },
      { type: 'burnDoused', x: 4, y: 4, entityId: 6, remainingTicks: 0 },
    ]
    const kinds = specsForEvents(evs, 0).map((s) => s.kind)
    expect(kinds).toEqual(['refraction', 'refraction', 'refraction', 'shimmer'])
  })

  it('irrelevant events spawn nothing', () => {
    const evs: SimEvent[] = [
      { type: 'doorToggle', entityId: 1, open: true },
      { type: 'noise', x: 0, y: 0 },
      { type: 'missionComplete', description: 'x' },
    ]
    expect(specsForEvents(evs, 0)).toHaveLength(0)
  })

  it('is pure: same events + tick → identical specs', () => {
    const evs: SimEvent[] = [{ type: 'explosion', x: 7.25, y: 9.5, radius: 1.5 }]
    expect(specsForEvents(evs, 33)).toEqual(specsForEvents(evs, 33))
  })

  it('different blasts get different seeds', () => {
    const a = specsForEvents([{ type: 'explosion', x: 1, y: 1, radius: 1 }], 10)[0]
    const b = specsForEvents([{ type: 'explosion', x: 2, y: 1, radius: 1 }], 10)[0]
    expect(a.seed).not.toBe(b.seed)
  })
})

describe('sustainedSpecs — entity-tracked prims', () => {
  it('fire cells shimmer, keyed by entity id', () => {
    const fire = makeEntity('fire', 'fire', 4, 5, 0.4)
    fire.fire = { fuel: 30 }
    const specs = sustainedSpecs([fire])
    expect(specs).toHaveLength(1)
    expect(specs[0].kind).toBe('shimmer')
    expect(specs[0].key).toBe(`fire:${fire.id}`)
    expect(specs[0].x).toBe(4)
  })

  it('deep-stack rounds (power >= 3) refract; shallow builds do not', () => {
    const deep = makeEntity('projectile', 'projectile', 1, 1, 0.1)
    deep.projectile = {
      ownerId: 1,
      damage: 1,
      ttl: 30,
      // Three effective stacks — the chroma tier (frost caps at 1 stack).
      mods: [{ id: 'frost', stacks: 1 }, { id: 'overload', stacks: 1 }, { id: 'rapid', stacks: 1 }],
    }
    const shallow = makeEntity('projectile', 'projectile', 2, 2, 0.1)
    shallow.projectile = { ownerId: 1, damage: 1, ttl: 30, mods: [{ id: 'frost', stacks: 1 }] }
    const vanilla = makeEntity('projectile', 'projectile', 3, 3, 0.1)
    vanilla.projectile = { ownerId: 1, damage: 1, ttl: 30 }
    const specs = sustainedSpecs([deep, shallow, vanilla])
    expect(specs).toHaveLength(1)
    expect(specs[0].kind).toBe('refraction')
    expect(specs[0].key).toBe(`proj:${deep.id}`)
    expect(specs[0].strength).toBeGreaterThan(0)
    expect(specs[0].strength).toBeLessThanOrEqual(0.5)
  })

  it('dead entities contribute nothing', () => {
    const fire = makeEntity('fire', 'fire', 4, 5, 0.4)
    fire.fire = { fuel: 30 }
    fire.dead = true
    expect(sustainedSpecs([fire])).toHaveLength(0)
  })
})

describe('packPrims — uniform packing', () => {
  it('packs layout (u,v,r,age | kind,strength,seed,env) and returns the count', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ kind: 'shockwave', x: 5, y: 2.5, radius: 2, strength: 0.8, seed: 0.5, life: 10 }), 100)
    const { a, b, n } = pack(pool, 105)
    expect(n).toBe(1)
    expect(a[0]).toBeCloseTo(0.5) // u
    expect(a[1]).toBeCloseTo(0.25) // v
    expect(a[2]).toBeCloseTo(0.2) // radiusUv
    expect(a[3]).toBeCloseTo(0.5) // age: 5 of 10 ticks
    expect(b[0]).toBe(KIND_INDEX.shockwave)
    expect(b[1]).toBeCloseTo(0.8)
    expect(b[2]).toBeCloseTo(0.5)
    expect(b[3]).toBeGreaterThan(0) // envelope live mid-life
  })

  it('deterministic: same pool + time → byte-identical packs', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ kind: 'shimmer', seed: seedHash(42), life: 30 }), 7)
    pool.spawn(spec({ kind: 'bloom', x: 8, seed: seedHash(43), life: 26 }), 9)
    const p1 = pack(pool, 20.5)
    const p2 = pack(pool, 20.5)
    expect(p1.n).toBe(p2.n)
    expect(Array.from(p1.a)).toEqual(Array.from(p2.a))
    expect(Array.from(p1.b)).toEqual(Array.from(p2.b))
  })

  it('animates purely off time: different alpha → different age, same layout', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ life: 10 }), 100)
    const t1 = pack(pool, 102)
    const t2 = pack(pool, 102.5)
    expect(t1.a[3]).toBeCloseTo(0.2)
    expect(t2.a[3]).toBeCloseTo(0.25)
  })

  it('culls prims far off-screen', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ x: -50, y: 5 }), 0) // uv x = -5, way past the margin
    pool.spawn(spec({ x: 5, y: 5 }), 0)
    const { n, a } = pack(pool, 1)
    expect(n).toBe(1)
    expect(a[0]).toBeCloseTo(0.5)
  })

  it('envelope ramps in, holds while refreshed, ramps out toward expiry', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ key: 'fire:1', life: 60 }), 0)
    const early = pack(pool, 1).b[3]
    const held = pack(pool, 30).b[3]
    const late = pack(pool, 58).b[3]
    expect(early).toBeLessThan(held)
    expect(held).toBe(1)
    expect(late).toBeLessThan(1)
  })

  it('never writes past MAX_PRIMS even with an over-full spawn burst', () => {
    const pool = new DistortionPool()
    for (let i = 0; i < MAX_PRIMS * 2; i++) pool.spawn(spec({ x: 5, y: 5, life: 10 + i }), 0)
    const { n } = pack(pool, 1)
    expect(n).toBe(MAX_PRIMS)
  })

  it('degenerate prims (zero/NaN-free contract): radius 0 packs without NaN', () => {
    const pool = new DistortionPool()
    pool.spawn(spec({ radius: 0 }), 0)
    const { a, b } = pack(pool, 1)
    for (const v of [...a.slice(0, 4), ...b.slice(0, 4)]) expect(Number.isFinite(v)).toBe(true)
  })
})
