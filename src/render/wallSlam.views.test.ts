// The wall slam (#173) at the entity layer the game draws with: EntityViews
// over a real art registry, the real sim underneath (animTestkit.ts), a real
// pistol kill that throws a mutant into each wall of a walled room. The tests
// read the death ghost back tick by tick: the squash on screen, the body kept
// out of the wall, the burst Graphics, the expiry, and that the frame cadence
// and a hitstop do not change what is drawn at a tick.
//
// Off (the default for the testkit, and EntityViews without `slam`) is the
// plain tumble; deathTumble.views.test.ts pins that against its golden.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Graphics, Sprite } from 'pixi.js'
import type { Entity } from '../game/entity'
import { spawnNpc } from '../game/populate'
import { arm, walledRoom, worldFromRows } from '../game/testkit'
import { brawlScene, fakeArt, tank, trace, type Frame, type Scene, type TraceOpts } from './animTestkit'
import { TILE_PX } from './art'
import { poseAt, SLAM, TUMBLE, type BodyTrack } from './displayBody'
import { BODY_FILL } from './slamFx'
import type { EntityViews } from './sprites'

interface GhostPeek {
  id: number
  start: number
  flip: boolean
  sprite: Sprite
  body?: BodyTrack
  shadow?: Graphics
  fx?: Graphics
}
const ghostsOf = (v: EntityViews): GhostPeek[] => (v as unknown as { ghosts: GhostPeek[] }).ghosts

const art = fakeArt()
const F = TUMBLE.footprint

type Wall = 'E' | 'W' | 'N' | 'S'
const AIM: Record<Wall, [number, number]> = { E: [1, 0], W: [-1, 0], N: [0, -1], S: [0, 1] }

/** walledRoom(20, 10): walls at x 0 and 19, y 0 and 9. A pistol round (14)
 * kills a still mutant (14 of 24 hp: force ~0.5) standing `gap` tiles past
 * its footprint off the wall, the shooter 5 tiles back. */
const slamScene = (wall: Wall, gap = 0.3, max = 24): Scene => {
  const world = worldFromRows(walledRoom(20, 10), { seed: 5 })
  const [ax, ay] = AIM[wall]
  const mx = wall === 'E' ? 19 - F.x - gap : wall === 'W' ? 1 + F.x + gap : 10.5
  const my = wall === 'S' ? 9 - F.y - gap : wall === 'N' ? 1 + F.y + gap : 5.5
  const p = tank(world, mx - 5 * ax, my - 5 * ay)
  arm(p, 'pistol')
  const m: Entity = spawnNpc(world, 'mutant', mx, my)
  m.speed = 0
  m.health!.max = max
  m.health!.hp = 14
  return { w: world, focus: [m], before: () => {}, n: 140, inputs: new Map([[0, { attack: true, aimX: ax, aimY: ay }]]) }
}

/** One drawn tick of a ghost: the sprite's whole transform and the fx. */
interface Drawn {
  tick: number
  x: number
  y: number
  rot: number
  sx: number
  sy: number
  kx: number
  ky: number
  alpha: number
  z: number
  fx: string
}

const drawnOf = (g: GhostPeek, tick: number): Drawn => {
  const s = g.sprite
  const b = g.fx && g.fx.visible ? g.fx.getLocalBounds() : undefined
  return {
    tick,
    x: s.position.x,
    y: s.position.y,
    rot: s.rotation,
    sx: s.scale.x,
    sy: s.scale.y,
    kx: s.skew.x,
    ky: s.skew.y,
    alpha: s.alpha,
    z: s.zIndex,
    fx: b ? `${b.x},${b.y},${b.width},${b.height}` : '-',
  }
}

/** Trace with the tumble and the slam on; every ghost by id, and every drawn tick of the focus ghost. */
const run = (
  scene: Scene,
  opts: TraceOpts = {},
): { frames: Record<number, Frame[]>; ghost: GhostPeek | undefined; drawn: Drawn[]; live: number[]; w: number; h: number } => {
  const id = scene.focus[0].id
  let ghost: GhostPeek | undefined
  const drawn: Drawn[] = []
  const live: number[] = []
  let w = 0
  let h = 0
  const frames = trace(scene, art, {
    tumble: true,
    slam: true,
    ...opts,
    inspect: (v, tick) => {
      const g = ghostsOf(v).find((x) => x.id === id)
      if (g) {
        if (!ghost) ({ width: w, height: h } = g.sprite.texture)
        ghost = g
        drawn.push(drawnOf(g, tick))
      }
      live.push(ghostsOf(v).length)
    },
  })
  return { frames, ghost, drawn, live, w, h }
}

/** The drawn sprite's linear map, rebuilt from its transform the way pixi does. */
const matOf = (d: Drawn): { a: number; b: number; c: number; d: number } => ({
  a: Math.cos(d.rot + d.ky) * d.sx,
  b: Math.sin(d.rot + d.ky) * d.sx,
  c: -Math.sin(d.rot - d.kx) * d.sy,
  d: Math.cos(d.rot - d.kx) * d.sy,
})

