import type { Entity } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { SIM_DT, type InputCmd } from '../types'
import type { World } from '../world'
import { isRolling, ROLL_SPEED } from './roll'
import { isImmobilized } from './statusFx'

const FRICTION = 12 // knockback velocity decay per second

/**
 * Move a circle through the tile grid with axis-separated slide collision.
 * Shared by host sim and client prediction — must stay dependency-free.
 */
const EPS = 1e-4
/** Max displacement per collision sub-step; keeps the boundary snap exact. */
const MAX_STEP = 0.25

export const moveAndCollide = (
  e: Entity,
  dx: number,
  dy: number,
  blocked: (tx: number, ty: number) => boolean,
): void => {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP))
  const sx = dx / steps
  const sy = dy / steps
  for (let i = 0; i < steps; i++) stepAxes(e, sx, sy, blocked)
}

const stepAxes = (
  e: Entity,
  dx: number,
  dy: number,
  blocked: (tx: number, ty: number) => boolean,
): void => {
  if (dx !== 0) {
    const nx = e.pos.x + dx
    if (circleFits(nx, e.pos.y, e.radius, blocked)) {
      e.pos.x = nx
    } else {
      // Try snapping flush against the tile boundary we hit.
      const sx =
        dx > 0 ? Math.ceil(e.pos.x + e.radius) - e.radius - EPS : Math.floor(e.pos.x - e.radius) + e.radius + EPS
      const between = dx > 0 ? sx > e.pos.x && sx < nx : sx < e.pos.x && sx > nx
      if (between && circleFits(sx, e.pos.y, e.radius, blocked)) e.pos.x = sx
    }
  }
  if (dy !== 0) {
    const ny = e.pos.y + dy
    if (circleFits(e.pos.x, ny, e.radius, blocked)) {
      e.pos.y = ny
    } else {
      const sy =
        dy > 0 ? Math.ceil(e.pos.y + e.radius) - e.radius - EPS : Math.floor(e.pos.y - e.radius) + e.radius + EPS
      const between = dy > 0 ? sy > e.pos.y && sy < ny : sy < e.pos.y && sy > ny
      if (between && circleFits(e.pos.x, sy, e.radius, blocked)) e.pos.y = sy
    }
  }
}

/**
 * Circle vs tile AABB overlap — the exact geometry the collision resolver uses to
 * decide a body doesn't fit. Exported so callers that need to ask "is a body
 * standing on this tile?" (e.g. refusing to close a door onto someone —
 * systems/interaction.ts) agree with the resolver bit-for-bit instead of
 * re-deriving the test and drifting from it.
 */
export const circleOverlapsTile = (x: number, y: number, r: number, tx: number, ty: number): boolean => {
  const cx = Math.max(tx, Math.min(x, tx + 1))
  const cy = Math.max(ty, Math.min(y, ty + 1))
  const ddx = x - cx
  const ddy = y - cy
  return ddx * ddx + ddy * ddy < r * r
}

const circleFits = (
  x: number,
  y: number,
  r: number,
  blocked: (tx: number, ty: number) => boolean,
): boolean => {
  const minTx = Math.floor(x - r)
  const maxTx = Math.floor(x + r)
  const minTy = Math.floor(y - r)
  const maxTy = Math.floor(y + r)
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!blocked(tx, ty)) continue
      if (circleOverlapsTile(x, y, r, tx, ty)) return false
    }
  }
  return true
}

