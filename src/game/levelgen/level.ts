import type { Rect } from './rooms'

export const Tile = {
  Street: 0,
  Sidewalk: 1,
  Floor: 2,
  Wall: 3,
  Grass: 4,
  Exit: 5,
  // 45°-cut wall corners (the name is the OUTSIDE corner that is bevelled).
  // Appended AFTER Exit so existing tile ids never renumber — serialized
  // levelChecksums for old floors stay valid. Collision-wise these are full
  // solid squares (see buildSolid); the cut is visual only, which keeps the
  // physics/netcode byte-identical and can never snag movement (the collision
  // volume strictly contains the drawn shape).
  WallCutNW: 6,
  WallCutNE: 7,
  WallCutSE: 8,
  WallCutSW: 9,
  // ── Indoor complex (floors 3, 5, 7…, levelgen/complex.ts) ─────────────────────────
  // Appended after the cut corners for the same reason: ids never renumber.
  /** Corridor deck plating — the station's hallways. Walkable. */
  Hall: 10,
  /** Ventilation grate set into the deck — walkable, and where the complex
   * director's vent swarms crawl out (systems/complexDirector.ts). */
  Grate: 11,
  /** Scrubbed ceramic tile — mess hall, galley, washroom, med-bay. Walkable. */
  Tiled: 12,
  /** Diamond-tread engineering plate — reactor hall and stores. Walkable. */
  Plating: 13,
  /** The station's outer pressure hull: a wall-family tile, fully solid. */
  Hull: 14,
  /** Bog seep — swamp water that has found its way onto the deck (the station
   * is sinking). Walkable shallows; the flooded biome's signature. */
  Bog: 15,
  // ── Stairs (docs/design/stairs-and-storeys.md) ───────────────────────────────
  // Appended for the same reason: ids never renumber. Both are WALKABLE (not
  // wall-family), and neither is `isFloorTile`, so furniture, loot and spawns
  // skip them without being told.
  /** The lower end of a stair shaft: stepping on it climbs to the storey above. */
  StairUp: 16,
  /** The upper end of a stair shaft: stepping on it descends to the storey below. */
  StairDown: 17,
} as const
export type TileId = (typeof Tile)[keyof typeof Tile]

/** Every wall-family tile (plain wall + the 4 bevelled corner variants). */
export const isWallTile = (t: number): boolean =>
  t === Tile.Wall || (t >= Tile.WallCutNW && t <= Tile.WallCutSW) || t === Tile.Hull

/** Every INTERIOR floor-family tile — a tile inside a room/corridor that a body
 * can stand on and furniture/loot/spawns may occupy. The classic city only ever
 * lays `Tile.Floor`; the indoor complex adds its deck variants. Streets,
 * sidewalks, grass and the exit pad are ground, not interior floor. */
export const isFloorTile = (t: number): boolean =>
  t === Tile.Floor || t === Tile.Tiled || t === Tile.Plating || t === Tile.Hall || t === Tile.Grate || t === Tile.Bog

/** For each cut-corner variant, the diagonal offset toward the OUTSIDE ground
 * tile the bevel exposes — the renderer draws that neighbour underneath. */
export const WALL_CUT_OUTSIDE: Record<number, { dx: number; dy: number }> = {
  [Tile.WallCutNW]: { dx: -1, dy: -1 },
  [Tile.WallCutNE]: { dx: 1, dy: -1 },
  [Tile.WallCutSE]: { dx: 1, dy: 1 },
  [Tile.WallCutSW]: { dx: -1, dy: 1 },
}

export type BuildingRole =
  | 'shop'
  | 'apartment'
  | 'office'
  | 'warehouse'
  | 'clinic'
  | 'bunker'
  // Indoor complex modules (floors 3, 5, 7…): one room per module, named for what the
  // colony used it for — see levelgen/complex.ts and COMPLEX_ROOM_TYPE.
  | 'mess'
  | 'galley'
  | 'quarters'
  | 'washroom'
  | 'lab'
  | 'medbay'
  | 'reactor'
  | 'depot'
  | 'security'

/** What a single room IS, within its building's fiction — drives which
 * furniture it gets and where that furniture sits (populate.furnishInteriors),
 * and gives missions/AI/debug a legible name for "the room you are in".
 * Assigned per room by `assignRoomTypes` (roomTypes.ts): a PURE geometric
 * derivation from the building's role, room sizes, street doors and objective
 * room — it draws no rng, so adding it never perturbs generation streams. */
