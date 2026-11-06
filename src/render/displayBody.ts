/**
 * The death tumble: a hard kill THROWS the body. A hop, two bounces, a roll, a
 * slide, then it settles a tile or two back and the ghost fades (sprites.ts).
 *
 * Display only. The sim swept the corpse on its death tick and never hears of
 * this; nothing here reaches the wire or a snapshot.
 *
 * Two pure halves, no pixi:
 *
 * - `deriveThrow` reads which way and how hard from what the renderer already
 *   sees. The death and hit events carry the TARGET's position only, so the
 *   direction comes from, in order: an explosion that tick (away from its
 *   centre), a projectile the renderer saw heading at the body (its velocity),
 *   the nearest hostile (away from it), the body's last velocity, and last
 *   "backwards from where it faced". Force is the killing tick's damage over
 *   max hp.
 * - `simulateBody` integrates the throw once, at whole sim ticks, into a track;
 *   `poseAt` reads the track at tick + interpolation fraction. A phone that draws
 *   at 60 fps and one that drops to 8 ticks a frame read the same track at the
 *   same ticks, so they show the same pose at the same tick.
 *
 * Two phones agree because every input that matters is in the events, which
 * are reliable on both: the seed is hash(entityId, death position), not the
 * death tick, because a client's tick counter is its own and not the host's.
 *
 * Walls: the body never enters a solid tile. Each wall touch is a `WallContact`
 * on the track, and `onWall` decides the rebound; the default is a dull bounce.
 * The wall slam (comic C) plugs in there.
 */

import { SIM_RATE } from '../game/types'

/** THE switch. Off = the ghost topples in place exactly as before. */
export const DEATH_TUMBLE = true

/** Tunables. Distances in tiles, time in sim ticks, angles in radians. */
export const TUMBLE = {
  /** Ground speed of the throw, tiles/tick, from force 0 to force 1. */
  speed: { min: 0.02, max: 0.075 },
  /** Launch height speed, tiles/tick, from force 0 to force 1. */
  lift: { min: 0.05, max: 0.15 },
  /** Fake gravity on the height z, tiles/tick². */
  gravity: 0.018,
  /** Vertical speed kept on a floor bounce, and how many bounces there are. */
  bounce: 0.4,
  bounces: 2,
  /** Ground speed kept each time the body lands. */
  landKeep: 0.7,
  /** Sliding friction, tiles/tick². */
  friction: 0.004,
  /** Ticks of roll after the last landing before it lies still on its side. */
  rollTicks: 6,
  /** Ground speed kept along a wall's normal after a touch (default onWall). */
  wallKeep: 0.35,
  /** Ground speed kept along the wall on a touch. */
  wallSlide: 0.8,
  /** Half-size of the body's footprint against walls. */
  radius: 0.3,
  /** Never simulate past this many ticks. */
  maxTicks: 90,
  /** Force above which the body turns a full somersault before landing on its side. */
  flipForce: 0.55,
  /** Ticks the settled body lies still before the fade starts. */
  hold: 12,
  /** Directions are snapped to 1/sectors of a turn, so a small difference in
   * where the renderer last saw an attacker does not move the throw. */
  sectors: 32,
} as const

export interface Vec {
  x: number
  y: number
}

/** A solid-tile test in whole tile coordinates (out of bounds is solid). */
export type IsSolid = (tx: number, ty: number) => boolean

export type ThrowSource = 'explosion' | 'projectile' | 'hostile' | 'velocity' | 'facing'

export interface Throw {
  /** Death position, tiles. */
  x: number
  y: number
  /** Unit ground direction the body is thrown. */
  dirX: number
  dirY: number
  /** 0..1. */
  force: number
  /** Per-body variation, the same on every phone. */
  seed: number
  source: ThrowSource
}

