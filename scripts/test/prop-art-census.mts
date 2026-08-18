// Prop-art census: over a seed/floor sweep, count every furnishing the game
// actually places and classify it by HOW IT IS DRAWN — a real themed texture
// from the pack, or a hand-coded PixiJS vector silhouette (FURNITURE_SHAPE).
// This is the evidence behind "which props have no asset at all, and how many".
//
//   pnpm exec tsx scripts/test/prop-art-census.mts [seeds] [floors]
import { readFileSync } from 'node:fs'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'
import { PROP_SPRITE, FURNITURE_SHAPE } from '../../src/render/art'

const SEEDS = Number(process.argv[2] ?? 40)
const FLOORS = Number(process.argv[3] ?? 4)

const manifest = JSON.parse(readFileSync('public/themes/swampspace/manifest.json', 'utf8'))
const sprites: Record<string, string> = manifest.sprites ?? {}

/** Mirror of art.ts propTexture(): PROP_SPRITE → prop.<key>; crate → prop.default. */
const artFor = (a: string): { how: string; file: string } => {
  const key = PROP_SPRITE[a]
  if (key) {
    const f = sprites[`prop.${key}`]
    if (f) return { how: 'texture', file: f }
    return { how: 'MISSING-FILE', file: `prop.${key} (unmapped)` }
  }
  if (a === 'crate' || a.startsWith('prop')) {
    const f = sprites['prop.default']
    if (f) return { how: 'texture', file: f }
    return { how: 'vector', file: FURNITURE_SHAPE[a] ?? 'box' }
  }
  const s = FURNITURE_SHAPE[a]
  if (s) return { how: 'vector', file: `${s} (hand-coded Graphics)` }
  return { how: 'EYEBALL', file: 'character blob fallback' }
}

const tally = new Map<string, number>()
const inHouse = new Map<string, number>()
const HOUSE_ROLES = new Set(['apartment', 'shop', 'office', 'clinic'])

let floors = 0
for (let seed = 1; seed <= SEEDS; seed++) {
  for (let floor = 1; floor <= FLOORS; floor++) {
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    floors++
    for (const e of w.entities) {
      if (e.kind !== 'interactable' || e.dead) continue
      tally.set(e.archetype, (tally.get(e.archetype) ?? 0) + 1)
      const b = w.level.buildings.find(
        (bb) =>
          e.pos.x >= bb.rect.x && e.pos.x <= bb.rect.x + bb.rect.w &&
          e.pos.y >= bb.rect.y && e.pos.y <= bb.rect.y + bb.rect.h,
      )
      if (b && HOUSE_ROLES.has(b.role)) inHouse.set(e.archetype, (inHouse.get(e.archetype) ?? 0) + 1)
    }
  }
}

const rows = [...tally.entries()].sort((a, b) => b[1] - a[1])
const total = rows.reduce((s, [, n]) => s + n, 0)
let vectorTotal = 0
let textureTotal = 0
console.log(`\n=== PROP CENSUS: ${SEEDS} seeds x ${FLOORS} floors = ${floors} floors ===\n`)
console.log('archetype        per-floor   share   drawn-as      asset')
console.log('-'.repeat(78))
for (const [a, n] of rows) {
  const { how, file } = artFor(a)
  if (how === 'texture') textureTotal += n
  else vectorTotal += n
  console.log(
    `${a.padEnd(16)} ${(n / floors).toFixed(1).padStart(7)}  ${((n / total) * 100).toFixed(1).padStart(5)}%   ${how.padEnd(12)}  ${file}`,
  )
}
console.log('-'.repeat(78))
console.log(`TOTAL ${(total / floors).toFixed(1)}/floor   textured ${((textureTotal / total) * 100).toFixed(1)}%   NO ART (vector) ${((vectorTotal / total) * 100).toFixed(1)}%`)

const houseRows = [...inHouse.entries()].sort((a, b) => b[1] - a[1])
const houseTotal = houseRows.reduce((s, [, n]) => s + n, 0)
let houseVector = 0
console.log(`\n=== INSIDE HOUSES (apartment/shop/office/clinic) ===\n`)
for (const [a, n] of houseRows) {
  const { how } = artFor(a)
  if (how !== 'texture') houseVector += n
  console.log(`${a.padEnd(16)} ${(n / floors).toFixed(1).padStart(7)}/floor  ${((n / houseTotal) * 100).toFixed(1).padStart(5)}%  ${how}`)
}
console.log(`\nIn houses: ${((houseVector / houseTotal) * 100).toFixed(1)}% of furnishings have NO pack art.`)

const noArt = rows.filter(([a]) => artFor(a).how !== 'texture').map(([a]) => a)
const withArt = rows.filter(([a]) => artFor(a).how === 'texture').map(([a]) => a)
console.log(`\nNO ART (${noArt.length}): ${noArt.join(', ')}`)
console.log(`HAS ART (${withArt.length}): ${withArt.join(', ')}`)
