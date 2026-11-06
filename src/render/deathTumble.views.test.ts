// The death tumble at the entity layer the game draws with: EntityViews over a
// real art registry, the real sim underneath (animTestkit.ts), real kills (a
// pistol round, a wrench, a rocket). The tests read the death ghost back tick
// by tick: where it is, how it turns, when it goes, and that a different frame
// cadence or a hitstop shows the same body at the same tick.
//
// Off (the default for the testkit and actionAnims' golden) is today's topple;
// the golden in actionAnims.views.test.ts pins that byte for byte.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Graphics, Sprite } from 'pixi.js'
import type { Entity } from '../game/entity'
import { spawnNpc } from '../game/populate'
import { spawnProjectile } from '../game/systems/combat'
import { spawnHive } from '../game/systems/groups'
import { spawnObject } from '../game/systems/objects'
import { arm, walledRoom, worldFromRows } from '../game/testkit'
import { brawlScene, fakeArt, tank, trace, type Frame, type Scene, type TraceOpts } from './animTestkit'
import { TILE_PX } from './art'
import { TUMBLE, type BodyTrack } from './displayBody'
import type { EntityViews } from './sprites'

interface GhostPeek {
  id: number
  start: number
  sprite: Sprite
  body?: BodyTrack
  shadow?: Graphics
}
const ghostsOf = (v: EntityViews): GhostPeek[] => (v as unknown as { ghosts: GhostPeek[] }).ghosts

const art = fakeArt()

/** Trace with the tumble on, and every ghost each update kept by id. */
const run = (
  scene: Scene,
  opts: TraceOpts = {},
): { frames: Record<number, Frame[]>; ghosts: Map<number, GhostPeek>; live: number[] } => {
  const ghosts = new Map<number, GhostPeek>()
  const live: number[] = []
  const frames = trace(scene, art, {
    tumble: true,
    ...opts,
    inspect: (v) => {
      for (const g of ghostsOf(v)) ghosts.set(g.id, g)
      live.push(ghostsOf(v).length)
    },
  })
  return { frames, ghosts, live }
}

const ghostFrames = (fs: Frame[]): Frame[] => fs.filter((f) => f.ghost)

const mutant = (s: Scene['w'], x: number, y: number, hp: number, max = 90): Entity => {
  const m = spawnNpc(s, 'mutant', x, y)
  m.speed = 0
  m.health!.max = max
  m.health!.hp = hp
  return m
}

/** A pistol round from the west kills a still mutant in one shot. `max` 24:
 * the round is 14/24 of it, over the throw threshold; at 40 (a real mutant)
 * it is a plink. */
const pistolScene = (mx = 9.5, max = 24): Scene => {
  const world = worldFromRows(walledRoom(20, 10), { seed: 5 })
  const p = tank(world, mx - 5, 5.5)
  arm(p, 'pistol')
  const m = mutant(world, mx, 5.5, 14, max)
  return { w: world, focus: [m], before: () => {}, n: 140, inputs: new Map([[0, { attack: true, aimX: 1, aimY: 0 }]]) }
}

/** A wrench from the west, point blank: the first swing wounds, the second kills. */
const wrenchScene = (): Scene => {
  const world = worldFromRows(walledRoom(20, 10), { seed: 5 })
  const p = tank(world, 6.5, 5.5)
  arm(p, 'wrench')
  const m = mutant(world, 7.6, 5.5, 30, 30)
  return { w: world, focus: [m], before: () => {}, n: 140, inputs: new Map([[0, { attack: true, aimX: 1, aimY: 0 }]]) }
}

/** A rocket from the west bursts in a ring of three mutants, plus a hive spire
 * and a barrel inside the blast. */
