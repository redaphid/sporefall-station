// The thrown body as a pure function: deriveThrow picks the way and the force
// from what the renderer saw, simulateBody integrates it at whole ticks, poseAt
// reads it at any fraction. No pixi, no sim: the walls are a hand-made grid.

import { describe, expect, it } from 'vitest'
import {
  bodySeed,
  bounceOffWall,
  deriveThrow,
  poseAt,
  simulateBody,
  TUMBLE,
  type DeathFacts,
  type IsSolid,
  type OnWall,
  type Throw,
} from './displayBody'

/** A w×h room walled on every side (the border ring is solid). */
const room =
  (w: number, h: number, extra: readonly [number, number][] = []): IsSolid =>
  (tx, ty) =>
    tx <= 0 || ty <= 0 || tx >= w - 1 || ty >= h - 1 || extra.some(([x, y]) => x === tx && y === ty)

const facts = (over: Partial<DeathFacts> = {}): DeathFacts => ({
  id: 7,
  x: 10.5,
  y: 10.5,
  facing: 0,
  maxHp: 100,
  killDamage: 50,
  explosions: [],
  projectiles: [],
  hostiles: [],
  ...over,
})

const thrown = (over: Partial<Throw> = {}): Throw => ({
  x: 10.5,
  y: 10.5,
  dirX: 1,
  dirY: 0,
  force: 1,
  seed: 1234,
  source: 'projectile',
  ...over,
})

/** Is the body's footprint (or its centre, when it started flush) clear? */
const clear = (solid: IsSolid, x: number, y: number, r: number): boolean => {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++)
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) if (solid(tx, ty)) return false
  return true
}

const travelled = (t: ReturnType<typeof simulateBody>): number => {
  const a = t.poses[0]
  const b = t.poses[t.settle]
  return Math.hypot(b.x - a.x, b.y - a.y)
}

describe('deriveThrow: which way', () => {
  it('a blast that tick throws the body away from its centre, ahead of any round or hostile', () => {
    const th = deriveThrow(
      facts({
        explosions: [{ x: 10.5, y: 12.5, radius: 2.2 }],
        projectiles: [{ x: 6, y: 10.5, vx: 14, vy: 0, ticksBefore: 1, ownerId: 1 }],
        hostiles: [{ x: 12, y: 10.5 }],
      }),
    )
    expect(th.source).toBe('explosion')
    expect(th.dirX).toBeCloseTo(0, 9)
    expect(th.dirY).toBeCloseTo(-1, 9) // the blast was below: thrown up
    expect(th.force).toBeGreaterThanOrEqual(0.6)
  })

  it('a far blast that did not reach the body is ignored', () => {
    const th = deriveThrow(facts({ explosions: [{ x: 20, y: 20, radius: 2 }], hostiles: [{ x: 9.5, y: 10.5 }] }))
    expect(th.source).toBe('hostile')
  })

  it('a round seen flying at the body throws it along the flight, not away from the nearest hostile', () => {
    // The shooter stands north; the nearest hostile is east. The round flies south.
    const th = deriveThrow(
      facts({
        projectiles: [{ x: 10.5, y: 6.5, vx: 0, vy: 14, ticksBefore: 8, ownerId: 1 }],
        hostiles: [{ x: 11.5, y: 10.5 }],
      }),
    )
    expect(th.source).toBe('projectile')
    expect(th.dirX).toBeCloseTo(0, 9)
    expect(th.dirY).toBeCloseTo(1, 9)
  })

  it('rounds flying away, wide, too slow to arrive, or its own are not the killer', () => {
    const misses: DeathFacts['projectiles'] = [
      { x: 12, y: 10.5, vx: 14, vy: 0, ticksBefore: 1, ownerId: 1 }, // past it, flying away
      { x: 6, y: 13, vx: 14, vy: 0, ticksBefore: 1, ownerId: 1 }, // 2.5 tiles wide
      { x: 0.5, y: 10.5, vx: 14, vy: 0, ticksBefore: 1, ownerId: 1 }, // 10 tiles off at 14 t/s: needs 21 ticks
      { x: 9, y: 10.5, vx: 14, vy: 0, ticksBefore: 1, ownerId: 7 }, // the body's own shot
    ]
    const th = deriveThrow(facts({ projectiles: misses, hostiles: [{ x: 10.5, y: 12.5 }] }))
    expect(th.source).toBe('hostile')
    expect(th.dirY).toBeCloseTo(-1, 9)
  })

  it('melee (no blast, no round): away from the nearest hostile, snapped to 32 directions', () => {
    const th = deriveThrow(facts({ hostiles: [{ x: 9.5, y: 10.45 }, { x: 4, y: 4 }] }))
    expect(th.source).toBe('hostile')
    // 0.05 tiles off the axis is under half a sector: dead east.
    expect(th.dirX).toBeCloseTo(1, 9)
    expect(th.dirY).toBeCloseTo(0, 9)
  })

  it('nobody around: its own momentum, then backwards from its facing', () => {
    expect(deriveThrow(facts({ vel: { x: 0, y: -3 } }))).toMatchObject({ source: 'velocity' })
    expect(deriveThrow(facts({ vel: { x: 0, y: -3 } })).dirY).toBeCloseTo(-1, 9)
    const back = deriveThrow(facts({ vel: { x: 0.1, y: 0 }, facing: Math.PI / 2 }))
    expect(back.source).toBe('facing')
    expect(back.dirY).toBeCloseTo(-1, 9) // faced down, falls back up
  })
})

