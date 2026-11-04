// Run the card-night save under its `card-night` input script (the one the
// e2e recording plays) and print the activity, hit and flee beats.
//   npx tsx scripts/test/card-night-probe.mts
import { readFileSync } from 'node:fs'
import { deserializeWorld, type WorldJson } from '../../src/game/serialize'
import { tickWorld } from '../../src/game/world'
import { createScriptedInput, SCRIPTS, scriptTicks } from '../../src/input/scripted'

const w = deserializeWorld(
  JSON.parse(readFileSync(new URL('../../src/game/__fixtures__/card-night.json', import.meta.url), 'utf8')) as WorldJson,
)
const steps = SCRIPTS['card-night']
const input = createScriptedInput(steps)
for (let i = 0; i < scriptTicks(steps); i++) {
  tickWorld(w, new Map([[0, input.sample()]]))
  for (const e of w.events) {
    if (e.type === 'activity' || e.type === 'hit' || (e.type === 'aiGoal' && e.goal === 'flee'))
      console.log(`t${w.tick} (${(w.tick / 30).toFixed(1)}s)`, JSON.stringify(e))
  }
}
const p = w.entities.find((e) => e.playerCtl)!
console.log('player at', p.pos.x.toFixed(2), p.pos.y.toFixed(2))