export type RoomType =
  | 'shopfloor' // customer-facing shop front: shelves, vending, the till
  | 'stockroom' // back-of-house / warehouse stock: crates, shelving
  | 'living' // apartment common room: tv, table
  | 'bedroom' // bunks against the walls
  | 'bathroom' // the smallest room in the flat
  | 'lobby' // office reception
  | 'office' // desks-and-cabinets workroom
  | 'storage' // office/compound supply closet
  | 'waiting' // clinic front room: benches
  | 'ward' // clinic treatment room: cots and cabinets
  | 'supply' // clinic med-supply closet
  | 'guardpost' // bunker guard band around the core
  | 'armory' // bunker core: weapon lockers
  | 'barracks' // bunker sleeping quarters
  | 'vault' // sealed reward chamber
  // Indoor complex rooms (floors 3, 5, 7…)
  | 'messhall' // the crew dining hall: long tables and benches
  | 'galley' // the kitchen behind the mess: counters, dispensers
  | 'bunkroom' // crew sleeping quarters: rows of bunks and lockers
  | 'washroom' // wash block: stalls and cabinets
  | 'lab' // essence lab: benches, consoles, specimen pods
  | 'medbay' // station infirmary: cots and med cabinets
  | 'reactor' // the reactor hall: generators and heavy plant
  | 'depot' // station stores: crates and shelving
  | 'security' // security post: lockers and a desk

/** Layout set-piece a building can carry (beyond a plain box of rooms). */
export type BuildingPoi = 'courtyard' | 'vault' | 'hallway' | 'bunker' | 'module'

export interface Building {
  rect: Rect
  rooms: Rect[]
  /** All door tile positions (exterior + interior). */
  doors: { x: number; y: number }[]
  role: BuildingRole
  /** Optional set-piece tag for populate/missions and variety tests. */
  poi?: BuildingPoi
  /** Per-room type, parallel to `rooms` — see `RoomType`. Filled by
   * generateLevel for every building; optional so hand-built test Buildings
   * stay valid (consumers fall back to `assignRoomTypes`). */
  roomTypes?: RoomType[]
  /** Compound pit (open ground) — populate routes patrol beats around it. */
  courtyard?: Rect
  /** The room a mission objective (briefcase / boss) belongs in — designated
   * EXPLICITLY by the generator that carved the building (bunker core, vault,
   * loop core, …). This is the contract missions.ts places targets by; never
   * infer it from `rooms` array order. Not part of tiles/solid, so it is
   * levelChecksum- and wire-invisible (levels regenerate from seed+floor). */
  objectiveRoom?: Rect
}

/** A floor's district flavour — drives density, footprints and role palette. */
export type ThemeName = 'downtown' | 'slums' | 'industrial' | 'park'

export interface Theme {
  name: ThemeName
  /** Lot subdivisions per axis (density): fewer = bigger blocks. */
  minLots: number
  maxLots: number
  /** Base probability a lot grows a building (vs open ground). */
  buildingChance: number
  /** Ground tile for open lots and setback yards. */
  yard: TileId
  /** Chance a large building is a ring around an open courtyard. */
  courtyardChance: number
  /** Chance a building's footprint shrinks + offsets inside its lot. */
  setbackChance: number
  /** Chance a large building hides a sealed vault room. */
  vaultChance: number
  /** Chance a medium/large building organises around a corridor spine
   * (straight/L/T/loop hallway with rooms hanging off it). */
  hallwayChance: number
  /** Chance a big lot grows a bunker: 2-thick windowless walls, an airlock
   * vestibule entry and a deep innermost chamber. Ramps gently with depth. */
  bunkerChance: number
  /** Role palette (repeats bias the weighting). */
  roles: readonly BuildingRole[]
}

/**
 * District themes cycle by floor so consecutive floors read differently.
 * Index 0 (floor 1) is intentionally dense so early floors feel like a city.
 */