/** Everything `deriveThrow` reads. Positions in tiles, velocities in tiles/s. */
export interface DeathFacts {
  id: number
  x: number
  y: number
  /** Heading the body last faced. */
  facing: number
  /** Last observed velocity (tiles/s), when the body was seen. */
  vel?: Vec
  maxHp: number
  /** Damage the body took on its death tick (all hits summed: pellets). */
  killDamage: number
  /** Explosions on the death tick. */
  explosions: readonly { x: number; y: number; radius: number }[]
  /** Projectiles the renderer saw, each at its latest sighting. `ticksBefore`
   * is how many ticks before the death that sighting was. */
  projectiles: readonly { x: number; y: number; vx: number; vy: number; ticksBefore: number; ownerId: number }[]
  /** Bodies that were trying to kill this one, where last seen. */
  hostiles: readonly Vec[]
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** 32-bit integer hash (murmur3 finaliser) of a few integers. */
const hash = (...xs: number[]): number => {
  let h = 0x9e3779b9
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return h >>> 0
}

/** The body's seed: identical on host and client, distinct per body. */
export const bodySeed = (id: number, x: number, y: number): number => hash(id, Math.round(x * 64), Math.round(y * 64))

/** A deterministic 0..1 from the seed and a salt. */
const unit = (seed: number, salt: number): number => hash(seed, salt) / 0x100000000

/** Snap a direction to the nearest sector; a zero vector stays undefined. */
const snapDir = (x: number, y: number): Vec | undefined => {
  const len = Math.hypot(x, y)
  if (len < 1e-6) return undefined
  const step = (Math.PI * 2) / TUMBLE.sectors
  const a = Math.round(Math.atan2(y, x) / step) * step
  return { x: Math.cos(a), y: Math.sin(a) }
}

/** How far the projectile's line passes from the body, if it was heading at it
 * and could have reached it by the death tick. */
const projectileMiss = (p: DeathFacts['projectiles'][number], x: number, y: number): number | undefined => {
  const speed = Math.hypot(p.vx, p.vy)
  if (speed < 1e-6) return undefined
  const ux = p.vx / speed
  const uy = p.vy / speed
  const along = (x - p.x) * ux + (y - p.y) * uy
  if (along < -0.5) return undefined // flying away from the body
  const reach = (speed * (p.ticksBefore + 1)) / SIM_RATE + 0.75
  if (along > reach) return undefined // could not have got there in time
  return Math.abs((x - p.x) * uy - (y - p.y) * ux)
}

/** Which way and how hard the kill throws the body. */
export const deriveThrow = (f: DeathFacts): Throw => {
  const seed = bodySeed(f.id, f.x, f.y)
  let force = f.maxHp > 0 ? clamp01(0.1 + 0.9 * (f.killDamage / f.maxHp)) : 0.1
  let dir: Vec | undefined
  let source: ThrowSource = 'facing'

  // 1. A blast this tick: away from its centre, harder the closer it was.
  let nearest = Infinity
  for (const ex of f.explosions) {
    const d = Math.hypot(f.x - ex.x, f.y - ex.y)
    if (d > ex.radius + 1 || d >= nearest) continue
    nearest = d
    const away = snapDir(f.x - ex.x, f.y - ex.y)
    if (away) dir = away
    force = Math.max(force, 0.6 + 0.4 * clamp01(1 - d / Math.max(ex.radius, 0.1)))
    source = 'explosion'
  }

  // 2. A round seen flying at the body: along its flight.
  if (!dir) {
    let best: { miss: number; ticks: number; v: Vec } | undefined
    for (const p of f.projectiles) {
      if (p.ownerId === f.id) continue
      const miss = projectileMiss(p, f.x, f.y)
      if (miss === undefined || miss > 0.75) continue
      if (!best || p.ticksBefore < best.ticks || (p.ticksBefore === best.ticks && miss < best.miss)) {
        best = { miss, ticks: p.ticksBefore, v: { x: p.vx, y: p.vy } }
      }
    }
    if (best) {
      dir = snapDir(best.v.x, best.v.y)
      source = 'projectile'
    }
  }

  // 3. The nearest hostile: away from it.
  if (!dir) {
    let bestD = Infinity
    for (const h of f.hostiles) {
      const d = Math.hypot(f.x - h.x, f.y - h.y)
      if (d < bestD && d > 1e-6) {
        bestD = d
        dir = snapDir(f.x - h.x, f.y - h.y)
      }
    }
    if (dir) source = 'hostile'
  }

  // 4. Its own momentum.
  if (!dir && f.vel && Math.hypot(f.vel.x, f.vel.y) > 0.5) {
    dir = snapDir(f.vel.x, f.vel.y)
    source = 'velocity'
  }

  // 5. Backwards from where it faced.
  dir ??= snapDir(-Math.cos(f.facing), -Math.sin(f.facing)) ?? { x: -1, y: 0 }

  return { x: f.x, y: f.y, dirX: dir.x, dirY: dir.y, force, seed, source }
}

/** A wall touch. `nx, ny` is the wall's normal (pointing back into the room);
 * `speed` is how fast the body was moving into the wall, tiles/tick. */
export interface WallContact {
  tick: number
  x: number
  y: number
  z: number
  nx: number
  ny: number
  speed: number
}

/** The rebound a wall gives: the new ground velocity, tiles/tick. */
export type OnWall = (c: WallContact, v: Vec) => Vec

/** The default rebound: a dull bounce off the wall, slowed along it. */
export const bounceOffWall: OnWall = (c, v) => {
  const into = v.x * c.nx + v.y * c.ny // negative: moving into the wall
  const tx = v.x - into * c.nx
  const ty = v.y - into * c.ny
  return { x: tx * TUMBLE.wallSlide - into * c.nx * TUMBLE.wallKeep, y: ty * TUMBLE.wallSlide - into * c.ny * TUMBLE.wallKeep }
}

/** The body at one moment. `z` is height off the floor in tiles; `rot` is the
 * body's spin (0 upright, ±π/2 lying on its side). */
export interface BodyPose {
  x: number
  y: number
  z: number
  rot: number
}

export interface BodyTrack {
  readonly throw: Throw
  /** Pose at each whole tick since the death, 0 .. settle. */
  readonly poses: readonly BodyPose[]
  /** Tick (since the death) the body came to rest. */
  readonly settle: number
  readonly contacts: readonly WallContact[]
}

/** Is a square footprint of half-size r at (x, y) touching a solid tile? */
const blocked = (solid: IsSolid, x: number, y: number, r: number): boolean => {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) if (solid(tx, ty)) return true
  }
  return false
}

