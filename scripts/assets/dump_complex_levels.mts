// Dump indoor-complex tile grids (floors 3+) as JSON so the Python tile tools
// (indoor_preview.py) can compose TEXTURED map previews from a theme's real
// tile art without a browser (headless WebGL is unreliable on the dev box).
// Read-only over the level generator: it only calls createWorld + setupFloor.
//
//   pnpm exec tsx scripts/assets/dump_complex_levels.mts <out.json> [seed:floor ...]
import { writeFileSync } from 'node:fs'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'

const out = process.argv[2] ?? '/tmp/complex-levels.json'
const picks = (process.argv.length > 3 ? process.argv.slice(3) : ['3:3', '3:4', '3:5', '3:6']).map((s) =>
  s.split(':').map(Number),
)
const levels = picks.map(([seed, floor]) => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const L = w.level
  return {
    seed,
    floor,
    biome: L.complex?.biome ?? null,
    w: L.w,
    h: L.h,
    tiles: Array.from(L.tiles),
    doors: L.buildings.flatMap((b) => b.doors),
    rooms: L.buildings.map((b) => ({ role: b.role, rect: b.rooms[0] })),
  }
})
writeFileSync(out, JSON.stringify(levels))
console.log(`${out}: ${levels.map((l) => `${l.seed}:${l.floor} ${l.biome} ${l.w}x${l.h}`).join(', ')}`)
