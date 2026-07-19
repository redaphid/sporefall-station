// Regenerate src/game/__fixtures__/bunker-heist.json — the previously-blocked
// bunker mission (seed 7 floor 3, steal-the-briefcase, objective behind three
// locked doors) with the player staged on the street east of the airlock.
// Backs the lockpick-progression e2e video. Deterministic: same output always.
// Usage: pnpm exec tsx scripts/test/gen-bunker-heist-fixture.mts
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { serializeWorld } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'

const w = createWorld(7, 3)
populateWorld(w)
setupFloor(w)
// Stage the player just east of the bunker airlock (outer door at 40.5,53.5) —
// the walk across the whole city is not what this fixture demonstrates.
const p = spawnPlayer(w, 0, 43.7, 53.5)
p.facing = Math.PI // facing the door

// Night infiltration staging: everyone in the district is ASLEEP (the real
// sleep status — damage still wakes them), so the recording demonstrates the
// DOOR mechanics — prompt, pick channel, breach — not an ambient brawl.
for (const e of w.entities) {
  if (!e.ai || e.dead) continue
  e.status ??= { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.status.sleep = 100_000
}

const out = join(dirname(fileURLToPath(import.meta.url)), '../../src/game/__fixtures__/bunker-heist.json')
writeFileSync(out, JSON.stringify(serializeWorld(w), null, 2) + '\n')
console.log('wrote', out, `(${w.entities.length} entities, mission: ${w.mission.description})`)
