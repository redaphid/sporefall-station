// Regenerates src/game/__fixtures__/mission-baseline.json for the extraction
// RNG-neutrality test (#85): 160 worlds, 30 idle ticks each, hashed. Run it
// with extraction selection switched OFF so the baseline is the pre-extraction
// world on the current code:  npx tsx scripts/test/gen-mission-baseline.mts <out.json>
import { writeFileSync } from 'node:fs'
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'
import { serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'

const fnv = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}
const out: Record<string, { template: string; hash: string }> = {}
for (let seed = 1; seed <= 20; seed++) {
  for (let floor = 1; floor <= 8; floor++) {
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    for (let i = 0; i < 30; i++) tickWorld(w, new Map([[0, emptyInput()]]))
    out[`${seed}:${floor}`] = { template: w.mission.template, hash: fnv(JSON.stringify(serializeWorld(w))) }
  }
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n')
console.log(`${Object.keys(out).length} worlds`)
