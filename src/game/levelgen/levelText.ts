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

import { isWallTile, Tile, type Building, type Level, type TileId } from './level'

/** The legend. One printable, JSON-safe ASCII glyph per tile id. */
export const TILE_GLYPH: Readonly<Record<TileId, string>> = {
  [Tile.Street]: ':',
  [Tile.Sidewalk]: '-',
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

/** Parse level text into a live `Level`. This is a trust boundary (a save
 * crafted by hand or fetched from a share link), so a malformed map throws with
 * the row and column at fault instead of loading a corrupt world. */
export const levelFromJson = (j: LevelJson): Level => {
  const h = j.rows.length
  if (h === 0) throw new Error('level has no rows')
  const w = j.rows[0].length
  if (w === 0) throw new Error('level row 0 is empty')
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
