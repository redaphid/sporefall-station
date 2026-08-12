// How often does a run actually get offered the counter to what it is fighting?
//
// This is the number behind the "mods at 60% of floor loot vs 100%" question.
// If mods carry the rock-paper-scissors, then MOD AVAILABILITY is a core balance
// parameter, not a loot-mix preference: it sets how often the player can answer
// the enemy in front of them.
//
// IMPORTANT: the per-floor DRAFT (`floorDraftOffer`, which guarantees an
// elemental in every hand) is only ever wired up under `?e2e` in main.ts — it
// never fires in normal play. So in a real run the ONLY source of mods is what
// is lying on the floor, which is what this probe counts.
//
//   npx tsx scripts/test/mod-access-probe.ts

import { MODS } from '../../src/game/data/mods'
import { ELEMENTAL_MODS } from '../../src/game/systems/draft'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'

const RUNS = 400
const FLOORS = [1, 2, 3, 4, 5]
const elemental = new Set<string>(ELEMENTAL_MODS)

/** Mod ids lying on the floor of a freshly generated (seed, floor). */
const floorMods = (seed: number, floor: number): string[] => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  return w.entities
    .filter((e) => !e.dead && e.pickup && MODS[e.pickup.itemId])
    .map((e) => e.pickup!.itemId)
}

console.log(`Floor-pickup mod access over ${RUNS} seeds. The draft never fires in normal play,`)
console.log('so these are the only mods a real run can ever obtain.\n')
console.log('floor   avg mods/floor   floors with >=1 mod   floors with >=1 ELEMENTAL')
for (const floor of FLOORS) {
  let total = 0, anyMod = 0, anyElem = 0
  for (let s = 0; s < RUNS; s++) {
    const mods = floorMods(1000 + s, floor)
    total += mods.length
    if (mods.length) anyMod++
    if (mods.some((m) => elemental.has(m))) anyElem++
  }
  console.log(
    `  ${floor}         ${(total / RUNS).toFixed(2)}              ${((anyMod / RUNS) * 100).toFixed(1)}%                  ${((anyElem / RUNS) * 100).toFixed(1)}%`,
  )
}

// Cumulative: by the time you have cleared floors 1..N, have you EVER seen an
// elemental? This is the "reached a brute with no answer" risk.
console.log('\nCumulative across a run (same seed, floors 1..N):')
console.log('through floor   runs that have seen >=1 elemental')
for (const upto of FLOORS) {
  let seen = 0
  for (let s = 0; s < RUNS; s++) {
    let ok = false
    for (let f = 1; f <= upto; f++) {
      if (floorMods(1000 + s, f).some((m) => elemental.has(m))) { ok = true; break }
    }
    if (ok) seen++
  }
  console.log(`      ${upto}                  ${((seen / RUNS) * 100).toFixed(1)}%`)
}
