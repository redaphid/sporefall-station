// The wall slam (#173) as pure functions: simulateBody with `slam` records the
// hard hit and scripts SLAM, CRUMPLE, SLUMP; slamAt is the squash; slamFx.ts
// is the sprite's matrix, its reach to the wall, and the burst and the dust.
// No pixi, no sim: the walls are a hand-made grid.

import { describe, expect, it } from 'vitest'
import { blocked, poseAt, SLAM, simulateBody, slamAt, stopAtWall, TUMBLE, type BodyTrack, type IsSolid, type Throw } from './displayBody'
import { BODY_FILL, burstBlocks, dustBlocks, FAN, reachToWall, squashMatrix, type Mat } from './slamFx'

/** A w x h room walled on every side. */
const room =
  (w: number, h: number, extra: readonly [number, number][] = []): IsSolid =>
  (tx, ty) =>
    tx <= 0 || ty <= 0 || tx >= w - 1 || ty >= h - 1 || extra.some(([x, y]) => x === tx && y === ty)

const solid = room(20, 20)
const F = TUMBLE.footprint

const thrown = (over: Partial<Throw> = {}): Throw => ({
  x: 10,
  y: 10,
  dirX: 1,
  dirY: 0,
  force: 0.8,
  seed: 7,
  source: 'projectile',
  ...over,
})

/** A hard throw that meets the named wall of `room(20, 20)` in mid-air: it
 * stands `gap` tiles (past its footprint) off the face. */
const into = (wall: 'E' | 'W' | 'N' | 'S', gap = 0.45, over: Partial<Throw> = {}): Throw => {
  if (wall === 'E') return thrown({ x: 19 - F.x - gap, dirX: 1, dirY: 0, ...over })
  if (wall === 'W') return thrown({ x: 1 + F.x + gap, dirX: -1, dirY: 0, ...over })
  if (wall === 'N') return thrown({ y: 1 + F.y + gap, dirX: 0, dirY: -1, ...over })
  return thrown({ y: 19 - F.y - gap, dirX: 0, dirY: 1, ...over })
}

const NORMAL = { E: [-1, 0], W: [1, 0], N: [0, 1], S: [0, -1] } as const

const slammed = (th: Throw, s: IsSolid = solid): BodyTrack => simulateBody(th, s, stopAtWall, { slam: true })

/** The track never puts its footprint in a wall, and never carries the body
 * back against the blow past where it died. */
const expectSane = (t: BodyTrack, s: IsSolid = solid): void => {
  const th = t.throw
  for (const p of t.poses) {
    expect(blocked(s, p.x, p.y, F.x, F.y), `in a wall at ${p.x},${p.y}`).toBe(false)
    expect((p.x - th.x) * th.dirX + (p.y - th.y) * th.dirY).toBeGreaterThanOrEqual(-1e-9)
  }
  for (let i = 1; i < t.poses.length; i++) {
    const a = t.poses[i - 1]
    const b = t.poses[i]
    // Never back toward the shooter, tick to tick.
    expect((b.x - a.x) * th.dirX + (b.y - a.y) * th.dirY).toBeGreaterThanOrEqual(-1e-9)
  }
}

/** A pixi-style matrix applied to a vector. */
const apply = (m: Mat, x: number, y: number): [number, number] => [m.a * x + m.c * y, m.b * x + m.d * y]

