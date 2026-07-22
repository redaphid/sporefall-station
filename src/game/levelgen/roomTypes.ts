import type { Building, RoomType } from './level'
import type { Rect } from './rooms'

/**
 * Give every room in a building a legible identity — "this is the shop floor,
 * that is the stockroom, the little one is the bathroom" — so furnishing,
 * missions and AI can reason about rooms instead of anonymous rects.
 *
 * The assignment is a PURE function of geometry the generator already fixed:
 * role, room areas, which room the street door opens into, and the designated
 * objective room. It draws NO rng, so calling it can never perturb a
 * generation stream — the frozen floor-1 checksums and every populate stream
 * stay byte-identical.
 */

/** A building's room rects can NEST — the vault layout carves a small sealed
 * chamber inside one big open-hall room (`rooms = [interior, vault]`). So a
 * floor tile belongs to the SMALLEST room that contains it; the hall and its
 * vault are then furnished (and counted) independently, never double-stacked.
 * Returns the owning index into `rooms`, or -1 if no room covers the tile. */
export const roomOwningTile = (rooms: readonly Rect[], tx: number, ty: number): number => {
  let best = -1
  let bestArea = Infinity
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]
    if (tx < r.x || ty < r.y || tx >= r.x + r.w || ty >= r.y + r.h) continue
    const area = r.w * r.h
    if (area < bestArea) {
      bestArea = area
      best = i
    }
  }
  return best
}

/** Indices of rooms a street door opens into: for each door on the building's
 * exterior wall, the room owning the tile just inside it. Doors that open onto
 * a corridor/passage (hallway spines, compound gates, bunker airlocks) own no
 * room and contribute nothing. */
const entryRooms = (b: Building): Set<number> => {
  const { x, y, w, h } = b.rect
  const entries = new Set<number>()
  for (const d of b.doors) {
    let ix = d.x
    let iy = d.y
    if (d.x === x) ix = x + 1
    else if (d.x === x + w - 1) ix = x + w - 2
    else if (d.y === y) iy = y + 1
    else if (d.y === y + h - 1) iy = y + h - 2
    else continue // interior door
    const ri = roomOwningTile(b.rooms, ix, iy)
    if (ri >= 0) entries.add(ri)
  }
  return entries
}

export const assignRoomTypes = (b: Building): RoomType[] => {
  const rooms = b.rooms
  const n = rooms.length
  const area = (i: number): number => rooms[i].w * rooms[i].h
  // Ascending by area, index as the deterministic tie-break.
  const order = rooms.map((_, i) => i).sort((a, c) => area(a) - area(c) || a - c)
  const smallest = order[0]
  const largest = order[n - 1]
  const objIdx = b.objectiveRoom
    ? rooms.findIndex(
        (r) =>
          r === b.objectiveRoom ||
          (r.x === b.objectiveRoom!.x && r.y === b.objectiveRoom!.y && r.w === b.objectiveRoom!.w && r.h === b.objectiveRoom!.h),
      )
    : -1

  // Bunkers have a fixed anatomy: guard band first, the sealed core deepest.
  if (b.role === 'bunker') {
    return rooms.map((_, i) => (i === objIdx ? 'armory' : i === 0 ? 'guardpost' : 'barracks'))
  }

  const entries = entryRooms(b)
  /** The single front-of-house room: the largest room with a street door, or
   * the largest room outright when no door opens directly into a room. */
  const front = (): number => {
    for (let k = n - 1; k >= 0; k--) if (entries.has(order[k])) return order[k]
    return largest
  }

  const types: RoomType[] = new Array<RoomType>(n)
  switch (b.role) {
    case 'shop': {
      // EVERY street-door room is shop floor (a corner shop with two doors is
      // one big shop floor); back rooms hold the stock.
      types.fill('stockroom')
      for (const i of entries) types[i] = 'shopfloor'
      if (entries.size === 0) types[largest] = 'shopfloor'
      break
    }
    case 'apartment': {
      types.fill('bedroom')
      types[largest] = 'living'
      if (n >= 2 && smallest !== largest) types[smallest] = 'bathroom'
      break
    }
    case 'office': {
      types.fill('office')
      if (n >= 2) {
        types[front()] = 'lobby'
        // The smallest room still typed office becomes the supply closet.
        if (n >= 3) {
          const s = order.find((i) => types[i] === 'office')
          if (s !== undefined) types[s] = 'storage'
        }
      }
      break
    }
    case 'warehouse': {
      types.fill('stockroom')
      if (n >= 2 && smallest !== largest) types[smallest] = 'office' // the foreman's corner
      break
    }
    case 'clinic': {
      types.fill('ward')
      if (n >= 2) {
        types[front()] = 'waiting'
        if (n >= 3) {
          const s = order.find((i) => types[i] === 'ward')
          if (s !== undefined) types[s] = 'supply'
        }
      }
      break
    }
  }
  // A sealed reward chamber is a vault whatever the building around it sells.
  if (b.poi === 'vault' && objIdx >= 0) types[objIdx] = 'vault'
  return types
}