export const THEMES: readonly Theme[] = [
  {
    name: 'downtown',
    minLots: 3,
    maxLots: 4,
    buildingChance: 0.85,
    yard: Tile.Sidewalk,
    courtyardChance: 0.35,
    setbackChance: 0.15,
    vaultChance: 0.2,
    hallwayChance: 0.6,
    bunkerChance: 0.06,
    roles: ['office', 'office', 'shop', 'apartment'],
  },
  {
    name: 'slums',
    minLots: 4,
    maxLots: 5,
    buildingChance: 0.8,
    yard: Tile.Grass,
    courtyardChance: 0.05,
    setbackChance: 0.4,
    vaultChance: 0.05,
    hallwayChance: 0.35,
    bunkerChance: 0.12,
    roles: ['apartment', 'apartment', 'shop', 'warehouse'],
  },
  {
    name: 'industrial',
    minLots: 3,
    maxLots: 3,
    buildingChance: 0.82,
    yard: Tile.Sidewalk,
    courtyardChance: 0.45,
    setbackChance: 0.25,
    vaultChance: 0.15,
    hallwayChance: 0.55,
    bunkerChance: 0.35,
    roles: ['warehouse', 'warehouse', 'office', 'shop'],
  },
  {
    name: 'park',
    minLots: 4,
    maxLots: 5,
    buildingChance: 0.55,
    yard: Tile.Grass,
    courtyardChance: 0.3,
    setbackChance: 0.45,
    vaultChance: 0.05,
    hallwayChance: 0.3,
    bunkerChance: 0.05,
    roles: ['clinic', 'apartment', 'shop', 'clinic'],
  },
]

/** Deterministic theme for a floor (1-based); consecutive floors always differ. */
export const themeForFloor = (floor: number): Theme => THEMES[(floor - 1) % THEMES.length]

/** Is this tile either end of a stair shaft? */
export const isStairTile = (t: number): boolean => t === Tile.StairUp || t === Tile.StairDown

// ── The storey atlas (docs/design/stairs-and-storeys.md §1.1) ──────────────────
// Every storey of a floor sits side by side in the ONE Level grid, separated by
// a 16-tile solid Hull gutter. Slot 0 (x 0..63) is always the ground storey.
// A storey is a pure function of position — no entity field, wire bit or
// serialized field — and every perception range in the sim (LOS, noise 12,
// fear 5, net interest 14) is shorter than the gutter, so nothing leaks across.
/** Tiles per storey side (the ground generators' map size). */
export const STOREY_SIZE = 64
/** Solid Hull between two storeys, wider than any sim perception range. */
export const STOREY_GUTTER = 16
/** Atlas x distance between the origins of two consecutive storey slots. */
export const STOREY_STRIDE = STOREY_SIZE + STOREY_GUTTER

/** One storey of a floor: which atlas slot holds it and its height `z`
 * (0 = ground, +1 = the storey above it). `ox` is the slot's atlas x origin. */
export interface Storey {
  slot: number
  z: number
  kind: 'ground' | 'upper' | 'tower' | 'basement'
  ox: number
}

export type StairDir = 'n' | 'e' | 's' | 'w'

/** One direction of a stair shaft, in ATLAS coords: standing on `from` moves a
 * body to `landing` (the tile in front of `to`, the matching stair tile on the
 * other storey). The pair A->B and B->A are two links. `dir` is the shaft's
 * open side, the same on both storeys. Arrival is on the landing, never on the
 * stair tile. */
export interface StairLink {
  from: { x: number; y: number }
  to: { x: number; y: number }
  landing: { x: number; y: number }
  dir: StairDir
}

export interface Level {
  w: number
  h: number
  /** Visual tile layer, row-major. */
  tiles: Uint8Array
  /** Collision layer: 1 = solid. Derived from tiles (walls). */
  solid: Uint8Array
  buildings: Building[]
  /** Player spawn, tile-center world coords. */
  spawn: { x: number; y: number }
  /** Exit tile. */
  exit: { x: number; y: number }
  /** District theme this floor was generated with. */
  theme?: ThemeName
  /** Open plaza lots (themed floors): paved squares with a green heart. Not
   * serialized — the level regenerates from seed+floor like everything else. */
  plazas?: Rect[]
  /** Present ONLY on indoor-complex floors (3+): the corridor network, vents,
   * wings and biome the complex generator laid down. Its presence is THE
   * switch the complex-aware systems (populate, complexDirector, render) key
   * off. Regenerated from seed+floor, never serialized. */
  complex?: ComplexInfo
  /** The storeys of this floor (levelgen/storeys.ts). Absent means a single
   * storey — every city floor, and a complex floor the structural rule gave no
   * loft. Regenerated from seed+floor, never serialized. */
  storeys?: Storey[]
  /** Stair links, one per direction (see StairLink). Present with `storeys`. */
  stairs?: StairLink[]
}