const rocketScene = (): { scene: Scene; ring: Entity[]; spire: Entity; barrel: Entity } => {
  const world = worldFromRows(walledRoom(30, 16), { seed: 9 })
  const p = tank(world, 4.5, 8.5)
  p.speed = 0
  const ring = [mutant(world, 12.5, 8.5, 20), mutant(world, 13.5, 7.2, 20), mutant(world, 13.5, 9.8, 20)]
  const spire = spawnHive(world, 14.5, 8.5)
  spire.health!.hp = 5
  const barrel = spawnObject(world, 'barrel', 13.2, 10.9)
  return {
    scene: {
      w: world,
      focus: [...ring, spire, barrel],
      before: (i) => {
        if (i !== 3) return
        p.facing = 0
        spawnProjectile(world, p, 5, 14, 20, 0, undefined, { explodeRadius: 2.2, explodeDamage: 60 })
      },
      n: 160,
    },
    ring,
    spire,
    barrel,
  }
}

describe('a kill throws the body', () => {
  it('a pistol round from the west: thrown east along the round, a hop, onto its side, then it fades and frees its sprite', () => {
    const scene = pistolScene()
    const m = scene.focus[0]
    const { frames, ghosts, live } = run(scene)
    const g = ghosts.get(m.id)!
    expect(g.body?.throw.source).toBe('projectile')
    expect(g.body!.throw.dirX).toBeCloseTo(1, 9)
    const fs = ghostFrames(frames[m.id])
    expect(fs.length).toBeGreaterThan(30)
    // Thrown east: the last ghost frame sits right of the first, a tile or so.
    const dx = (fs.at(-1)!.x - fs[0].x) / TILE_PX
    expect(dx).toBeGreaterThan(0.5)
    expect(dx).toBeLessThan(2.5)
    // Off the floor at some point (the hop), and spinning clockwise.
    expect(Math.max(...g.body!.poses.map((p) => p.z)) * TILE_PX).toBeGreaterThan(3)
    expect(fs.at(-1)!.rot).toBeCloseTo(Math.PI / 2, 9)
    expect(Math.max(...fs.map((f) => f.rot))).toBeLessThanOrEqual(Math.PI / 2 + TUMBLE.rock)
    // Lies still, then fades out over the last stretch, alpha falling.
    const alphas = fs.map((f) => f.alpha)
    expect(alphas[0]).toBe(1)
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1])
    // Lifetime: settle + hold + the fade, from the death tick.
    expect(fs.at(-1)!.tick).toBe(g.start + g.body!.settle + TUMBLE.hold + 18 - 1)
    expect(g.sprite.destroyed).toBe(true)
    expect(g.shadow?.destroyed).toBe(true)
    expect(live.at(-1)).toBe(0)
  })

  it('a pistol plink (14 of a 40-hp mutant, under the threshold) is today\'s topple, frame for frame', () => {
    const on = run(pistolScene(9.5, 40))
    const m = Object.keys(on.frames)[0]
    expect(on.ghosts.get(Number(m))?.body).toBeUndefined()
    expect(on.ghosts.get(Number(m))?.shadow).toBeUndefined()
    const off = trace(pistolScene(9.5, 40), art, { tumble: false })
    const fs = on.frames[Number(m)]
    expect(ghostFrames(fs).length).toBeGreaterThan(0)
    expect(fs).toEqual(off[Number(m)])
  })

  it('the shadow stays on the floor under the flying body and is gone once it lies still', () => {
    const scene = pistolScene()
    const m = scene.focus[0]
    const seen: { tick: number; y: number; alpha: number; bodyY: number }[] = []
    trace(scene, art, {
      tumble: true,
      inspect: (v, tick) => {
        const g = ghostsOf(v).find((x) => x.id === m.id)
        if (g?.shadow) seen.push({ tick, y: g.shadow.position.y, alpha: g.shadow.alpha, bodyY: g.sprite.position.y })
      },
    })
    const inFlight = seen.filter((s) => s.alpha > 0)
    expect(inFlight.length).toBeGreaterThan(5)
    // The body rises off the floor, the shadow does not (it moves only with the ground point).
    const drift = Math.max(...inFlight.map((s) => s.y)) - Math.min(...inFlight.map((s) => s.y))
    const lift = Math.max(...inFlight.map((s) => s.y - s.bodyY)) - Math.min(...inFlight.map((s) => s.y - s.bodyY))
    expect(drift).toBeLessThan(1e-9) // thrown east: the ground point stays on one row
    expect(lift).toBeGreaterThan(8)
    expect(seen.at(-1)!.alpha).toBe(0)
  })

  it('a wrench (no blast, no round): thrown away from the swinger', () => {
    const scene = wrenchScene()
    const m = scene.focus[0]
    const { frames, ghosts } = run(scene)
    const g = ghosts.get(m.id)!
    expect(g.body?.throw.source).toBe('hostile')
    expect(g.body!.throw.dirX).toBeCloseTo(1, 9)
    const fs = ghostFrames(frames[m.id])
    expect(fs.at(-1)!.x).toBeGreaterThan(fs[0].x)
  })

  it('a rocket: three deaths on one tick, each thrown away from the blast; the spire and the barrel do not fly', () => {
    const { scene, ring, spire, barrel } = rocketScene()
    const { frames, ghosts } = run(scene)
    const bodies = ring.map((m) => ghosts.get(m.id)!)
    expect(new Set(bodies.map((g) => g.start)).size).toBe(1) // one tick
    for (const g of bodies) expect(g.body?.throw.source).toBe('explosion')
    // Front one east-ish, the flankers up and down.
    const [front, top, bottom] = bodies.map((g) => g.body!.throw)
    expect(front.dirX).toBeGreaterThan(0.5)
    expect(top.dirY).toBeLessThan(-0.3)
    expect(bottom.dirY).toBeGreaterThan(0.3)
    for (const g of bodies) {
      const fs = ghostFrames(frames[ring[bodies.indexOf(g)].id])
      expect(fs.length).toBeGreaterThan(0)
    }
    // The spire died in the blast but keeps the old in-place topple; the
    // barrel is a prop and leaves no ghost at all.
    expect(spire.dead || !scene.w.byId.has(spire.id)).toBe(true)
    const sg = ghosts.get(spire.id)
    expect(sg).toBeDefined()
    expect(sg!.body).toBeUndefined()
    const sf = ghostFrames(frames[spire.id])
    expect(new Set(sf.map((f) => `${f.x},${f.y}`)).size).toBe(1)
    expect(ghosts.has(barrel.id)).toBe(false)
  })

  it('flush against a wall and shot into it: never into the wall, the touch on record', () => {
    // walledRoom(20): x = 19 is wall. It died at 18.6, inside its full footprint.
    const scene = pistolScene(18.6)
    const m = scene.focus[0]
    const { ghosts } = run(scene)
    const body = ghosts.get(m.id)!.body!
    expect(body.contacts.length).toBeGreaterThan(0)
    expect(body.contacts[0].nx).toBe(-1)
    expect(body.throw.x + TUMBLE.footprint.x).toBeGreaterThan(19) // flush: inside its full footprint
    // Never nearer the wall than a living body of its size could stand, and
    // never knocked back off it toward the shooter.
    for (const p of body.poses) {
      expect(p.x + m.radius).toBeLessThan(19)
      expect(p.x).toBeGreaterThanOrEqual(body.throw.x)
    }
  })

  it('a body that dies the tick after it is first seen still tumbles; one never seen leaves no ghost', () => {
    const at = (gap: number): Scene => {
      const world = worldFromRows(walledRoom(20, 10), { seed: 5 })
      const p = tank(world, 4.5, 5.5)
      p.speed = 0
      const m = mutant(world, 2.5, 2.5, 1) // moved into place at i = 10
      return {
        w: world,
        focus: [m],
        before: (i) => {
          if (i !== 10) return
          m.pos = { x: 4.5 + gap, y: 5.5 }
          m.prevPos = { ...m.pos }
          p.facing = 0
          spawnProjectile(world, p, 5, 14, 20, 0, undefined, { explodeRadius: 1.5, explodeDamage: 30 })
        },
        n: 80,
      }
    }
    // gap 1.2: the round needs two ticks, so one frame shows the mutant in place.
    const seen = at(1.2)
    const s = run(seen, {})
    const fs = s.frames[seen.focus[0].id]
    const firstGhost = fs.findIndex((f) => f.ghost)
    expect(firstGhost).toBeGreaterThan(0)
    expect(s.ghosts.get(seen.focus[0].id)!.body?.throw.source).toBe('explosion')
  })

  it('no death event (a client whose events trail its snapshots): it still falls, from where it was last seen', () => {
    const scene = pistolScene()
    const m = scene.focus[0]
    const { ghosts, frames } = run(scene, { events: 'none' })
    const g = ghosts.get(m.id)!
    expect(g.body).toBeDefined()
    expect(g.body!.throw.source).not.toBe('explosion')
    expect(ghostFrames(frames[m.id]).length).toBeGreaterThan(0)
  })
})