describe('a hard hit into each wall slams, crumples and slumps', () => {
  for (const wall of ['E', 'W', 'N', 'S'] as const) {
    it(`${wall}: one slam, its normal, pressed to the face, down at the foot on its side`, () => {
      const t = slammed(into(wall))
      const sl = t.slam!
      expect(sl).toBeDefined()
      const [nx, ny] = NORMAL[wall]
      expect([sl.nx, sl.ny]).toEqual([nx, ny])
      expect(sl.speed).toBeGreaterThanOrEqual(SLAM.minSpeed)
      expect(sl.z).toBeGreaterThan(0.2) // in mid-air: it slides down after
      expect(sl.amp).toBeGreaterThanOrEqual(SLAM.squash.min)
      expect(sl.amp).toBeLessThanOrEqual(SLAM.squash.max)
      // Pressed: the footprint touches the face (within a hair), and the face
      // on record is that wall's.
      const face = { E: 19, W: 1, N: 1, S: 19 }[wall]
      if (nx !== 0) {
        expect(sl.faceX).toBe(face)
        expect(Math.abs(sl.x - nx * F.x - face)).toBeLessThan(1e-3)
      } else {
        expect(sl.faceY).toBe(face)
        expect(Math.abs(sl.y - ny * F.y - face)).toBeLessThan(1e-3)
      }
      // SLAM: stuck where it hit for SLAM.hold ticks.
      for (let s = 0; s <= SLAM.hold; s++) expect(t.poses[sl.tick + s]).toMatchObject({ x: sl.x, y: sl.y, z: sl.z })
      // SLUMP: straight down the face, never lower than the floor, never up.
      for (let i = sl.tick + 1; i < t.poses.length; i++) {
        expect(t.poses[i].x).toBe(sl.x)
        expect(t.poses[i].y).toBe(sl.y)
        expect(t.poses[i].z).toBeLessThanOrEqual(t.poses[i - 1].z)
        expect(t.poses[i].z).toBeGreaterThanOrEqual(0)
      }
      expect(t.poses[sl.down].z).toBe(0)
      expect(sl.down).toBe(sl.tick + SLAM.hold + SLAM.slump)
      expect(t.landed).toBe(sl.down)
      // At rest at the foot, on its side.
      const end = t.poses[t.settle]
      expect(end.z).toBe(0)
      expect(Math.abs(end.rot)).toBeCloseTo(Math.PI / 2, 9)
      expectSane(t)
    })
  }

  it('the tip only ever goes one way, onto its side, plus the rock: it never reads as standing back up', () => {
    for (const wall of ['E', 'W', 'N', 'S'] as const) {
      for (let seed = 0; seed < 8; seed++) {
        const t = slammed(into(wall, 0.45, { seed }))
        const side = Math.sign(t.poses.at(-1)!.rot)
        const land = t.landed
        for (let i = 1; i <= land; i++) expect(side * (t.poses[i].rot - t.poses[i - 1].rot)).toBeGreaterThanOrEqual(-1e-12)
        for (const p of t.poses) expect(Math.abs(p.rot)).toBeLessThanOrEqual(Math.PI / 2 + TUMBLE.rock + 1e-9)
      }
    }
  })

  it('the squash: full at the impact, held flat, sprung back past round, gone by hold + spring', () => {
    const t = slammed(into('E'))
    const sl = t.slam!
    expect(slamAt(t, sl.tick - 0.01)).toBeUndefined()
    expect(slamAt(t, sl.tick)!.q).toBeCloseTo(sl.amp, 12)
    for (let s = 0; s < SLAM.hold; s += 0.25) expect(slamAt(t, sl.tick + s)!.q).toBeGreaterThan(0.7 * sl.amp)
    const after = Array.from({ length: SLAM.spring * 8 }, (_, i) => slamAt(t, sl.tick + SLAM.hold + i / 8)!.q)
    expect(Math.min(...after)).toBeLessThan(0) // the stretch past round
    expect(Math.min(...after)).toBeGreaterThan(-0.5 * sl.amp)
    expect(slamAt(t, sl.tick + SLAM.hold + SLAM.spring)).toBeUndefined()
    expect(slamAt(t, Number.NaN)).toBeUndefined()
    // No slam on the track, no squash.
    expect(slamAt(simulateBody(into('E'), solid), sl.tick)).toBeUndefined()
  })

  it('a harder hit squashes flatter, up to SLAM.squash.max', () => {
    const soft = slammed(into('E', 0.45, { force: 0.45 })).slam!
    const hard = slammed(into('E', 0.45, { force: 1 })).slam!
    expect(hard.speed).toBeGreaterThan(soft.speed)
    expect(hard.amp).toBeGreaterThan(soft.amp)
  })
})

describe('what does not slam', () => {
  it('a gentle touch just stops: no slam, the same track as the plain tumble', () => {
    // Weak throws at a sweep of distances: every one that touches the wall
    // under SLAM.minSpeed is the plain tumble's track exactly.
    let touches = 0
    for (let gap = 0.05; gap < 1.6; gap += 0.05) {
      for (const wall of ['E', 'N'] as const) {
        const th = into(wall, gap, { force: 0.25 })
        const on = slammed(th)
        if (on.contacts.length === 0 || on.slam) continue
        touches++
        expect(Math.max(...on.contacts.map((c) => c.speed))).toBeLessThan(SLAM.minSpeed)
        expect(on).toEqual(simulateBody(th, solid))
      }
    }
    expect(touches).toBeGreaterThan(3)
  })

  it('a throw that meets no wall: the same track either way', () => {
    const th = thrown({ x: 10, y: 10, force: 1 })
    expect(slammed(th)).toEqual(simulateBody(th, solid))
  })

  it('off (the default) is the plain tumble: a hard hit stops at the wall with no slam', () => {
    const t = simulateBody(into('E'), solid)
    expect(t.slam).toBeUndefined()
    expect(t.contacts[0].speed).toBeGreaterThan(SLAM.minSpeed)
    expect(simulateBody(into('E'), solid, stopAtWall, { slam: false })).toEqual(t)
  })
})

