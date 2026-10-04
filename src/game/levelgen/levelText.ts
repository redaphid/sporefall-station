// A level as hand-readable, hand-editable text: one glyph per tile, one string
// per row. This is the level half of an AUTHORED world (serialize.ts writes it
// into a WorldJson whenever the level is not regenerable from seed+floor), and
// it is also how a test or a crafted save draws its map:
//
//   rows: ['#########',
//          '#...@...#',
//          '#.......#',
//          '####E####']
//
// `solid` is not stored: it is derived from the tiles exactly as the generators
// derive it (`isWallTile`), so a hand edit cannot leave the two layers disagreeing.

import { BIOMES } from './floors'
import { isWallTile, Tile, type Building, type Level, type TileId } from './level'

/** The legend. One printable, JSON-safe ASCII glyph per tile id. */
export const TILE_GLYPH: Readonly<Record<TileId, string>> = {
  [Tile.Causeway]: ':',
  [Tile.Boardwalk]: '-',
  [Tile.Floor]: '.',
  [Tile.Wall]: '#',
  [Tile.Grass]: ',',
  [Tile.Exit]: 'E',
  [Tile.WallCutNW]: '1',
  [Tile.WallCutNE]: '2',
  [Tile.WallCutSE]: '3',
  [Tile.WallCutSW]: '4',
  [Tile.Hall]: '=',
  [Tile.Grate]: 'x',
  [Tile.Tiled]: '+',
  [Tile.Plating]: '%',
  [Tile.Hull]: 'H',
  [Tile.Bog]: '~',
  [Tile.StairUp]: '^',
  [Tile.StairDown]: 'v',
}

/** Authoring-only mark: a Floor tile that is also the player spawn. Never
 * written back out; a serialized level names its spawn explicitly. */
export const SPAWN_GLYPH = '@'

const TILE_OF_GLYPH = new Map<string, TileId>(
  Object.entries(TILE_GLYPH).map(([id, glyph]) => [glyph, Number(id) as TileId]),
)

type Point = { x: number; y: number }

/** The JSON form of a `Level`. Everything but `rows` may be omitted when
 * authoring: `spawn` defaults to the `@` tile (else the map centre), `exit` to
 * the first `E` tile (else off the map, so no tile is an exit), and the
 * structure lists to empty. */
export interface LevelJson {
  rows: string[]
  /** Player spawn, tile-centre world coords (x.5, y.5). */
  spawn?: Point
  /** Exit tile, integer tile coords. */
  exit?: Point
  buildings?: Building[]
  theme?: Level['theme']
  plazas?: Level['plazas']
  complex?: Level['complex']
  storeys?: Level['storeys']
  stairs?: Level['stairs']
}

/** Where no exit was drawn: a tile no body can stand on. */
const NO_EXIT: Point = { x: -1, y: -1 }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Largest level side accepted from level text. The biggest generated atlas
 * is a few hundred tiles wide; the cap keeps a hostile save from stalling the
 * page on a multi-gigabyte allocation. */
export const MAX_LEVEL_SIDE = 1024

const fail = (field: string, why: string): never => {
  throw new Error(`level.${field} ${why}`)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown, field: string): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail(field, `must be a finite number, got ${JSON.stringify(v)}`)

const int = (v: unknown, field: string): number =>
  Number.isInteger(v) ? (v as number) : fail(field, `must be an integer, got ${JSON.stringify(v)}`)

const str = (v: unknown, field: string): string => (typeof v === 'string' ? v : fail(field, 'must be a string'))

const oneOf = <T extends string>(v: unknown, field: string, allowed: readonly T[]): T =>
  allowed.includes(v as T) ? (v as T) : fail(field, `must be one of ${allowed.join('/')}, got ${JSON.stringify(v)}`)

const list = (v: unknown, field: string, each: (item: unknown, field: string) => void): void => {
  if (!Array.isArray(v)) fail(field, 'must be an array')
  ;(v as unknown[]).forEach((item, i) => each(item, `${field}[${i}]`))
}

const record = (v: unknown, field: string): Record<string, unknown> => (isRecord(v) ? v : fail(field, 'must be an object'))

const point = (v: unknown, field: string): Point => {
  const p = record(v, field)
  return { x: num(p.x, `${field}.x`), y: num(p.y, `${field}.y`) }
}

const rect = (v: unknown, field: string): void => {
  const r = record(v, field)
  for (const k of ['x', 'y', 'w', 'h']) int(r[k], `${field}.${k}`)
}