export const movementSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  // Collision is the sim's hottest inner loop: every moving entity probes several
  // tiles per axis sub-step, every tick. Consulting `isBlocked` there once meant a
  // FULL `w.entities` scan per tile (doorClosedAt) — O(n²) across the crowd, and it
  // fired on ordinary floor tiles too (isSolidTile is false, so the door scan always
  // ran). With the AI overhaul pushing entity counts up, that scan dominated the
  // frame on mobile, starving the fixed-step loop → the sim ran behind real time,
  // reading as stuck-walk + laggy pause/roll. Build the closed-door tile set ONCE
  // per tick and probe it in O(1). Numeric tile key `ty*w + tx` is unique for every
  // in-bounds tile; out-of-bounds tiles are solid, so isSolidTile short-circuits
  // before the set is ever consulted (no negative-coord key collision reachable).
  const lw = w.level.w
  const closedDoors = new Set<number>()
  for (const d of w.entities) {
    if (d.door && !d.door.open && !d.dead) {
      closedDoors.add(Math.floor(d.pos.y) * lw + Math.floor(d.pos.x))
    }
  }
  const blocked = (tx: number, ty: number): boolean =>
    isSolidTile(w.level, tx, ty) || closedDoors.has(ty * lw + tx)
  for (const e of w.entities) {
    if (e.dead || e.projectile) continue
    const stunned = (e.status !== undefined && (e.status.stun > 0 || e.status.sleep > 0)) || isImmobilized(e)
    // A dodge-roll overrides input: the frozen roll heading drives movement for
    // the whole roll window (rollSystem started it before us this tick).
    const rolling = isRolling(e, w.tick)

    // Players write intent from their input; NPCs got theirs from the AI system.
    if (e.playerCtl && !e.playerCtl.downed && !stunned) {
      const cmd = inputs.get(e.playerCtl.playerId)
      if (rolling) {
        // Roll steers itself; the stick only sets facing (aim where you'll exit).
        e.intent.x = e.playerCtl.roll!.dirX
        e.intent.y = e.playerCtl.roll!.dirY
      } else {
        e.intent.x = 0
        e.intent.y = 0
        if (cmd) {
          const len = Math.hypot(cmd.moveX, cmd.moveY)
          if (len > 0.01) {
            const norm = len > 1 ? 1 / len : 1
            e.intent.x = cmd.moveX * norm
            e.intent.y = cmd.moveY * norm
          }
        }
      }
      // Facing follows the aim vector (aim stick, or aim-where-you-move; see
      // selectAim). A centred aim leaves facing untouched so you keep pointing
      // where you last aimed instead of snapping to a default direction.
      if (cmd && Math.hypot(cmd.aimX, cmd.aimY) > 0.01) e.facing = Math.atan2(cmd.aimY, cmd.aimX)
    } else if (e.playerCtl?.downed) {
      // A downed body has no self-driven movement. Intent is only rewritten for
      // upright players (the branch above), so without this a player downed
      // mid-move — or mid-roll — keeps drifting forever on their stale last
      // intent ("moving automatically" while bleeding out). Zero it and drop any
      // active roll so the burst can't carry a downed body across the map.
      e.intent.x = 0
      e.intent.y = 0
      if (e.playerCtl.roll) e.playerCtl.roll = undefined
    }

    // Rolling ignores stun-freeze on movement (it's committed) and uses the burst
    // speed; everyone else uses their walk speed and halts while stunned.
    const speed = rolling ? ROLL_SPEED : e.speed
    const ix = stunned && !rolling ? 0 : e.intent.x
    const iy = stunned && !rolling ? 0 : e.intent.y
    const dx = (ix * speed + e.vel.x) * SIM_DT
    const dy = (iy * speed + e.vel.y) * SIM_DT
    if (dx !== 0 || dy !== 0) moveAndCollide(e, dx, dy, blocked)

    // Knockback decay
    const decay = Math.max(0, 1 - FRICTION * SIM_DT)
    e.vel.x *= decay
    e.vel.y *= decay
    if (Math.abs(e.vel.x) < 0.01) e.vel.x = 0
    if (Math.abs(e.vel.y) < 0.01) e.vel.y = 0
  }

  pushApart(w, blocked)
}

/** Soft mutual separation between two live bodies — each yields a quarter of the
 * overlap per tick, so a stacked pair drifts apart smoothly. This is the ORIGINAL
 * pairwise resolve, unchanged: both bodies move, including static props (a prop
 * gives way when shoved, which the pathless NPC steering relies on to slip past
 * furniture instead of wedging on it). A no-op when the pair doesn't overlap. */
const resolvePair = (a: Entity, b: Entity, blocked: (tx: number, ty: number) => boolean): void => {
  const dx = b.pos.x - a.pos.x
  const dy = b.pos.y - a.pos.y
  const rr = a.radius + b.radius
  const d2 = dx * dx + dy * dy
  if (d2 >= rr * rr || d2 === 0) return
  const d = Math.sqrt(d2)
  const push = ((rr - d) / 2) * 0.5 // soft: resolve half the overlap per tick
  const nx = dx / d
  const ny = dy / d
  moveAndCollide(a, -nx * push, -ny * push, blocked)
  moveAndCollide(b, nx * push, ny * push, blocked)
}

