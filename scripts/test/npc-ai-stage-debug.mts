// Headless replica of the npc-ai e2e stage: same seed, same scenario, same
// scripted timeline — logs the cast's decisions so the choreography can be
// tuned without a browser.
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { applyScenario } from '../../src/game/scenarios'
import { createScriptedInput, SCRIPTS, scriptTicks } from '../../src/input/scripted'
import { createWorld, tickWorld } from '../../src/game/world'

const w = createWorld(20260718, 1, 'normal')
populateWorld(w)
spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
applyScenario(w, 'npc-ai')
const input = createScriptedInput(SCRIPTS['npc-ai'])
const total = scriptTicks(SCRIPTS['npc-ai'])
const player = w.entities.find((e) => e.playerCtl)!
const cast = () => w.entities.filter((e) => e.kind === 'npc' && e.ai)
for (let t = 0; t < total; t++) {
  tickWorld(w, new Map([[0, input.sample()]]))
  for (const ev of w.events) if (ev.type === 'aiGoal' || ev.type === 'alerted' || ev.type === 'hit') console.log(w.tick, 'EV', JSON.stringify(ev))
  if (w.tick % 30 === 0) {
    const rows = cast().map((e) => `${e.archetype}#${e.id}(${e.ai!.behavior ?? 'basic'}) ${e.ai!.goal ?? '-'}/${e.ai!.mode} tgt=${e.ai!.targetId ?? '-'} @${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)}${e.ai!.search ? ' S' + e.ai!.search.left : ''}${e.ai!.alerted !== undefined ? ' ALERTED' : ''}${e.ai!.stash ? ' stash=' + e.ai!.stash.length : ''}`)
    console.log(w.tick, `P@${player.pos.x.toFixed(1)},${player.pos.y.toFixed(1)} hp=${player.health!.hp}`, '|', rows.join(' | '))
  }
}
