// Deterministic tile-grid pathfinding — the routing brain behind deliberate NPC
// movement. A* over `level.solid`, 4-connected to match the axis-separated slide
// collision (movement.ts), with doors handled the way the sim treats them:
//
//   - a CLOSED, UNLOCKED door tile is PASSABLE at a cost penalty — the walker
//     opens it on contact (ai.ts steering), so routing through it is legal but
//     routing around it is preferred when nearly as short;
//   - a LOCKED door tile is a WALL to an ordinary NPC (no hands for the lock).
//
// Everything here is a PURE function of its arguments: no rng, no wall clock,
// no world access. Tie-breaking is fully deterministic — a fixed neighbour
// order (E, W, S, N) and a heap ordered by (f, then insertion sequence) — so
// the same query returns the same path on every peer and every replay.
//
// Cost is BOUNDED: expansion stops after `maxNodes` explored tiles and reports
// failure, so a flood across a sealed-off map can never spike a tick. Callers
// (ai.ts) additionally stagger repaths per entity so at most a handful of
// queries run on any one tick.

import { isSolidTile, type Level } from './levelgen/level'
import type { Vec2 } from './types'

/** Door context for one query, as tile keys (`ty * level.w + tx`). */
export interface PathBlockers {
  /** Tiles holding a CLOSED, UNLOCKED door — passable at `DOOR_COST` extra. */
  closedDoors?: ReadonlySet<number>
  /** Tiles holding a LOCKED (or otherwise unopenable) door — solid to this walker. */
  lockedDoors?: ReadonlySet<number>
}

/** Default cap on explored nodes — generous for a 64×64 floor's real routes,
 * small enough that a hopeless flood-fill stays cheap. */
export const PATH_MAX_NODES = 700

/** Extra cost of stepping through a closed door (opening it takes a beat and
 * makes the walker visible in the frame) — routes around when nearly as short. */
export const DOOR_COST = 4

/** Fixed 4-neighbour expansion order — the deterministic tie-break. */
const STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/** Binary min-heap entry: `f` (g + heuristic) primary, insertion `seq` as the
 * total-order tie-break, so pops are byte-for-byte deterministic. */
interface Node {
  key: number
  g: number
  f: number
  seq: number
}

const less = (a: Node, b: Node): boolean => a.f < b.f || (a.f === b.f && a.seq < b.seq)

const heapPush = (heap: Node[], n: Node): void => {
  heap.push(n)
  let i = heap.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (!less(heap[i], heap[p])) break
    const t = heap[p]
    heap[p] = heap[i]
    heap[i] = t
    i = p
  }
}

const heapPop = (heap: Node[]): Node => {
  const top = heap[0]
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < heap.length && less(heap[l], heap[m])) m = l
      if (r < heap.length && less(heap[r], heap[m])) m = r
      if (m === i) break
      const t = heap[m]
      heap[m] = heap[i]
      heap[i] = t
      i = m
    }
  }
  return top
}

/**
 * A* route from world point (fromX,fromY) to (toX,toY), returned as a list of
 * TILE-CENTRE waypoints — the first entry is the first step OFF the start tile,
 * the last is the goal tile's centre. `[]` means "already there" (same tile);
 * `null` means no route (blocked goal, sealed region, or budget exhausted).
 * Consecutive nodes are always orthogonally adjacent open tiles, so a body of
 * radius < 0.5 can walk node-to-node without ever touching a solid tile.
 */
export const findPath = (
  level: Level,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  blockers: PathBlockers = {},
  maxNodes = PATH_MAX_NODES,
): Vec2[] | null => {
  const lw = level.w
  const closed = blockers.closedDoors
  const locked = blockers.lockedDoors
  const sx = Math.floor(fromX)
  const sy = Math.floor(fromY)
  const gx = Math.floor(toX)
  const gy = Math.floor(toY)
  const goalKey = gy * lw + gx
  const startKey = sy * lw + sx

  const walkable = (tx: number, ty: number): boolean =>
    !isSolidTile(level, tx, ty) && !locked?.has(ty * lw + tx)

  if (sx === gx && sy === gy) return []
  // A blocked goal (wall / locked door) can never be stood on — fail fast
  // instead of flooding the whole reachable region looking for it.
  if (!walkable(gx, gy)) return null
  if (!walkable(sx, sy)) return null

  const gScore = new Map<number, number>()
  const cameFrom = new Map<number, number>()
  const open: Node[] = []
  let seq = 0
  gScore.set(startKey, 0)
  heapPush(open, { key: startKey, g: 0, f: Math.abs(gx - sx) + Math.abs(gy - sy), seq: seq++ })

  let explored = 0
  while (open.length > 0) {
    const cur = heapPop(open)
    if (cur.g > (gScore.get(cur.key) ?? Infinity)) continue // stale heap entry
    if (cur.key === goalKey) {
      // Reconstruct: goal → start, then reverse into walk order (start excluded).
      const out: Vec2[] = []
      let k = goalKey
      while (k !== startKey) {
        out.push({ x: (k % lw) + 0.5, y: Math.floor(k / lw) + 0.5 })
        k = cameFrom.get(k)!
      }
      out.reverse()
      return out
    }
    if (++explored > maxNodes) return null
    const cx = cur.key % lw
    const cy = Math.floor(cur.key / lw)
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx
      const ny = cy + dy
      if (!walkable(nx, ny)) continue
      const nKey = ny * lw + nx
      const stepCost = 1 + (closed?.has(nKey) ? DOOR_COST : 0)
      const ng = cur.g + stepCost
      if (ng >= (gScore.get(nKey) ?? Infinity)) continue
      gScore.set(nKey, ng)
      cameFrom.set(nKey, cur.key)
      heapPush(open, { key: nKey, g: ng, f: ng + Math.abs(gx - nx) + Math.abs(gy - ny), seq: seq++ })
    }
  }
  return null
}