/**
 * Soft separation so live bodies don't stack.
 *
 * PERF (furnished interiors, ~175 props/floor): the old pass was one O(n²) loop
 * over EVERY entity with hp — and furniture (`interactable`) carries hp, so all
 * ~175 static props joined the pairwise crowd, turning a ~40-actor floor into a
 * ~215-body all-pairs sweep every tick. That ~30× blowup dominated the frame (300
 * ticks: ~440ms of ~490ms was this one loop). But a prop never takes intent or
 * velocity — it only ever MOVES when a mover shoves it — so the pairs that can
 * ever resolve are mover↔mover and mover↔prop; prop↔prop is pure waste (props
 * spawn ≥1 tile apart, radius 0.4, so two never overlap), and mover↔distant-prop
 * is waste too. Index the props into a one-shot tile grid and, for each body,
 * consider only movers-after-it plus props in its 3×3 tile neighbourhood — but
 * RESOLVE every considered pair in the exact ascending array-index order the old
 * nested loop used, with the exact same mutual-push math. Skipped pairs are only
 * ever non-overlapping no-ops, so the world stays byte-identical per seed; the
 * grid just drops the wasted comparisons. (Grid keyed on spawn cell: a prop shoved
 * this tick drifts far less than a tile, so it stays in its bucket and inside the
 * 3×3 reach of anything that could touch it — the skip set never changes.)
 */
const pushApart = (w: World, blocked: (tx: number, ty: number) => boolean): void => {
  const ents = w.entities
  const n = ents.length
  const lw = w.level.w
  // Ordered array indices of live MOVERS (eligible non-props), and a tile grid of
  // live PROP indices keyed by spawn cell. Both hold array indices so pairs resolve
  // in the same order the flat i<j loop would have.
  const moverIdx: number[] = []
  const propGrid = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const e = ents[i]
    if (e.dead || !e.health || e.projectile) continue
    if (e.kind === 'interactable') {
      const key = Math.floor(e.pos.y) * lw + Math.floor(e.pos.x)
      const cell = propGrid.get(key)
      if (cell) cell.push(i)
      else propGrid.set(key, [i])
    } else {
      moverIdx.push(i)
    }
  }
  if (moverIdx.length === 0) return
  const nearby: number[] = []
  let mp = 0 // first entry of moverIdx strictly greater than the current outer i
  for (let i = 0; i < n; i++) {
    const a = ents[i]
    if (a.dead || !a.health || a.projectile) continue
    while (mp < moverIdx.length && moverIdx[mp] <= i) mp++
    if (a.kind === 'interactable') {
      // A prop only ever pairs with movers (prop↔prop can't overlap); resolve
      // against every mover after it, in index order.
      for (let k = mp; k < moverIdx.length; k++) resolvePair(a, ents[moverIdx[k]], blocked)
      continue
    }
    // A mover pairs with movers-after-it AND props in its 3×3 neighbourhood.
    // Collect the neighbour props (index > i), then walk both index-sorted streams
    // in ascending order so the resolve sequence matches the old flat loop exactly.
    nearby.length = 0
    if (propGrid.size > 0) {
      const atx = Math.floor(a.pos.x)
      const aty = Math.floor(a.pos.y)
      for (let ty = aty - 1; ty <= aty + 1; ty++) {
        for (let tx = atx - 1; tx <= atx + 1; tx++) {
          const cell = propGrid.get(ty * lw + tx)
          if (!cell) continue
          for (const pi of cell) if (pi > i) nearby.push(pi)
        }
      }
      if (nearby.length > 1) nearby.sort((p, q) => p - q)
    }
    let k = mp
    let s = 0
    while (k < moverIdx.length || s < nearby.length) {
      const mv = k < moverIdx.length ? moverIdx[k] : Infinity
      const pv = s < nearby.length ? nearby[s] : Infinity
      if (mv < pv) {
        resolvePair(a, ents[mv], blocked)
        k++
      } else {
        resolvePair(a, ents[pv], blocked)
        s++
      }
    }
  }
}