/** Indoor biome — how a complex floor looks and what crawls out of its vents. */
export type BiomeName = 'habitation' | 'flooded' | 'reactor' | 'overgrown'

/** A straight corridor run: its full tile rect and the axis it runs along. */
export interface Corridor {
  rect: Rect
  axis: 'h' | 'v'
}

/** A wing: one block of modules between corridors. Lights-out hits a wing. */
export interface Wing {
  rect: Rect
  /** Indices into `level.buildings` of the modules in this wing. */
  buildings: number[]
}

export interface ComplexInfo {
  biome: BiomeName
  /** Every carved straight corridor run (intersections included in both axes). */
  corridors: Corridor[]
  /** Vent grate tile positions (director swarm spawn points). */
  vents: { x: number; y: number }[]
  wings: Wing[]
  /** The floorplan archetype (palladian, cloister, pavilion, ship, or a
   * generic spine / tee / ladder / ring). */
  archetype?: string
  /** Index into `level.buildings` of the mission objective: the deepest
   * module by doors crossed from the spawn (floorplan spec P2). This is what
   * missions.farthestBuilding targets on a complex floor. */
  objective?: number
}

/** Mutable view over a tile buffer during generation. */
export class TileGrid {
  constructor(
    readonly w: number,
    readonly h: number,
    readonly tiles: Uint8Array,
  ) {}

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h
  }

  get(x: number, y: number): number {
    return this.inBounds(x, y) ? this.tiles[y * this.w + x] : Tile.Wall
  }

  set(x: number, y: number, t: TileId): void {
    if (this.inBounds(x, y)) this.tiles[y * this.w + x] = t
  }

  fillRect(x: number, y: number, w: number, h: number, t: TileId): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, t)
    }
  }
}

export const tileAt = (level: Level, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return Tile.Wall
  return level.tiles[y * level.w + x]
}

/** Tile-space point-in-rect test (integer tile coords). */
export const rectContains = (r: Rect, tx: number, ty: number): boolean =>
  tx >= r.x && ty >= r.y && tx < r.x + r.w && ty < r.y + r.h

/** Tile-centre world coord of a rect's geometric centre. */
export const rectCenter = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** Index of the building whose footprint contains world point (x,y), or -1 —
 * the "whose turf is this?" query for the territory AI (#77). Linear scan
 * (buildings are few); first match in ascending order wins, so it is fully
 * deterministic. Buildings regenerate from seed+floor, so this is stable. */
export const buildingAt = (level: Level, x: number, y: number): number => {
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  // Rooms first: an L-shaped complex module's bounding rect takes in a
  // corner of its neighbour, whose own ROOM is the truer answer there.
  for (let i = 0; i < level.buildings.length; i++) {
    if (level.buildings[i].rooms.some((r) => rectContains(r, tx, ty))) return i
  }
  for (let i = 0; i < level.buildings.length; i++) {
    if (rectContains(level.buildings[i].rect, tx, ty)) return i
  }
  return -1
}

/** The bunker guard band's PROMISED-OPEN patrol lane, as tile keys (ty*lw+tx):
 * the band room's inner ring, which patrol steering walks as straight legs.
 * Every runtime obstacle keeps off it — furniture (populate.furnishInteriors)
 * and defender-built barricades (behaviors `fortify`) alike — so the contract
 * lives in ONE place. Empty for non-bunkers. */
export const bunkerLaneKeys = (b: Building, lw: number): Set<number> => {
  const keys = new Set<number>()
  if (b.role !== 'bunker' || b.rooms.length === 0) return keys
  const band = b.rooms[0]
  const rx = band.x + 1
  const ry = band.y + 1
  const rw = band.w - 2
  const rh = band.h - 2
  for (let tx = rx; tx < rx + rw; tx++) {
    keys.add(ry * lw + tx)
    keys.add((ry + rh - 1) * lw + tx)
  }
  for (let ty = ry; ty < ry + rh; ty++) {
    keys.add(ty * lw + rx)
    keys.add(ty * lw + (rx + rw - 1))
  }
  return keys
}

export const isSolidTile = (level: Level, x: number, y: number): boolean => {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return true
  return level.solid[y * level.w + x] === 1
}

/** FNV-1a over both layers — the cross-device determinism check. */
export const levelChecksum = (level: Level): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < level.tiles.length; i++) {
    h ^= level.tiles[i]
    h = Math.imul(h, 0x01000193)
    h ^= level.solid[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