describe('edge cases', () => {
  it('a corner: two faces, one slam, a diagonal normal, pressed to both', () => {
    const s = Math.SQRT1_2
    const t = slammed(thrown({ x: 19 - F.x - 0.3, y: 19 - F.y - 0.3, dirX: s, dirY: s, force: 1 }))
    const sl = t.slam!
    expect(sl.nx).toBeCloseTo(-s, 12)
    expect(sl.ny).toBeCloseTo(-s, 12)
    expect(sl.faceX).toBe(19)
    expect(sl.faceY).toBe(19)
    expect(t.contacts.some((c) => c.nx === -1)).toBe(true)
    expect(t.contacts.some((c) => c.ny === -1)).toBe(true)
    expect(Math.abs(sl.x + F.x - 19)).toBeLessThan(1e-3)
    expect(Math.abs(sl.y + F.y - 19)).toBeLessThan(1e-3)
    expectSane(t)
  })

  it('a second wall a moment away across the first is the same corner', () => {
    // The east face is hit first; the south one is a tick or two off.
    const s = Math.SQRT1_2
    const t = slammed(thrown({ x: 19 - F.x - 0.2, y: 19 - F.y - 0.25, dirX: s, dirY: s, force: 1 }))
    expect(t.slam!.ny).toBeLessThan(0)
    expect(t.slam!.nx).toBeLessThan(0)
    expectSane(t)
  })

  it('a body dying flush against the wall slams on the tick it is thrown', () => {
    // 0.15 off the face: inside its full footprint, so the footprint shrinks.
    const t = slammed(thrown({ x: 18.85, dirX: 1, force: 1 }))
    expect(t.slam!.tick).toBe(1)
    expect(t.slam!.faceX).toBe(19)
    for (const p of t.poses) {
      expect(p.x).toBeGreaterThanOrEqual(18.85)
      expect(p.x).toBeLessThan(19)
    }
  })

  it('a slam right at the floor (z 0 at the impact) has no slide and lands at once', () => {
    let found = false
    for (let gap = 0.05; gap < 2 && !found; gap += 0.01) {
      const t = slammed(into('E', gap, { force: 1 }))
      if (t.slam && t.slam.z === 0) {
        found = true
        expect(t.slam.down).toBe(t.slam.tick)
        for (const p of t.poses.slice(t.slam.tick)) expect(p.z).toBe(0)
      }
    }
    expect(found).toBe(true)
  })

  it('across many hard throws in a cluttered room: never in a wall, never back at the shooter', () => {
    const pillars: [number, number][] = []
    for (let x = 3; x < 18; x += 3) for (let y = 3; y < 18; y += 3) pillars.push([x, y])
    const cluttered = room(20, 20, pillars)
    let slams = 0
    for (let i = 0; i < 300; i++) {
      const a = (i * 2.399) % (Math.PI * 2)
      const x = 1.5 + ((i * 7) % 17) + 0.31
      const y = 1.5 + ((i * 11) % 17) + 0.31
      if (blocked(cluttered, x, y, F.x, F.y)) continue
      const t = slammed(thrown({ x, y, dirX: Math.cos(a), dirY: Math.sin(a), force: 0.5 + (i % 6) / 10, seed: i }), cluttered)
      if (t.slam) slams++
      expectSane(t, cluttered)
    }
    expect(slams).toBeGreaterThan(20)
  })

  it('the same throw twice is the same track, and poseAt reads it the same at any frame rate', () => {
    const a = slammed(into('N'))
    expect(slammed(into('N'))).toEqual(a)
    for (let k = 0; k <= 4 * a.settle; k++) {
      const tk = k / 4
      expect(poseAt(a, tk)).toEqual(poseAt(slammed(into('N')), tk))
    }
  })
})