/** Integrate the throw at whole ticks until the body lies still. */
export const simulateBody = (th: Throw, solid: IsSolid, onWall: OnWall = bounceOffWall): BodyTrack => {
  const jitter = (salt: number): number => 0.9 + 0.2 * unit(th.seed, salt)
  const speed = lerp(TUMBLE.speed.min, TUMBLE.speed.max, th.force) * jitter(1)
  let vx = th.dirX * speed
  let vy = th.dirY * speed
  let vz = lerp(TUMBLE.lift.min, TUMBLE.lift.max, th.force) * jitter(2)
  let x = th.x
  let y = th.y
  let z = 0
  // A footprint that already overlaps a wall (a body dying flush in a corner)
  // shrinks to its centre point, which the sim keeps on open floor. A centre
  // inside a wall does not move at all.
  let r: number = TUMBLE.radius
  if (blocked(solid, x, y, r)) r = 0
  if (blocked(solid, x, y, 0)) vx = vy = 0

  // Spin with the throw: thrown right turns clockwise. Straight up or down,
  // the seed picks.
  const side = th.dirX > 0.2 ? 1 : th.dirX < -0.2 ? -1 : unit(th.seed, 3) < 0.5 ? -1 : 1
  const finalRot = side * (Math.PI / 2 + (th.force > TUMBLE.flipForce ? Math.PI * 2 : 0))

  const poses: BodyPose[] = [{ x, y, z, rot: 0 }]
  const contacts: WallContact[] = []
  let bounces = 0
  let grounded = false
  let rollEnd = Infinity
  const rest = TUMBLE.bounce * jitter(4)

  const step = (k: number, axis: 'x' | 'y'): void => {
    const v = axis === 'x' ? vx : vy
    if (v === 0) return
    const nx = axis === 'x' ? x + v : x
    const ny = axis === 'y' ? y + v : y
    if (!blocked(solid, nx, ny, r)) {
      x = nx
      y = ny
      return
    }
    const c: WallContact = {
      tick: k,
      x,
      y,
      z,
      nx: axis === 'x' ? -Math.sign(v) : 0,
      ny: axis === 'y' ? -Math.sign(v) : 0,
      speed: Math.abs(v),
    }
    contacts.push(c)
    const out = onWall(c, { x: vx, y: vy })
    vx = out.x
    vy = out.y
  }

  let k = 0
  while (k < TUMBLE.maxTicks) {
    k++
    step(k, 'x')
    step(k, 'y')
    if (!grounded) {
      z += vz
      vz -= TUMBLE.gravity
      if (z <= 0) {
        z = 0
        vx *= TUMBLE.landKeep
        vy *= TUMBLE.landKeep
        if (bounces < TUMBLE.bounces && -vz * rest > TUMBLE.gravity) {
          bounces++
          vz = -vz * rest
        } else {
          grounded = true
          vz = 0
          rollEnd = k + TUMBLE.rollTicks
        }
      }
    } else {
      const s = Math.hypot(vx, vy)
      const s2 = Math.max(0, s - TUMBLE.friction)
      vx = s > 0 ? (vx / s) * s2 : 0
      vy = s > 0 ? (vy / s) * s2 : 0
    }
    poses.push({ x, y, z, rot: 0 })
    if (grounded && k >= rollEnd && vx === 0 && vy === 0) break
  }
  // The spin runs from the death to the end of the roll, fast in the air and
  // easing into the lie; the slide after it keeps the body on its side.
  const spinEnd = Math.min(rollEnd, poses.length - 1)
  for (let i = 1; i < poses.length; i++) {
    const p = Math.min(1, i / spinEnd)
    poses[i].rot = finalRot * (1 - (1 - p) * (1 - p))
  }
  return { throw: th, poses, settle: poses.length - 1, contacts }
}

/** The body `ticks` after its death (fractional: tick + interpolation). */
export const poseAt = (track: BodyTrack, ticks: number): BodyPose => {
  const { poses } = track
  if (!(ticks > 0)) return poses[0]
  if (ticks >= poses.length - 1) return poses[poses.length - 1]
  const i = Math.floor(ticks)
  const f = ticks - i
  const a = poses[i]
  const b = poses[i + 1]
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), rot: lerp(a.rot, b.rot, f) }
}

/** How far the sprite's centre sits above the floor point at a spin: half the
 * body's height standing, half its thickness lying. In character pixels. */
export const restLift = (rot: number, charPx: number): number =>
  Math.abs(Math.cos(rot)) * (charPx / 2) + Math.abs(Math.sin(rot)) * (charPx / 6)
