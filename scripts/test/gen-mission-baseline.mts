// Regenerates src/game/__fixtures__/mission-baseline.json for the extraction
// RNG-neutrality test (#85): 40 seeded city worlds (floors 1-2) plus the
// frozen-level fixtures standing in for deeper floors, 30 idle ticks each,
// hashed. Run it with extraction selection switched OFF so the baseline is the
// pre-extraction world on the current code:  npx tsx scripts/test/gen-mission-baseline.mts <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { populateWorld } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, worldFromState, type World } from '../../src/game/world'
import { generateCityLevel } from '../../src/game/levelgen/generate'
import { deserializeWorld, serializeWorld, type WorldJson } from '../../src/game/serialize'
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
const record = (key: string, w: World): void => {
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  for (let i = 0; i < 30; i++) tickWorld(w, new Map([[0, emptyInput()]]))
  out[key] = { template: w.mission.template, hash: fnv(JSON.stringify(serializeWorld(w))) }
}
// Floor 2 replays the city generator's slums: play now draws floor 2's district.
for (let seed = 1; seed <= 20; seed++) {
  record(`${seed}:1`, createWorld(seed, 1))
  record(`${seed}:2`, worldFromState({ level: generateCityLevel(seed, 2), seed, floor: 2 }))
}
for (const name of ['frozen-1-3', 'frozen-3-3', 'frozen-10-3', 'frozen-2-4', 'frozen-1003-3', 'frozen-42-5', 'frozen-9-4']) record(name, deserializeWorld(JSON.parse(readFileSync(`src/game/__fixtures__/${name}.json`, 'utf8')) as WorldJson))
writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n')
console.log(`${Object.keys(out).length} worlds`)