describe('the same body at the same tick, whatever the frames do', () => {
  const pick = (f: Frame): string => `${f.tex}|${f.x}|${f.y}|${f.rot}|${f.sx}|${f.sy}|${f.alpha}`
  const byTick = (fs: Frame[]): Map<number, string> => new Map(ghostFrames(fs).map((f) => [f.tick, pick(f)]))

  const compare = (make: () => Scene, opts: TraceOpts): number => {
    const a = make()
    const b = make()
    const every = byTick(run(a).frames[a.focus[0].id])
    const other = byTick(run(b, opts).frames[b.focus[0].id])
    expect(other.size).toBeGreaterThan(0)
    for (const [tick, pose] of other) expect(pose, `tick ${tick}`).toBe(every.get(tick))
    return other.size
  }

  // 6 is the most ticks one frame may run and still count as the same scene
  // (animState.MAX_TICK_SKIP); past it every ghost is dropped as a scene cut.
  it('pistol kill: every tick vs 3 and 6 ticks a frame', () => {
    compare(() => pistolScene(), { stride: 3 })
    compare(() => pistolScene(), { stride: 6 })
  })

  it('rocket kill: every tick vs 6 ticks a frame', () => {
    compare(() => rocketScene().scene, { stride: 6 })
  })

  it('a hitstop freeze across the death neither jumps the body ahead nor steps it twice', () => {
    // Freeze the entity layer for 5 ticks around the kill (a 6-tick gap).
    const probe = pistolScene()
    const death = [...run(probe).ghosts.values()][0].start
    const n = compare(() => pistolScene(), { frozen: (t) => t >= death - 2 && t < death + 3 })
    expect(n).toBeGreaterThan(30)
  })

  it('wrench kill: every tick vs 5 ticks a frame (the swinger seen at different moments)', () => {
    compare(wrenchScene, { stride: 5 })
  })
})

