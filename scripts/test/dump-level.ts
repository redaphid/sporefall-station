// Prints a generated level as ASCII for eyeballing procgen output.
// Usage: npx tsx scripts/test/dump-level.ts [seed] [floor]
import { generateLevel } from '../../src/game/levelgen/generate'
import { levelChecksum, Tile } from '../../src/game/levelgen/level'

const seed = Number(process.argv[2]) || 1
const floor = Number(process.argv[3]) || 1
const level = generateLevel(seed, floor)

const GLYPH: Record<number, string> = {
  [Tile.Street]: ' ',
  [Tile.Sidewalk]: '·',
  [Tile.Floor]: '.',
  [Tile.Wall]: '█',
  [Tile.Grass]: ',',
  [Tile.Exit]: 'E',
}

const rows: string[] = []
for (let y = 0; y < level.h; y++) {
  let row = ''
  for (let x = 0; x < level.w; x++) {
    if (Math.floor(level.spawn.x) === x && Math.floor(level.spawn.y) === y) {
      row += '@'
    } else {
      row += GLYPH[level.tiles[y * level.w + x]] ?? '?'
    }
  }
  rows.push(row)
}
console.log(rows.join('\n'))
console.log(`\nseed=${seed} floor=${floor} checksum=${levelChecksum(level).toString(16)}`)
console.log(`buildings=${level.buildings.length} roles=[${level.buildings.map((b) => b.role).join(', ')}]`)
