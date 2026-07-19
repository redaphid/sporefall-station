// Exploratory: print the tile map around the combat-stage lane (seed 7, floor 1)
// to place the walk8 circle in open space.
import { createWorld } from '../../src/game/world'
import { Tile } from '../../src/game/levelgen/level'
const w = createWorld(7, 1)
const L = w.level
const glyph: Record<number, string> = { [Tile.Wall]: '#', [Tile.Street]: '.', [Tile.Sidewalk]: ',', [Tile.Floor]: '_', [Tile.Grass]: '"', [Tile.Exit]: 'E' }
for (let y = 4; y <= 18; y++) {
  let row = ''
  for (let x = 2; x <= 24; x++) row += glyph[L.tiles[y * L.w + x]] ?? '?'
  console.log(String(y).padStart(2), row)
}