const BUILDING_ROLES = [
  'shop', 'apartment', 'office', 'warehouse', 'clinic', 'bunker', 'mess', 'galley', 'quarters',
  'washroom', 'lab', 'medbay', 'reactor', 'depot', 'security',
] as const
const POIS = ['courtyard', 'vault', 'hallway', 'bunker', 'module'] as const
const THEMES = ['downtown', 'slums', 'stillworks', 'culturebeds'] as const
const STOREY_KINDS = ['ground', 'upper', 'tower', 'basement'] as const
const STAIR_DIRS = ['n', 'e', 's', 'w'] as const

const building = (v: unknown, field: string): void => {
  const b = record(v, field)
  rect(b.rect, `${field}.rect`)
  list(b.rooms, `${field}.rooms`, rect)
  list(b.doors, `${field}.doors`, point)
  oneOf(b.role, `${field}.role`, BUILDING_ROLES)
  if (b.poi !== undefined) oneOf(b.poi, `${field}.poi`, POIS)
  if (b.roomTypes !== undefined) list(b.roomTypes, `${field}.roomTypes`, str)
  if (b.courtyard !== undefined) rect(b.courtyard, `${field}.courtyard`)
  if (b.objectiveRoom !== undefined) rect(b.objectiveRoom, `${field}.objectiveRoom`)
}

const buildingIndex = (count: number) => (v: unknown, field: string): void => {
  const i = int(v, field)
  if (i < 0 || i >= count) fail(field, `is building ${i}, but the level has ${count}`)
}

/** Check everything in level text except the grid itself, naming the field at
 * fault. `w`/`h` bound the spawn and exit. */
const checkStructure = (j: Record<string, unknown>, w: number, h: number): void => {
  if (j.spawn !== undefined) {
    const p = point(j.spawn, 'spawn')
    if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) fail('spawn', `${p.x},${p.y} is off the ${w}x${h} map`)
  }
  if (j.exit !== undefined) {
    const e = { x: int(record(j.exit, 'exit').x, 'exit.x'), y: int(record(j.exit, 'exit').y, 'exit.y') }
    const none = e.x === NO_EXIT.x && e.y === NO_EXIT.y
    if (!none && (e.x < 0 || e.y < 0 || e.x >= w || e.y >= h)) fail('exit', `${e.x},${e.y} is off the ${w}x${h} map`)
  }
  const buildings = j.buildings ?? []
  list(buildings, 'buildings', building)
  const inBuildings = buildingIndex((buildings as unknown[]).length)
  if (j.theme !== undefined) oneOf(j.theme, 'theme', THEMES)
  if (j.plazas !== undefined) list(j.plazas, 'plazas', rect)
  if (j.complex !== undefined) {
    const c = record(j.complex, 'complex')
    oneOf(c.biome, 'complex.biome', BIOMES)
    list(c.corridors, 'complex.corridors', (v, f) => {
      const k = record(v, f)
      rect(k.rect, `${f}.rect`)
      oneOf(k.axis, `${f}.axis`, ['h', 'v'] as const)
    })
    list(c.vents, 'complex.vents', point)
    list(c.wings, 'complex.wings', (v, f) => {
      const g = record(v, f)
      rect(g.rect, `${f}.rect`)
      list(g.buildings, `${f}.buildings`, inBuildings)
    })
    if (c.archetype !== undefined) str(c.archetype, 'complex.archetype')
    if (c.objective !== undefined) inBuildings(c.objective, 'complex.objective')
  }
  if (j.storeys !== undefined) {
    list(j.storeys, 'storeys', (v, f) => {
      const t = record(v, f)
      int(t.slot, `${f}.slot`)
      int(t.z, `${f}.z`)
      oneOf(t.kind, `${f}.kind`, STOREY_KINDS)
      int(t.ox, `${f}.ox`)
    })
  }
  if (j.stairs !== undefined) {
    list(j.stairs, 'stairs', (v, f) => {
      const t = record(v, f)
      point(t.from, `${f}.from`)
      point(t.to, `${f}.to`)
      point(t.landing, `${f}.landing`)
      oneOf(t.dir, `${f}.dir`, STAIR_DIRS)
    })
  }
}

/** Parse level text into a live `Level`. This is a trust boundary (a save
 * crafted by hand or fetched from a share link), so anything malformed throws,
 * naming the field (or the row and column) at fault, instead of loading a
 * corrupt world. */
