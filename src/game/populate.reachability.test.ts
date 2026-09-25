// feat/room-layout — the correctness half of the layout pass.
//
// Arranging furniture into RANKS, CLUMPS and CLUSTERS is exactly the change that
// can accidentally wall a room off: a rank that spans a narrow room, or a heap of
// crates grown across a 3-wide stockroom, severs the floor behind it. A
// beautifully arranged room the player cannot walk through is strictly worse than
// scattered junk, and it is a failure that hides in one seed out of hundreds —
// precisely the thing an eye check misses and a player finds.
//
// So this suite does NOT look at pictures. It floods the floor twice over a wide
// seed/floor sweep — once ignoring furniture, once treating every prop as if it
// were a solid wall — and asserts the arrangement never disconnects anything:
//
//   * every tile reachable before furnishing is still reachable after (bar the
//     tiles the props themselves stand on),
//   * every doorway and the floor exit stay reachable,
//   * every prop can be walked up to (so it can be smashed, looted, used),
//   * every other spawned entity — NPC, pickup, door, mission key, generator,
//     Spore Node — stands on or beside reachable floor.
//
// Props are SOFT bodies in the sim (a player shoves through them), so this is a
// deliberately STRONGER guarantee than the game strictly needs. That is the
// point: it leaves headroom, and it fails loudly if a future layout rule starts
// building walls out of furniture.

import { describe, expect, it } from 'vitest'
import { populateWorld } from './populate'
import { isSolidTile } from './levelgen/level'
import { setupFloor } from './systems/missions'
import { createWorld, type World } from './world'

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/** A fully dressed floor: level + population + furniture + mission objects, via
 * the REAL pipeline (no hand-built worlds — the bug would hide in the seams).
 *
 * `furniture` is captured BETWEEN the two stages on purpose. Everything
 * `populateWorld` puts down is furnishing — what this layout pass decides, and
 * therefore what it must answer for. `setupFloor` then adds the mission's own
 * objects (biolock key, generator, Spore Node); those are a different system's
 * placement, so they are judged as things that must stay REACHABLE, not as
 * obstacles this pass gets blamed for. */
const dressed = (seed: number, floor: number): { w: World; furniture: Set<number> } => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  const furniture = new Set<number>()
  for (const e of w.entities) if (e.kind === 'interactable' && !e.dead) furniture.add(e.id)
  setupFloor(w)
  return { w, furniture }
}

/** Tile keys occupied by a live furnishing. */
const propTiles = (w: World, furniture: ReadonlySet<number>): Set<number> => {
  const out = new Set<number>()
  for (const e of w.entities) {
    if (furniture.has(e.id) && !e.dead) out.add(Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x))
  }
  return out
}

/** 4-connected flood from the player spawn over every non-solid tile, optionally
 * treating `blocked` tile keys as walls too. */
const flood = (w: World, blocked?: ReadonlySet<number>): Set<number> => {
  const { w: lw, h: lh } = w.level
  const start = Math.floor(w.level.spawn.y) * lw + Math.floor(w.level.spawn.x)
  const seen = new Set<number>()
  const open = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= lw || ty >= lh) return false
    if (isSolidTile(w.level, tx, ty)) return false
    return !blocked?.has(ty * lw + tx)
  }
  if (!open(Math.floor(w.level.spawn.x), Math.floor(w.level.spawn.y))) return seen
  const stack = [start]
  seen.add(start)
  while (stack.length > 0) {
    const k = stack.pop()!
    const tx = k % lw
    const ty = (k - tx) / lw
    for (const [dx, dy] of ORTHO) {
      const nx = tx + dx
      const ny = ty + dy
      const nk = ny * lw + nx
      if (seen.has(nk) || !open(nx, ny)) continue
      seen.add(nk)
      stack.push(nk)
    }
  }
  return seen
}

/** On a reachable tile, or orthogonally beside one — "a player can get to it". */
const touchable = (w: World, reach: ReadonlySet<number>, tx: number, ty: number): boolean => {
  const lw = w.level.w
  if (reach.has(ty * lw + tx)) return true
  return ORTHO.some(([dx, dy]) => reach.has((ty + dy) * lw + (tx + dx)))
}

// A wide sweep: enough seeds that a rare degenerate room actually turns up, and
// every floor flavour (themed floors add bunkers, vaults, courtyards).
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1)
const FLOORS = [1, 2, 3, 4, 5]

describe('room layout — furniture never walls anything off', () => {
  it('every tile reachable before furnishing is still reachable after', () => {
    for (const s of SEEDS) {
      for (const f of FLOORS) {
        const { w, furniture } = dressed(s, f)
        const props = propTiles(w, furniture)
        const bare = flood(w)
        const furnished = flood(w, props)
        for (const k of bare) {
          // The prop's own tile is legitimately taken; everything else must stay
          // connected to the spawn.
          if (props.has(k)) continue
          const tx = k % w.level.w
          const ty = (k - tx) / w.level.w
          expect(
            furnished.has(k),
            `seed ${s} floor ${f}: tile (${tx},${ty}) was reachable but furniture cut it off`,
          ).toBe(true)
        }
      }
    }
  })

  it('every doorway and the floor exit stay reachable', () => {
    for (const s of SEEDS) {
      for (const f of FLOORS) {
        const { w, furniture } = dressed(s, f)
        const reach = flood(w, propTiles(w, furniture))
        const bare = flood(w)
        const lw = w.level.w
        for (const b of w.level.buildings) {
          for (const d of b.doors) {
            // Only doors the floor plan actually connects to spawn in the first
            // place — a sealed-by-generation door is levelgen's business.
            if (!bare.has(d.y * lw + d.x)) continue
            expect(
              reach.has(d.y * lw + d.x),
              `seed ${s} floor ${f}: doorway (${d.x},${d.y}) blocked by furniture`,
            ).toBe(true)
          }
        }
        const ex = Math.floor(w.level.exit.x)
        const ey = Math.floor(w.level.exit.y)
        if (bare.has(ey * lw + ex)) {
          expect(reach.has(ey * lw + ex), `seed ${s} floor ${f}: exit blocked by furniture`).toBe(true)
        }
      }
    }
  })

  it('every prop can be walked up to, and every other entity stands on reachable floor', () => {
    for (const s of SEEDS) {
      for (const f of FLOORS) {
        const { w, furniture } = dressed(s, f)
        const props = propTiles(w, furniture)
        const reach = flood(w, props)
        const bare = flood(w)
        for (const e of w.entities) {
          if (e.dead || e.projectile) continue
          const tx = Math.floor(e.pos.x)
          const ty = Math.floor(e.pos.y)
          // Only judge things the floor plan connects to spawn at all; a sealed
          // vault chamber's contents are levelgen's contract, not layout's.
          if (!bare.has(ty * w.level.w + tx)) continue
          expect(
            touchable(w, reach, tx, ty),
            `seed ${s} floor ${f}: ${e.kind} ${e.archetype} at (${tx},${ty}) is fenced in by furniture`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('room layout — the arrangement itself is deterministic', () => {
  it('same seed+floor lays out byte-identical furniture, facings and all', () => {
    const key = (w: World): string =>
      JSON.stringify(
        w.entities
          .filter((e) => e.kind === 'interactable')
          .map((e) => [e.archetype, e.pos.x, e.pos.y, e.facing, e.mount ?? null]),
      )
    for (const s of [1, 7, 42, 123, 424242]) {
      for (const f of FLOORS) {
        expect(key(dressed(s, f).w)).toEqual(key(dressed(s, f).w))
      }
    }
  })
})
