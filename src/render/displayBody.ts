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
 * on the track, and `onWall` decides the rebound; the default stops it dead.
 *
 * The wall slam (#173, comic C): with `slam` on, a touch faster than
 * SLAM.minSpeed is a `Slam` on the track instead. From its tick the body is
 * scripted, not integrated: SLAM, pressed flat to the wall face where it hit;
 * CRUMPLE, it springs back from flat and tips onto its side; SLUMP, it slides
 * down the face to the wall's foot and lies there. The squash is `slamAt`, a
 * closed form of the track and the tick, so it is cadence-free like the rest.
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
  /** How far the body rocks past its side as it rolls to a stop. */
  rock: 0.22,
  /** Ground speed kept ALONG a wall on a touch (default onWall). The speed
   * into it is lost: a body that bounced back off a wall would read as the
   * shot having come from the wall. */
  wallSlide: 0.3,
  /** Half-size of the body's footprint against walls. Wider than tall: a
   * body lying on its side is long across the screen, and its head and feet
   * must not lie over a side wall. Shrinks to fit where the body died. */
  footprint: { x: 0.55, y: 0.3 },
  /** Never simulate past this many ticks. */
  maxTicks: 90,
  /** Below this share of its max hp dealt on the death tick, a kill is a
   * plink and the body topples in place exactly as before: a pistol round
   * (14) into a mutant (40 hp) is 0.35 and topples; the same round into a
   * sporeling (22) is 0.64 and throws it; a wrench (16) into a mutant is
   * exactly 0.4; a machine-gun round (8) never throws a mutant; a
   * sledgehammer (26) always does. Blasts always throw. */
  threshold: 0.4,
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
  projectiles: readonly {
    x: number
    y: number
    vx: number
    vy: number
    ticksBefore: number
    ownerId: number
    /** The round's damage, where the view carries it. */
    damage?: number
  }[]
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

/** How far the projectile's line passes from the body (`miss`), and how many
 * ticks after its sighting it got there (`eta`), if it was heading at the body
 * and could have reached it by the death tick. */
const projectileLine = (p: DeathFacts['projectiles'][number], x: number, y: number): { miss: number; eta: number } | undefined => {
  const speed = Math.hypot(p.vx, p.vy)
  if (speed < 1e-6) return undefined
  const ux = p.vx / speed
  const uy = p.vy / speed
  const along = (x - p.x) * ux + (y - p.y) * uy
  if (along < -0.5) return undefined // flying away from the body
  const reach = (speed * (p.ticksBefore + 1)) / SIM_RATE + 0.75
  if (along > reach) return undefined // could not have got there in time
  return { miss: Math.abs((x - p.x) * uy - (y - p.y) * ux), eta: (Math.max(0, along) / speed) * SIM_RATE }
}

/** Force from the killing blow's share of max hp, or undefined below the
 * threshold (a plink: the old topple). */
const forceOf = (blow: number, maxHp: number): number | undefined => {
  const share = maxHp > 0 ? blow / maxHp : 0
  if (share < TUMBLE.threshold) return undefined
  return clamp01(0.25 + (0.75 * (share - TUMBLE.threshold)) / (1 - TUMBLE.threshold))
}

/** Which way and how hard the kill throws the body; undefined when the blow
 * was too light to throw it (TUMBLE.threshold), and it topples as before. */
export const deriveThrow = (f: DeathFacts): Throw | undefined => {
  const seed = bodySeed(f.id, f.x, f.y)
  // The blow: the hits the death tick logged, or, when more, the volley seen
  // arriving that tick. A body's i-frames void every pellet of a shotgun
  // blast but the first, so its hit events alone undersell the blast.
  let volley = 0
  for (const p of f.projectiles) {
    const line = p.ownerId === f.id ? undefined : projectileLine(p, f.x, f.y)
    if (line && line.miss <= 0.75 && Math.abs(line.eta - p.ticksBefore) <= 1.5) volley += p.damage ?? 0
  }
  let force = forceOf(Math.max(f.killDamage, volley), f.maxHp)
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
    force = Math.max(force ?? 0, 0.6 + 0.4 * clamp01(1 - d / Math.max(ex.radius, 0.1)))
    source = 'explosion'
  }

  if (force === undefined) return undefined

  // 2. A round seen flying at the body: along its flight.
  if (!dir) {
    let best: { miss: number; ticks: number; v: Vec } | undefined
    for (const p of f.projectiles) {
      if (p.ownerId === f.id) continue
      const miss = projectileLine(p, f.x, f.y)?.miss
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

/** The default: the wall takes the speed into it, the body keeps a little
 * slide along it and drops to the wall's foot. (The slam squash, #173, plugs
 * in here.) */
export const stopAtWall: OnWall = (c, v) => {
  const into = v.x * c.nx + v.y * c.ny
  return { x: (v.x - into * c.nx) * TUMBLE.wallSlide, y: (v.y - into * c.ny) * TUMBLE.wallSlide }
}

/** THE slam switch. Off = a body thrown into a wall stops at it exactly as
 * the plain tumble does. */
export const WALL_SLAM = true

/** Slam tunables. Speeds in tiles/tick, time in ticks since the contact. */
export const SLAM = {
  /** A touch slower than this into the wall is a touch: it just stops. The
   * first hop of a force-0.25 throw is about this; a body sliding on the
   * floor after its last landing never reaches it. */
  minSpeed: 0.035,
  /** Impact speed of the hardest throw: the squash is full here. */
  maxSpeed: 0.08,
  /** Share of its depth along the normal the body loses, at minSpeed .. maxSpeed. */
  squash: { min: 0.3, max: 0.5 },
  /** Share of the squash it spreads by across the normal. */
  spread: 0.6,
  /** SLAM: ticks it stays pressed flat where it hit. */
  hold: 3,
  /** CRUMPLE: ticks the squash springs back (past round, then settling). */
  spring: 6,
  /** CRUMPLE: ticks from the impact to tip the rest of the way onto its side. */
  crumple: 6,
  /** SLUMP: ticks to slide down the face to the floor. */
  slump: 8,
  /** A second wall this many ticks away across the first one's normal is
   * the same slam: a corner. */
  cornerTicks: 2,
  /** Ticks the impact burst lasts, and the dust puff at the foot. */
  burstTicks: 5,
  dustTicks: 8,
} as const

/** A hard wall hit. `nx, ny` is the unit normal (both set in a corner);
 * `x, y, z` is where the body hit, pressed to the face; `rot` its spin then. */
export interface Slam {
  /** Tick since the death of the impact. */
  tick: number
  x: number
  y: number
  z: number
  nx: number
  ny: number
  /** Speed into the wall, tiles/tick (the faster axis in a corner). */
  speed: number
  /** Squash at impact, SLAM.squash.min .. max. */
  amp: number
  rot: number
  /** Tick since the death it reaches the floor (the dust puff). */
  down: number
  /** The wall planes it is pressed to, in tiles: the x of a side wall's face
   * (nx set), the y of a north or south wall's edge (ny set). */
  faceX?: number
  faceY?: number
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
  /** Tick (since the death) of the last landing: in flight before it. */
  readonly landed: number
  readonly contacts: readonly WallContact[]
  /** The hard hit, when it slammed (slam on only). */
  readonly slam?: Slam
}

/** Is a footprint of half-size (rx, ry) at (x, y) touching a solid tile? */
export const blocked = (solid: IsSolid, x: number, y: number, rx: number, ry: number): boolean => {
  for (let ty = Math.floor(y - ry); ty <= Math.floor(y + ry); ty++) {
    for (let tx = Math.floor(x - rx); tx <= Math.floor(x + rx); tx++) if (solid(tx, ty)) return true
  }
  return false
}

/** The largest footprint, up to TUMBLE.footprint, that is clear where the body
 * died (a body flush against a wall gets a narrower one). */
const fitFootprint = (solid: IsSolid, x: number, y: number): { rx: number; ry: number } => {
  const shrink = (full: number, clear: (r: number) => boolean): number => {
    for (let r = full; r > 0; r -= 0.05) if (clear(r)) return r
    return 0
  }
  const ry = shrink(TUMBLE.footprint.y, (r) => !blocked(solid, x, y, 0, r))
  const rx = shrink(TUMBLE.footprint.x, (r) => !blocked(solid, x, y, r, ry))
  return { rx, ry }
}

/** Integrate the throw at whole ticks until the body lies still. `slam`: a
 * hard wall hit slams (SLAM) instead of going to `onWall`. */
export const simulateBody = (th: Throw, solid: IsSolid, onWall: OnWall = stopAtWall, opts: { slam?: boolean } = {}): BodyTrack => {
  const jitter = (salt: number): number => 0.9 + 0.2 * unit(th.seed, salt)
  const speed = lerp(TUMBLE.speed.min, TUMBLE.speed.max, th.force) * jitter(1)
  let vx = th.dirX * speed
  let vy = th.dirY * speed
  let vz = lerp(TUMBLE.lift.min, TUMBLE.lift.max, th.force) * jitter(2)
  let x = th.x
  let y = th.y
  let z = 0
  // A body dying flush against a wall gets a footprint narrow enough to be
  // clear there. A centre inside a wall does not move at all.
  const { rx, ry } = fitFootprint(solid, x, y)
  if (blocked(solid, x, y, 0, 0)) vx = vy = 0

  // One tip onto its side, away from the blow: thrown right turns clockwise.
  // Straight up or down, the seed picks. Never a somersault: the force shows
  // in the distance, the hop, the bounces and the slide.
  const side = th.dirX > 0.2 ? 1 : th.dirX < -0.2 ? -1 : unit(th.seed, 3) < 0.5 ? -1 : 1
  const finalRot = side * (Math.PI / 2)

  const poses: BodyPose[] = [{ x, y, z, rot: 0 }]
  const contacts: WallContact[] = []
  let bounces = 0
  let grounded = false
  let landed = 0
  let rollEnd = Infinity
  const rest = TUMBLE.bounce * jitter(4)
  /** The hard hit this tick, while it is being found: its normal and speed. */
  let hit: { nx: number; ny: number; speed: number } | undefined

  /** Slide the footprint along one axis as far toward `dir` as it goes clear,
   * up to `max` tiles: the body pressed to the face. */
  const press = (axis: 'x' | 'y', dir: number, max: number): void => {
    let lo = 0
    let hi = max
    for (let n = 0; n < 16; n++) {
      const mid = (lo + hi) / 2
      const clear = axis === 'x' ? !blocked(solid, x + dir * mid, y, rx, ry) : !blocked(solid, x, y + dir * mid, rx, ry)
      if (clear) lo = mid
      else hi = mid
    }
    if (axis === 'x') x += dir * lo
    else y += dir * lo
  }

  const step = (k: number, axis: 'x' | 'y'): void => {
    const v = axis === 'x' ? vx : vy
    if (v === 0) return
    const nx = axis === 'x' ? x + v : x
    const ny = axis === 'y' ? y + v : y
    if (!blocked(solid, nx, ny, rx, ry)) {
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
    if (opts.slam && c.speed >= (hit ? SLAM.minSpeed / 2 : SLAM.minSpeed)) {
      // Into the face, and no slide: the slam takes it from here. A second
      // face the same tick is the other side of a corner.
      press(axis, Math.sign(v), Math.abs(v))
      hit = { nx: hit ? hit.nx + c.nx : c.nx, ny: hit ? hit.ny + c.ny : c.ny, speed: Math.max(hit?.speed ?? 0, c.speed) }
      return
    }
    const out = onWall(c, { x: vx, y: vy })
    vx = out.x
    vy = out.y
  }

  let k = 0
  while (k < TUMBLE.maxTicks) {
    k++
    step(k, 'x')
    step(k, 'y')
    if (hit) {
      // A corner: the other wall close enough across the first one's normal
      // that the body would be in it a moment later.
      const across = hit.nx === 0 ? 'x' : hit.ny === 0 ? 'y' : undefined
      const v = across === 'x' ? vx : vy
      const reach = Math.abs(v) * SLAM.cornerTicks
      if (across && Math.abs(v) >= SLAM.minSpeed / 2) {
        const far = across === 'x' ? blocked(solid, x + Math.sign(v) * reach, y, rx, ry) : blocked(solid, x, y + Math.sign(v) * reach, rx, ry)
        if (far) {
          contacts.push({ tick: k, x, y, z, nx: across === 'x' ? -Math.sign(v) : 0, ny: across === 'y' ? -Math.sign(v) : 0, speed: Math.abs(v) })
          press(across, Math.sign(v), reach)
          if (across === 'x') hit.nx = -Math.sign(v)
          else hit.ny = -Math.sign(v)
        }
      }
      if (!grounded) z = Math.max(0, z + vz)
      poses.push({ x, y, z, rot: 0 })
      break
    }
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
          landed = k
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

  // The slam's script: pressed where it hit for SLAM.hold, then down the face
  // to the floor (falling, so slow first), lying at the foot after.
  let slam: Slam | undefined
  if (hit) {
    const k0 = k
    const z0 = z
    const len = Math.hypot(hit.nx, hit.ny)
    const down = z0 > 0 ? k0 + SLAM.hold + SLAM.slump : k0
    for (let s = 1; s <= SLAM.hold + SLAM.slump + TUMBLE.rollTicks; s++) {
      const u = Math.min(1, Math.max(0, (s - SLAM.hold) / SLAM.slump))
      poses.push({ x, y, z: z0 * (1 - u * u), rot: 0 })
    }
    const amp = lerp(SLAM.squash.min, SLAM.squash.max, clamp01((hit.speed - SLAM.minSpeed) / (SLAM.maxSpeed - SLAM.minSpeed)))
    slam = {
      tick: k0,
      x,
      y,
      z: z0,
      nx: hit.nx / len,
      ny: hit.ny / len,
      speed: hit.speed,
      amp,
      rot: 0,
      down,
      ...(hit.nx !== 0 ? { faceX: Math.round(x - Math.sign(hit.nx) * rx) } : {}),
      ...(hit.ny !== 0 ? { faceY: Math.round(y - Math.sign(hit.ny) * ry) } : {}),
    }
    if (!grounded) landed = down
  }

  // The tip is steady through the hop and the bounces and lays the body on its
  // side at the last landing; then it rocks past its side and back (the roll)
  // and slides lying still. It never comes back toward upright. A slam holds
  // the tip at the impact and finishes it as the body crumples.
  const land = landed > 0 ? landed : poses.length - 1
  const tipAt = (i: number): number => {
    if (i <= land) return (finalRot * i) / land
    const q = Math.min(1, (i - land) / TUMBLE.rollTicks)
    return finalRot + side * TUMBLE.rock * Math.sin(q * Math.PI) * (1 - q)
  }
  for (let i = 1; i < poses.length; i++) {
    if (!slam || i <= slam.tick) poses[i].rot = tipAt(i)
    else {
      const s = i - slam.tick
      const rot0 = poses[slam.tick].rot
      if (i > land) poses[i].rot = tipAt(i)
      else {
        // It tips while it is pressed flat, so the spring back never shows
        // it more upright than the splat did.
        const u = Math.min(1, s / SLAM.crumple)
        poses[i].rot = rot0 + (finalRot - rot0) * (1 - (1 - u) * (1 - u))
      }
    }
  }
  if (slam) slam.rot = poses[slam.tick].rot
  return { throw: th, poses, settle: poses.length - 1, landed: land, contacts, ...(slam ? { slam } : {}) }
}

/** The slam's squash `ticks` after the death: `q` is the share of its depth
 * along the normal the body has lost (negative: stretched past round as it
 * springs back). Undefined outside the slam. Flat from the impact through
 * SLAM.hold, then a damped spring back over SLAM.spring. */
export const slamAt = (track: BodyTrack, ticks: number): { q: number; nx: number; ny: number } | undefined => {
  const sl = track.slam
  if (!sl) return undefined
  const s = ticks - sl.tick
  if (!(s >= 0) || s >= SLAM.hold + SLAM.spring) return undefined
  let q: number
  if (s < SLAM.hold) q = sl.amp * (1 - (0.2 * s) / SLAM.hold)
  else {
    const u = (s - SLAM.hold) / SLAM.spring
    q = 0.8 * sl.amp * Math.cos(1.5 * Math.PI * u) * (1 - u)
  }
  return { q, nx: sl.nx, ny: sl.ny }
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
