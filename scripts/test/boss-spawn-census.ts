// Empirical boss census: does the Mireclaw Alpha actually spawn, and how often?
// Builds each floor exactly the way a real run does (createWorld → populateWorld
// → setupFloor) across many seeds, and counts boss entities + mission templates.
// Deterministic: pure seed+floor, no wall-clock.
//
//   npx tsx scripts/test/boss-spawn-census.ts [seeds] [maxFloor]

import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'

const SEEDS = Number(process.argv[2] ?? 200)
const MAX_FLOOR = Number(process.argv[3] ?? 20)

interface Row {
  floor: number
  bosses: number
  floorsWithBoss: number
  templates: Record<string, number>
}

const rows: Row[] = []
// Per-seed: how many forced boss kills does reaching floor 13 imply?
const bossFloorsBySeed: number[] = []

for (let floor = 1; floor <= MAX_FLOOR; floor++) {
  const row: Row = { floor, bosses: 0, floorsWithBoss: 0, templates: {} }
  for (let s = 0; s < SEEDS; s++) {
    const w = createWorld(1000 + s, floor)
    populateWorld(w)
    setupFloor(w)
    const n = w.entities.filter((e) => e.archetype === 'boss' && !e.dead).length
    row.bosses += n
    if (n > 0) row.floorsWithBoss++
    row.templates[w.mission.template] = (row.templates[w.mission.template] ?? 0) + 1
  }
  rows.push(row)
}

// Forced-kill count: a boss floor cannot be left without killing the boss
// (missionSystem only unlocks the exit on target death), so every boss floor a
// player passed through is a boss they personally killed.
for (let s = 0; s < SEEDS; s++) {
  let n = 0
  for (let floor = 1; floor <= 12; floor++) {
    const w = createWorld(1000 + s, floor)
    populateWorld(w)
    setupFloor(w)
    if (w.entities.some((e) => e.archetype === 'boss' && !e.dead)) n++
  }
  bossFloorsBySeed.push(n)
}

console.log(`seeds=${SEEDS} floors=1..${MAX_FLOOR}`)
console.log('floor  bosses  floorsWithBoss  %  templates')
for (const r of rows) {
  const pct = ((r.floorsWithBoss / SEEDS) * 100).toFixed(1)
  const t = Object.entries(r.templates)
    .sort()
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')
  console.log(`${String(r.floor).padStart(5)}  ${String(r.bosses).padStart(6)}  ${String(r.floorsWithBoss).padStart(14)}  ${pct.padStart(5)}  ${t}`)
}

const total = rows.reduce((a, r) => a + r.bosses, 0)
console.log(`\nTOTAL bosses spawned across ${SEEDS * MAX_FLOOR} generated floors: ${total}`)

const sum = bossFloorsBySeed.reduce((a, b) => a + b, 0)
const min = Math.min(...bossFloorsBySeed)
const max = Math.max(...bossFloorsBySeed)
console.log(
  `Forced boss kills to reach floor 13 (floors 1-12): mean ${(sum / SEEDS).toFixed(2)}, min ${min}, max ${max}`,
)
const zero = bossFloorsBySeed.filter((n) => n === 0).length
console.log(`Seeds where a floor-13 player met ZERO bosses: ${zero}/${SEEDS} (${((zero / SEEDS) * 100).toFixed(1)}%)`)