describe('slamFx: the squash on screen', () => {
  it('flattens along the normal and spreads across it, in world axes, whatever the spin and flip', () => {
    for (const [nx, ny] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-Math.SQRT1_2, -Math.SQRT1_2]]) {
      for (const rot of [0, 0.4, 1.1, Math.PI / 2, -0.7]) {
        for (const flip of [false, true]) {
          const q = 0.4
          const m = squashMatrix(rot, flip, q, nx, ny)
          // Undo the sprite's own spin and flip: what is left is the squash W.
          const f = flip ? -1 : 1
          const c = Math.cos(rot)
          const s = Math.sin(rot)
          // (R F)^-1 = F R^T
          const inv: Mat = { a: f * c, b: -s, c: f * s, d: c }
          const w = { a: m.a * inv.a + m.c * inv.b, b: m.b * inv.a + m.d * inv.b, c: m.a * inv.c + m.c * inv.d, d: m.b * inv.c + m.d * inv.d }
          const [wn0, wn1] = apply(w, nx, ny)
          expect(wn0).toBeCloseTo((1 - q) * nx, 12)
          expect(wn1).toBeCloseTo((1 - q) * ny, 12)
          const [wp0, wp1] = apply(w, -ny, nx)
          expect(wp0).toBeCloseTo((1 + SLAM.spread * q) * -ny, 12)
          expect(wp1).toBeCloseTo((1 + SLAM.spread * q) * nx, 12)
        }
      }
    }
  })

  it('with no squash it is the plain spun, flipped sprite', () => {
    const m = squashMatrix(0.8, true, 0, 1, 0)
    expect(m.a).toBeCloseTo(-Math.cos(0.8), 12)
    expect(m.b).toBeCloseTo(-Math.sin(0.8), 12)
    expect(m.c).toBeCloseTo(-Math.sin(0.8), 12)
    expect(m.d).toBeCloseTo(Math.cos(0.8), 12)
  })

  it('reach to the wall: half the body across standing, half its length lying', () => {
    const w = 48
    const h = 48
    expect(reachToWall(0, w, h, 1, 0)).toBeCloseTo((w * BODY_FILL.w) / 2, 12)
    expect(reachToWall(Math.PI / 2, w, h, 1, 0)).toBeCloseTo((h * BODY_FILL.h) / 2, 12)
    expect(reachToWall(0, w, h, 0, -1)).toBeCloseTo((h * BODY_FILL.h) / 2, 12)
    // Half tipped, an ellipse reaches less far than the canvas corner would.
    const half = reachToWall(Math.PI / 4, w, h, 1, 0)
    expect(half).toBeLessThan(Math.SQRT1_2 * ((w * BODY_FILL.w) / 2 + (h * BODY_FILL.h) / 2))
  })
})

describe('slamFx: the burst and the dust', () => {
  const seed = 99
  it('the burst lasts SLAM.burstTicks, in whole pixels, the same every time', () => {
    expect(burstBlocks(-0.01, seed, 100, 50, -1, 0)).toEqual([])
    expect(burstBlocks(SLAM.burstTicks, seed, 100, 50, -1, 0)).toEqual([])
    for (let s = 0; s < SLAM.burstTicks; s += 0.5) {
      const b = burstBlocks(s, seed, 100.4, 50.6, -1, 0)
      expect(b.length).toBeGreaterThan(0)
      expect(b).toEqual(burstBlocks(s, seed, 100.4, 50.6, -1, 0))
      // Within a tick it is one frame: the same blocks at s and its floor.
      expect(b).toEqual(burstBlocks(Math.floor(s), seed, 100.4, 50.6, -1, 0))
      for (const k of b) {
        for (const v of [k.x, k.y, k.w, k.h]) expect(Number.isInteger(v)).toBe(true)
        expect(k.alpha).toBeGreaterThan(0)
        expect(k.alpha).toBeLessThanOrEqual(1)
      }
    }
  })

  it('in profile the rays stay out of the wall: off an east wall, nothing right of the face', () => {
    for (let s = 0; s < SLAM.burstTicks; s++) {
      for (const k of burstBlocks(s, seed, 100, 50, -1, 0, FAN.profile)) expect(k.x).toBeLessThanOrEqual(100 + 2)
      for (const k of burstBlocks(s, seed, 100, 50, 1, 0, FAN.profile)) expect(k.x + k.w).toBeGreaterThanOrEqual(100 - 2)
    }
  })

  it('face-on it rings the splat: blocks on every side', () => {
    const b = burstBlocks(1, seed, 100, 50, 0, 1, FAN.ring)
    expect(b.some((k) => k.x < 95)).toBe(true)
    expect(b.some((k) => k.x > 105)).toBe(true)
    expect(b.some((k) => k.y < 45)).toBe(true)
    expect(b.some((k) => k.y > 55)).toBe(true)
  })

  it('the dust puff: SLAM.dustTicks long, both sides, rising, fading', () => {
    expect(dustBlocks(-1, seed, 100, 50)).toEqual([])
    expect(dustBlocks(SLAM.dustTicks, seed, 100, 50)).toEqual([])
    const first = dustBlocks(0, seed, 100, 50)
    const last = dustBlocks(SLAM.dustTicks - 1, seed, 100, 50)
    expect(first.some((k) => k.x < 100)).toBe(true)
    expect(first.some((k) => k.x > 100)).toBe(true)
    for (const k of first) expect(k.y + k.h).toBeLessThanOrEqual(50)
    expect(Math.max(...last.map((k) => k.alpha))).toBeLessThan(Math.max(...first.map((k) => k.alpha)))
    expect(Math.min(...last.map((k) => k.y))).toBeLessThan(Math.min(...first.map((k) => k.y)))
  })
})