/** How far the drawn body reaches from its centre along (nx, ny), px. */
const support = (d: Drawn, w: number, h: number, nx: number, ny: number): number => {
  const m = matOf(d)
  const hw = (w * BODY_FILL.w) / 2
  const hh = (h * BODY_FILL.h) / 2
  return Math.hypot(hw * (nx * m.a + ny * m.b), hh * (nx * m.c + ny * m.d))
}

describe('a pistol kill throws a mutant into each wall', () => {
  for (const wall of ['E', 'W', 'N', 'S'] as const) {
    it(`${wall}: slams on its normal, squashes along it on screen, stays out of the wall, ends at the foot`, () => {
      const scene = slamScene(wall)
      const { ghost, drawn, w, h } = run(scene)
      const g = ghost!
      const sl = g.body!.slam!
      expect(sl, 'slammed').toBeDefined()
      const [nx, ny] = [0 - AIM[wall][0], 0 - AIM[wall][1]]
      expect([sl.nx, sl.ny]).toEqual([nx, ny])
      const hit = g.start + sl.tick
      const at = (t: number): Drawn => drawn.find((d) => d.tick === t)!

      // SLAM: on the impact tick the body is flatter along the normal and
      // wider across it than the same spin unsquashed.
      const d0 = at(hit)
      const plain: Drawn = { ...d0, sx: g.flip ? -1 : 1, sy: 1, kx: 0, ky: 0, rot: poseAt(g.body!, sl.tick).rot }
      expect(support(d0, w, h, nx, ny)).toBeLessThan(0.8 * support(plain, w, h, nx, ny))
      expect(support(d0, w, h, -ny, nx)).toBeGreaterThan(1.1 * support(plain, w, h, -ny, nx))
      // The burst is up on the impact tick and gone after SLAM.burstTicks.
      expect(d0.fx).not.toBe('-')
      expect(at(hit + SLAM.burstTicks + 1).fx).toBe('-')
      // Squash spent: a plain sprite again (no skew, unit scale).
      const after = drawn.filter((d) => d.tick >= hit + SLAM.hold + SLAM.spring)
      expect(after.length).toBeGreaterThan(10)
      for (const d of after) {
        expect(d.kx).toBe(0)
        expect(d.ky).toBe(0)
        expect(Math.abs(d.sx)).toBe(1)
        expect(d.sy).toBe(1)
      }

      // Out of the wall on every drawn tick: side walls and the back of a
      // south wall (a north wall's face is drawn above the floor, so a body
      // pressed to it overlaps it on screen, as a standing one does).
      for (const d of drawn) {
        if (wall === 'E') expect(sl.faceX! * TILE_PX - d.x, `tick ${d.tick}`).toBeGreaterThanOrEqual(support(d, w, h, 1, 0) - 1e-6)
        if (wall === 'W') expect(d.x - sl.faceX! * TILE_PX, `tick ${d.tick}`).toBeGreaterThanOrEqual(support(d, w, h, 1, 0) - 1e-6)
        if (wall === 'S') expect(sl.faceY! * TILE_PX - d.y, `tick ${d.tick}`).toBeGreaterThanOrEqual(support(d, w, h, 0, 1) - 1e-6)
      }
      // At rest at the foot, on its side, against the wall (within half a tile).
      const last = drawn.at(-1)!
      expect(Math.abs(last.rot)).toBeCloseTo(Math.PI / 2, 9)
      const end = poseAt(g.body!, g.body!.settle)
      expect(end.z).toBe(0)
      if (nx !== 0) expect(Math.abs(last.x - sl.faceX! * TILE_PX)).toBeLessThan(TILE_PX)
      else expect(Math.abs(end.y - sl.faceY!)).toBeLessThan(0.5)
      // Never back toward the shooter in the track; on screen, never back
      // past where it died.
      const [ax, ay] = AIM[wall]
      for (const d of drawn) expect((d.x - drawn[0].x) * ax).toBeGreaterThanOrEqual(-1e-9)
      for (let i = 1; i < g.body!.poses.length; i++) {
        const a = g.body!.poses[i - 1]
        const b = g.body!.poses[i]
        expect((b.x - a.x) * ax + (b.y - a.y) * ay).toBeGreaterThanOrEqual(-1e-9)
      }
    })
  }

  it('a body dying flush against the wall slams on the tick it is thrown', () => {
    // 0.04 off the face: well inside its full footprint.
    const { ghost, drawn } = run(slamScene('E', -F.x + 0.04))
    const sl = ghost!.body!.slam!
    expect(sl.tick).toBe(1)
    expect(drawn.find((d) => d.tick === ghost!.start + 1)!.fx).not.toBe('-')
  })

  it('a corner: shot into the south-east corner, two normals, one slam', () => {
    const world = worldFromRows(walledRoom(20, 10), { seed: 5 })
    const s = Math.SQRT1_2
    const mx = 19 - F.x - 0.2
    const my = 9 - F.y - 0.2
    const p = tank(world, mx - 4, my - 4)
    arm(p, 'pistol')
    const m = spawnNpc(world, 'mutant', mx, my)
    m.speed = 0
    // 14 of 16: a hard throw, so each axis of the diagonal is a slam.
    m.health!.max = 16
    m.health!.hp = 14
    const scene: Scene = { w: world, focus: [m], before: () => {}, n: 140, inputs: new Map([[0, { attack: true, aimX: s, aimY: s }]]) }
    const { ghost, live } = run(scene)
    const body = ghost!.body!
    expect(body.slam!.nx).toBeLessThan(0)
    expect(body.slam!.ny).toBeLessThan(0)
    expect(body.contacts.some((c) => c.nx === -1)).toBe(true)
    expect(body.contacts.some((c) => c.ny === -1)).toBe(true)
    expect(live.at(-1)).toBe(0)
  })

  it('a gentle touch (a weak throw sliding into the wall) is the plain tumble, frame for frame', () => {
    let touches = 0
    for (const gap of [0.4, 0.7, 1.0, 1.3]) {
      // 14 of 34 hp: force ~0.26, the weakest throw.
      const on = run(slamScene('E', gap, 34))
      const body = on.ghost?.body
      if (!body || body.contacts.length === 0) continue
      expect(body.slam).toBeUndefined()
      expect(on.ghost!.fx).toBeUndefined()
      touches++
      const id = Object.keys(on.frames)[0]
      const off = trace(slamScene('E', gap, 34), art, { tumble: true })
      expect(on.frames[Number(id)]).toEqual(off[Number(id)])
    }
    expect(touches).toBeGreaterThan(0)
  })

  it('the ghost still expires on time and frees its sprite, its shadow and the burst Graphics', () => {
    const { ghost, drawn, live } = run(slamScene('N'))
    const g = ghost!
    expect(g.fx).toBeDefined()
    expect(drawn.at(-1)!.tick).toBe(g.start + g.body!.settle + TUMBLE.hold + 18 - 1)
    expect(g.sprite.destroyed).toBe(true)
    expect(g.shadow?.destroyed).toBe(true)
    expect(g.fx!.destroyed).toBe(true)
    expect(live.at(-1)).toBe(0)
  })
})

