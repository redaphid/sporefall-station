// Headless rehearsal of the `bunker-heist` script against the bunker-heist
// fixture: same world, same per-tick inputs the browser run will use — prints
// every notable event so the choreography can be tuned WITHOUT recording video.
// Usage: pnpm exec tsx scripts/test/bunker-heist-dryrun.ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tickWorld } from '../../src/game/world' // FIRST: breaks the world↔ai↔goals import cycle under tsx
import { deserializeWorld } from '../../src/game/serialize'
import type { WorldJson } from '../../src/game/serialize'
import { createScriptedInput, SCRIPTS, scriptTicks } from '../../src/input/scripted'

const here = dirname(fileURLToPath(import.meta.url))
const json = JSON.parse(readFileSync(join(here, '../../src/game/__fixtures__/bunker-heist.json'), 'utf8')) as WorldJson
const w = deserializeWorld(json)
const src = createScriptedInput(SCRIPTS['bunker-heist'])
const total = scriptTicks(SCRIPTS['bunker-heist'])
const p = w.entities.find((e) => e.playerCtl)!

for (let t = 0; t < total + 30; t++) {
  tickWorld(w, new Map([[0, src.sample()]]))
  for (const ev of w.events) {
    if (['doorToggle', 'pickStart', 'pickCancel', 'doorBreach', 'pickup', 'missionComplete', 'explosion', 'death'].includes(ev.type)) {
      console.log(`t=${w.tick}`, JSON.stringify(ev), `| p=(${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)}) hp=${p.health!.hp}`)
    }
  }
  if (t % 60 === 0) console.log(`t=${w.tick} p=(${p.pos.x.toFixed(2)},${p.pos.y.toFixed(2)}) hp=${p.health!.hp} downed=${!!p.playerCtl!.downed}`)
}
console.log('END:', {
  missionComplete: w.mission.complete,
  exitUnlocked: w.mission.exitUnlocked,
  hp: p.health!.hp,
  downed: !!p.playerCtl!.downed,
  briefcase: p.playerCtl!.inventory.some((s) => s.itemId === 'briefcase'),
})