describe('deriveThrow: how hard', () => {
  it('a zero-damage kill (burn, a 0-dmg round) still gets the smallest throw, never NaN', () => {
    const th = deriveThrow(facts({ killDamage: 0 }))
    expect(th.force).toBeCloseTo(0.1, 9)
    const none = deriveThrow(facts({ killDamage: 0, maxHp: 0 }))
    expect(Number.isFinite(none.force)).toBe(true)
  })

  it('force grows with the killing damage over max hp and caps at 1 for any overkill', () => {
    const f = (d: number): number => deriveThrow(facts({ killDamage: d })).force
    expect(f(10)).toBeLessThan(f(50))
    expect(f(50)).toBeLessThan(f(100))
    expect(f(100)).toBe(1)
    expect(f(1e9)).toBe(1)
  })

  it('the seed is the same for the same body at the same spot and differs between bodies', () => {
    expect(bodySeed(7, 10.5, 10.5)).toBe(bodySeed(7, 10.5, 10.5))
    expect(bodySeed(7, 10.5, 10.5)).not.toBe(bodySeed(8, 10.5, 10.5))
    expect(bodySeed(7, 10.5, 10.5)).not.toBe(bodySeed(7, 11.5, 10.5))
  })
})

describe('simulateBody: the tumble', () => {
  const open = room(40, 40)

  it('a full-force throw hops, bounces twice, rolls onto its side, slides and stops a tile or two back', () => {
    const t = simulateBody(thrown(), open)
    const zs = t.poses.map((p) => p.z)
    // Airborne three times: the hop and two bounces, each lower than the last.
    const hops: number[] = []
    let peak = 0
    for (let i = 1; i < zs.length; i++) {
      if (zs[i] > 0) peak = Math.max(peak, zs[i])
      if (zs[i] === 0 && zs[i - 1] > 0) {
        hops.push(peak)
        peak = 0
      }
    }
    expect(hops.length).toBe(3)
    expect(hops[0]).toBeGreaterThan(hops[1])
    expect(hops[1]).toBeGreaterThan(hops[2])
    expect(hops[0] * 32).toBeGreaterThan(12) // a visible hop, in pixels
    const d = travelled(t)
    expect(d).toBeGreaterThan(1)
    expect(d).toBeLessThan(2.5)
    // Thrown right: spins clockwise, a full turn and onto its side.
    expect(t.poses[t.settle].rot).toBeCloseTo(Math.PI / 2 + Math.PI * 2, 9)
    // Monotone spin, still at the end, never below the floor.
    for (let i = 1; i < t.poses.length; i++) expect(t.poses[i].rot).toBeGreaterThanOrEqual(t.poses[i - 1].rot)
    expect(t.poses.every((p) => p.z >= 0)).toBe(true)
    expect(t.settle).toBeLessThan(TUMBLE.maxTicks)
  })

  it('huge overkill is speed-capped: no tick moves the body further than the cap', () => {
    const th = deriveThrow(facts({ killDamage: 1e9, hostiles: [{ x: 9.5, y: 10.5 }] }))
    const t = simulateBody(th, open)
    for (let i = 1; i < t.poses.length; i++) {
      const step = Math.hypot(t.poses[i].x - t.poses[i - 1].x, t.poses[i].y - t.poses[i - 1].y)
      expect(step).toBeLessThanOrEqual(TUMBLE.speed.max * 1.1 + 1e-12)
    }
    expect(travelled(t)).toBeLessThan(2.5)
  })

  it('a zero-damage kill barely moves: a small shove onto its side', () => {
    const t = simulateBody(deriveThrow(facts({ killDamage: 0, hostiles: [{ x: 9.5, y: 10.5 }] })), open)
    expect(travelled(t)).toBeLessThan(0.4)
    expect(Math.abs(t.poses[t.settle].rot)).toBeCloseTo(Math.PI / 2, 9)
  })

  it('thrown left spins the other way; straight up or down, the seed picks a side', () => {
    expect(simulateBody(thrown({ dirX: -1 }), open).poses.at(-1)!.rot).toBeLessThan(0)
    const sides = new Set<number>()
    for (let seed = 0; seed < 16; seed++) sides.add(Math.sign(simulateBody(thrown({ dirX: 0, dirY: 1, seed }), open).poses.at(-1)!.rot))
    expect([...sides].sort()).toEqual([-1, 1])
  })

  it('a body dying flush against a wall, thrown into it, never enters the wall and records the touch', () => {
    // Wall column x = 12; the body's footprint (0.3) touches x = 11.7.
    const solid = room(40, 40, Array.from({ length: 40 }, (_, y) => [12, y] as [number, number]))
    const t = simulateBody(thrown({ x: 11.69, y: 10.5 }), solid)
    for (const p of t.poses) expect(p.x + TUMBLE.radius).toBeLessThan(12)
    expect(t.contacts.length).toBeGreaterThan(0)
    expect(t.contacts[0]).toMatchObject({ tick: 1, nx: -1, ny: 0 })
    expect(t.poses[t.settle].x).toBeLessThan(11.69) // bounced back into the room
  })

  it('in a corner, thrown into both walls, it stays in the open tile', () => {
    const solid = room(12, 12)
    const s = Math.SQRT1_2
    const t = simulateBody(thrown({ x: 10.6, y: 10.6, dirX: s, dirY: s }), solid)
    for (const p of t.poses) expect(clear(solid, p.x, p.y, TUMBLE.radius)).toBe(true)
    expect(t.contacts.some((c) => c.nx === -1)).toBe(true)
    expect(t.contacts.some((c) => c.ny === -1)).toBe(true)
  })

  it('a footprint that already overlaps a wall falls back to its centre and still never enters one', () => {
    const solid = room(12, 12)
    // 0.1 from the wall: the 0.3 footprint is in it already.
    const t = simulateBody(thrown({ x: 10.9, y: 5.5 }), solid)
    for (const p of t.poses) expect(solid(Math.floor(p.x), Math.floor(p.y))).toBe(false)
  })

  it('a centre inside a wall (cannot happen in the sim) does not move at all', () => {
    const t = simulateBody(thrown({ x: 0.5, y: 0.5 }), room(12, 12))
    expect(t.poses.every((p) => p.x === 0.5 && p.y === 0.5)).toBe(true)
  })

  it('across many throws in a cluttered room, no pose ever leaves the floor', () => {
    const pillars: [number, number][] = []
    for (let x = 3; x < 18; x += 3) for (let y = 3; y < 18; y += 3) pillars.push([x, y])
    const solid = room(20, 20, pillars)
    for (let i = 0; i < 200; i++) {
      const a = (i * 2.399) % (Math.PI * 2)
      const x = 1.5 + ((i * 7) % 17) + 0.31
      const y = 1.5 + ((i * 11) % 17) + 0.31
      if (!clear(solid, x, y, TUMBLE.radius)) continue
      const t = simulateBody(thrown({ x, y, dirX: Math.cos(a), dirY: Math.sin(a), force: (i % 10) / 9, seed: i }), solid)
      for (const p of t.poses) expect(clear(solid, p.x, p.y, TUMBLE.radius)).toBe(true)
    }
  })

  it('the wall seam: onWall sees every touch and its answer is the rebound', () => {
    const solid = room(40, 40, Array.from({ length: 40 }, (_, y) => [12, y] as [number, number]))
    const seen: number[] = []
    // A slam that sticks: the body stops dead at the wall.
    const stick: OnWall = (c) => {
      seen.push(c.tick)
      return { x: 0, y: 0 }
    }
    const t = simulateBody(thrown({ x: 11, y: 10.5 }), solid, stick)
    expect(seen.length).toBe(1)
    expect(t.contacts.map((c) => c.tick)).toEqual(seen)
    const after = t.poses.slice(seen[0])
    expect(new Set(after.map((p) => p.x)).size).toBe(1)
    // The default bounce sends it back out.
    expect(bounceOffWall(t.contacts[0], { x: 0.05, y: 0.01 }).x).toBeLessThan(0)
  })
})

describe('poseAt: the same pose at the same tick, whatever the frame rate', () => {
  it('reads the track by tick, so a 60 fps phone and an 8-ticks-a-frame phone agree on every tick', () => {
    const t = simulateBody(thrown(), room(40, 40))
    const fine: Record<number, ReturnType<typeof poseAt>> = {}
    for (let k = 0; k <= 60 * 4; k++) fine[k / 4] = poseAt(t, k / 4)
    for (let tick = 0; tick <= 60; tick += 8) expect(poseAt(t, tick)).toEqual(fine[tick])
    // Two separately integrated tracks of the same throw are identical.
    expect(simulateBody(thrown(), room(40, 40))).toEqual(t)
  })

  it('holds the first pose before the death and the last after the settle', () => {
    const t = simulateBody(thrown(), room(40, 40))
    expect(poseAt(t, -3)).toEqual(t.poses[0])
    expect(poseAt(t, Number.NaN)).toEqual(t.poses[0])
    expect(poseAt(t, 1e6)).toEqual(t.poses[t.settle])
  })
})
