import type { Rng } from '../rng'
import { Tile, type TileGrid } from './level'
import type { Rect } from './rooms'

/**
 * Bunker archetype (deep-floor set-piece): a windowless block with
 *   - 2-tile-thick outer walls all round,
 *   - a single airlock entry: outer door → 1-tile vestibule → inner door,
 *     with flanking walls so the vestibule is the only way through,
 *   - an innermost chamber sealed behind its own wall ring, its door facing
 *     AWAY from the airlock.
 * The chamber is the plan's explicit `objectiveRoom` — the room mission
 * generation places its target in — so a bunker mission objective always
 * sits in the deepest room, behind three locked doors.
 */
export interface BunkerPlan {
  rooms: Rect[]
  doors: { x: number; y: number }[]
  /** Where a mission objective belongs: the innermost chamber. */
  objectiveRoom: Rect
}

/** Requires rect >= 13x13 (2-thick walls + guard band + 3-tile core). */
export const carveBunker = (rng: Rng, grid: TileGrid, rect: Rect): BunkerPlan => {
  grid.fillRect(rect.x, rect.y, rect.w, rect.h, Tile.Wall)
  const bi: Rect = { x: rect.x + 2, y: rect.y + 2, w: rect.w - 4, h: rect.h - 4 }
  grid.fillRect(bi.x, bi.y, bi.w, bi.h, Tile.Floor)

  // The innermost chamber: wall ring at interior inset 2, floor core inside.
  const ringRect: Rect = { x: bi.x + 2, y: bi.y + 2, w: bi.w - 4, h: bi.h - 4 }
  grid.fillRect(ringRect.x, ringRect.y, ringRect.w, 1, Tile.Wall)
  grid.fillRect(ringRect.x, ringRect.y + ringRect.h - 1, ringRect.w, 1, Tile.Wall)
  grid.fillRect(ringRect.x, ringRect.y, 1, ringRect.h, Tile.Wall)
  grid.fillRect(ringRect.x + ringRect.w - 1, ringRect.y, 1, ringRect.h, Tile.Wall)
  const core: Rect = { x: bi.x + 3, y: bi.y + 3, w: bi.w - 6, h: bi.h - 6 }
  grid.fillRect(core.x, core.y, core.w, core.h, Tile.Floor)

  // Airlock through the 2-thick wall on an rng-chosen side.
  const side = rng.int(0, 3) // 0=top 1=right 2=bottom 3=left
  const doors: { x: number; y: number }[] = []
  if (side === 0 || side === 2) {
    const ax = rng.int(rect.x + 3, rect.x + rect.w - 4)
    const outerY = side === 0 ? rect.y : rect.y + rect.h - 1
    const step = side === 0 ? 1 : -1
    grid.set(ax, outerY, Tile.Floor) // outer door
    grid.set(ax, outerY + step, Tile.Floor) // vestibule
    // Inner door with flanking walls: the chokepoint into the guard band.
    grid.set(ax - 1, outerY + 2 * step, Tile.Wall)
    grid.set(ax + 1, outerY + 2 * step, Tile.Wall)
    doors.push({ x: ax, y: outerY }, { x: ax, y: outerY + 2 * step })
  } else {
    const ay = rng.int(rect.y + 3, rect.y + rect.h - 4)
    const outerX = side === 1 ? rect.x + rect.w - 1 : rect.x
    const step = side === 1 ? -1 : 1
    grid.set(outerX, ay, Tile.Floor)
    grid.set(outerX + step, ay, Tile.Floor)
    grid.set(outerX + 2 * step, ay - 1, Tile.Wall)
    grid.set(outerX + 2 * step, ay + 1, Tile.Wall)
    doors.push({ x: outerX, y: ay }, { x: outerX + 2 * step, y: ay })
  }

  // Chamber door on the side FACING AWAY from the airlock — the objective is a
  // full circuit of the guard band deep.
  const away = (side + 2) % 4
  const coreDoor =
    away === 0
      ? { x: rng.int(core.x, core.x + core.w - 1), y: ringRect.y }
      : away === 2
        ? { x: rng.int(core.x, core.x + core.w - 1), y: ringRect.y + ringRect.h - 1 }
        : away === 1
          ? { x: ringRect.x + ringRect.w - 1, y: rng.int(core.y, core.y + core.h - 1) }
          : { x: ringRect.x, y: rng.int(core.y, core.y + core.h - 1) }
  grid.set(coreDoor.x, coreDoor.y, Tile.Floor)
  doors.push(coreDoor)

  // Guard band + innermost chamber; the chamber is the explicit objective room.
  return { rooms: [bi, core], doors, objectiveRoom: core }
}