describe('the same slam at the same tick, whatever the frames do', () => {
  const byTick = (ds: Drawn[]): Map<number, string> => new Map(ds.map((d) => [d.tick, JSON.stringify(d)]))
  const compare = (make: () => Scene, opts: TraceOpts): number => {
    const every = byTick(run(make()).drawn)
    const other = byTick(run(make(), opts).drawn)
    expect(other.size).toBeGreaterThan(0)
    for (const [tick, d] of other) expect(d, `tick ${tick}`).toBe(every.get(tick))
    return other.size
  }

  it('1, 3 and 6 ticks a frame agree on every tick, into each wall', () => {
    for (const wall of ['E', 'W', 'N', 'S'] as const) {
      compare(() => slamScene(wall), { stride: 3 })
      compare(() => slamScene(wall), { stride: 6 })
    }
  })

  it('a hitstop freeze across the slam neither skips it nor plays it twice', () => {
    const probe = run(slamScene('E'))
    const hit = probe.ghost!.start + probe.ghost!.body!.slam!.tick
    const n = compare(() => slamScene('E'), { frozen: (t) => t >= hit - 2 && t < hit + 3 })
    expect(n).toBeGreaterThan(30)
  })
})

// Slam ON golden: the four wall kills drawn with the slam on, as sha256
// digests of 50-tick windows. Regenerate deliberately, when the slam's look is
// meant to change:
//   WALL_SLAM_GOLDEN=1 pnpm exec vitest run src/render/wallSlam.views.test.ts
const SLAM_GOLDEN = join(process.cwd(), 'src', 'render', '__fixtures__', 'wall-slam-on-trace.json')
const ON_GOLDEN = join(process.cwd(), 'src', 'render', '__fixtures__', 'death-tumble-on-trace.json')

const digest = (fs: unknown[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < fs.length; i += 50) {
    const w = fs.slice(i, i + 50)
    out.push(`${(w[0] as { tick: number }).tick}:${createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16)}`)
  }
  return out
}

describe('the slam, pinned', () => {
  it('slam off is the tumble as recorded before the slam (the death-tumble ON golden)', () => {
    const golden = JSON.parse(readFileSync(ON_GOLDEN, 'utf8')) as { brawl: string[][] }
    expect(Object.values(trace(brawlScene(), art, { tumble: true, slam: false })).map(digest)).toEqual(golden.brawl)
  })

  it('the four wall kills with the slam on render exactly as recorded', () => {
    const now = Object.fromEntries((['E', 'W', 'N', 'S'] as const).map((wall) => [wall, digest(run(slamScene(wall)).drawn)]))
    if (process.env.WALL_SLAM_GOLDEN) writeFileSync(SLAM_GOLDEN, JSON.stringify(now, null, 1) + '\n')
    expect(existsSync(SLAM_GOLDEN)).toBe(true)
    expect(now).toEqual(JSON.parse(readFileSync(SLAM_GOLDEN, 'utf8')))
  })
})
