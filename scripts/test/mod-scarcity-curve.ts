// How many mods per floor? A CORE-LOOP parameter, not a drop rate.
//
// If combinations are the core mechanic, this number decides how many decisions
// a run asks the player to make. Twenty mods a floor is not a decision — you
// hold everything and combine nothing. But scarcity has a failure mode of its
// own: reaching an archetype having never been offered the thing that answers
// it. This measures that failure mode against candidate counts, so the number
// can be chosen rather than guessed.
//
//   npx tsx scripts/test/mod-scarcity-curve.ts

import { MODS } from '../../src/game/data/mods'
import { ELEMENTAL_MODS, weightedModId } from '../../src/game/systems/draft'
import { mulberry32 } from '../../src/game/rng'

const TRIALS = 20000
const CANDIDATES = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20]
const elemental = new Set<string>(ELEMENTAL_MODS)

/** Draw `n` floor mods exactly as populate does, off an independent stream. */
const drawFloor = (rng: ReturnType<typeof mulberry32>, n: number): string[] =>
  Array.from({ length: n }, () => weightedModId(rng))

console.log('The pool (rarity-weighted, as `weightedModId` draws it):')
{
  const W = { common: 6, rare: 3, legendary: 1 } as const
  const total = Object.values(MODS).reduce((s, m) => s + W[m.rarity], 0)
  const elemW = ELEMENTAL_MODS.reduce((s, id) => s + W[MODS[id].rarity], 0)
  console.log(`  ${Object.keys(MODS).length} mods, total weight ${total}`)
  console.log(`  P(a draw is elemental)          = ${elemW}/${total} = ${(elemW / total).toFixed(3)}`)
  console.log(`  P(a draw is ONE named element)  = ${W[MODS.frost.rarity]}/${total} = ${(W[MODS.frost.rarity] / total).toFixed(3)}`)
}

console.log('\n=== THE FAILURE MODE OF SCARCITY ===')
console.log('  "reached this floor having NEVER been offered an answer"')
console.log('')
console.log('mods/floor   no elemental      no elemental      no SPECIFIC counter')
console.log('             on this floor     through floor 3   through floor 3')
for (const n of CANDIDATES) {
  let noElemFloor = 0, noElemRun = 0, noSpecificRun = 0
  for (let t = 0; t < TRIALS; t++) {
    const rng = mulberry32(t * 2654435761)
    const f1 = drawFloor(rng, n)
    if (!f1.some((m) => elemental.has(m))) noElemFloor++
    const run = [...f1, ...drawFloor(rng, n), ...drawFloor(rng, n)]
    if (!run.some((m) => elemental.has(m))) noElemRun++
    if (!run.includes('incendiary')) noSpecificRun++ // the brute's actual answer
  }
  const pct = (x: number) => `${((x / TRIALS) * 100).toFixed(1)}%`.padStart(6)
  console.log(`   ${String(n).padStart(4)}         ${pct(noElemFloor)}            ${pct(noElemRun)}            ${pct(noSpecificRun)}`)
}

console.log('\n=== HOW MANY DECISIONS IS THAT? ===')
console.log('mods/floor   over a 3-floor run   reading')
const READ: Record<number, string> = {
  3: 'lean — most runs miss a specific counter',
  4: 'scarce, still reliably armed',
  5: 'a handful of real choices',
  6: 'comfortable',
  8: 'generous',
  10: 'you stop reading the labels',
  20: 'current: a pile, not a choice',
}
for (const n of [3, 4, 5, 6, 8, 10, 20]) {
  console.log(`   ${String(n).padStart(4)}              ${String(n * 3).padStart(3)}          ${READ[n]}`)
}