export const levelFromJson = (input: LevelJson): Level => {
  const raw: unknown = input
  if (!isRecord(raw)) throw new Error('level must be an object with `rows`')
  const rowsIn = raw.rows
  if (!Array.isArray(rowsIn)) fail('rows', 'must be an array of strings, one per row')
  const rows = rowsIn as unknown[]
  rows.forEach((r, i) => typeof r === 'string' || fail(`rows[${i}]`, 'must be a string'))
  const h = rows.length
  if (h === 0) throw new Error('level has no rows')
  if (h > MAX_LEVEL_SIDE) fail('rows', `has ${h} rows, more than the ${MAX_LEVEL_SIDE} allowed`)
  const w = (rows[0] as string).length
  if (w === 0) throw new Error('level row 0 is empty')
  if (w > MAX_LEVEL_SIDE) fail('rows[0]', `is ${w} wide, more than the ${MAX_LEVEL_SIDE} allowed`)
  checkStructure(raw, w, h)
  const j = raw as unknown as LevelJson
  const tiles = new Uint8Array(w * h)
  let marked: Point | undefined
  let firstExit: Point | undefined
  for (let y = 0; y < h; y++) {
    const row = j.rows[y]
    if (row.length !== w) throw new Error(`level row ${y} is ${row.length} wide, expected ${w}`)
    for (let x = 0; x < w; x++) {
      const glyph = row[x]
      if (glyph === SPAWN_GLYPH) {
        if (marked) throw new Error(`level has a second spawn '${SPAWN_GLYPH}' at row ${y} col ${x}`)
        marked = { x: x + 0.5, y: y + 0.5 }
        tiles[y * w + x] = Tile.Floor
        continue
      }
      const t = TILE_OF_GLYPH.get(glyph)
      if (t === undefined) throw new Error(`level row ${y} col ${x}: unknown glyph '${glyph}'`)
      if (t === Tile.Exit && !firstExit) firstExit = { x, y }
      tiles[y * w + x] = t
    }
  }
  const solid = new Uint8Array(tiles.length)
  for (let i = 0; i < tiles.length; i++) solid[i] = isWallTile(tiles[i]) ? 1 : 0
  return {
    w,
    h,
    tiles,
    solid,
    buildings: clone(j.buildings ?? []),
    spawn: { ...(j.spawn ?? marked ?? { x: Math.floor(w / 2) + 0.5, y: Math.floor(h / 2) + 0.5 }) },
    exit: { ...(j.exit ?? firstExit ?? NO_EXIT) },
    ...(j.theme ? { theme: j.theme } : {}),
    ...(j.plazas ? { plazas: clone(j.plazas) } : {}),
    ...(j.complex ? { complex: clone(j.complex) } : {}),
    ...(j.storeys ? { storeys: clone(j.storeys) } : {}),
    ...(j.stairs ? { stairs: clone(j.stairs) } : {}),
  }
}

/** Write a `Level` as level text. Lossless: `levelFromJson(levelToJson(l))`
 * rebuilds the same tiles, solid layer and structure. */
export const levelToJson = (level: Level): LevelJson => {
  // Level text stores tiles only and rebuilds collision from them, so a level
  // whose collision disagrees with its tiles would reload as a different world.
  for (let i = 0; i < level.tiles.length; i++) {
    if (level.solid[i] !== (isWallTile(level.tiles[i]) ? 1 : 0)) {
      throw new Error(
        `level tile ${i % level.w},${Math.floor(i / level.w)} is ${level.tiles[i]} but solid=${level.solid[i]}; ` +
          'set solid with the tile so the level can be saved',
      )
    }
  }
  const rows: string[] = []
  for (let y = 0; y < level.h; y++) {
    let row = ''
    for (let x = 0; x < level.w; x++) {
      const glyph = TILE_GLYPH[level.tiles[y * level.w + x] as TileId]
      if (glyph === undefined) throw new Error(`level tile ${level.tiles[y * level.w + x]} at ${x},${y} has no glyph`)
      row += glyph
    }
    rows.push(row)
  }
  return {
    rows,
    spawn: { ...level.spawn },
    exit: { ...level.exit },
    ...(level.buildings.length ? { buildings: clone(level.buildings) } : {}),
    ...(level.theme ? { theme: level.theme } : {}),
    ...(level.plazas ? { plazas: clone(level.plazas) } : {}),
    ...(level.complex ? { complex: clone(level.complex) } : {}),
    ...(level.storeys ? { storeys: clone(level.storeys) } : {}),
    ...(level.stairs ? { stairs: clone(level.stairs) } : {}),
  }
}