// ON golden: the brawl's death ghost with the tumble on, per-tick, as sha256
// digests of 50-tick windows. Regenerate deliberately, when the tumble's look
// is meant to change:
//   DEATH_TUMBLE_GOLDEN=1 pnpm exec vitest run src/render/deathTumble.views.test.ts
// ship/integrate-1106 regenerated it once for weapon v2 (the fake pack has no
// weapon art, so no held weapon is drawn) and the aim trace field: with the
// weapon and aiming fields dropped, every frame matches the tumble branch's.
const ON_GOLDEN = join(process.cwd(), 'src', 'render', '__fixtures__', 'death-tumble-on-trace.json')

describe('the tumble, pinned', () => {
  it('the brawl and the rocket with the tumble on render exactly as recorded', () => {
    const digest = (fs: Frame[]): string[] => {
      const out: string[] = []
      for (let i = 0; i < fs.length; i += 50) {
        const w = fs.slice(i, i + 50)
        out.push(`${w[0].tick}:${createHash('sha256').update(JSON.stringify(w)).digest('hex').slice(0, 16)}`)
      }
      return out
    }
    const now = {
      brawl: Object.values(trace(brawlScene(), art, { tumble: true })).map(digest),
      rocket: Object.values(run(rocketScene().scene).frames).map(digest),
    }
    if (process.env.DEATH_TUMBLE_GOLDEN) writeFileSync(ON_GOLDEN, JSON.stringify(now, null, 1) + '\n')
    expect(existsSync(ON_GOLDEN)).toBe(true)
    expect(now).toEqual(JSON.parse(readFileSync(ON_GOLDEN, 'utf8')))
  })
})
