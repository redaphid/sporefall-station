// Regenerate the committed exact-world-state fixtures behind the #50 feature
// videos (see e2e/feature-*.mjs). Deterministic: fixed seeds + the same scenario
// builders the app ships, so re-running is a no-op unless the entity model or a
// scenario changes (in which case these goldens are meant to update).
//
//   npx tsx scripts/test/gen-feature-fixtures.mts
//
// Each fixture is a full `serializeWorld` snapshot: `?world=<name>` in the app
// injects it verbatim before the loop starts, then a `?script=` timeline drives
// the REAL systems on top of it and the e2e harness asserts the resulting state.

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyScenario } from '../../src/game/scenarios'
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { deserializeWorld, serializeWorld, type WorldJson } from '../../src/game/serialize'
import { setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const dir = fileURLToPath(new URL('../../src/game/__fixtures__/', import.meta.url))
mkdirSync(dir, { recursive: true })

/** Mirror HostSession.buildRun: fresh floor-1 world with the local soldier. */
const buildRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
  return w
}

const write = (name: string, w: World): WorldJson => {
  const json = serializeWorld(w)
  writeFileSync(`${dir}${name}.json`, JSON.stringify(json, null, 2) + '\n')
  return json
}

/** Tick a fresh copy of a snapshot with empty input and report the tick a
 * predicate first holds — so the video script length can be sized exactly. */
const ticksUntil = (json: WorldJson, pred: (w: World) => boolean, cap = 1200): number => {
  const w = deserializeWorld(json)
  for (let i = 0; i < cap; i++) {
    if (pred(w)) return w.tick
    tickWorld(w, new Map([[0, { ...emptyInput() }]]))
  }
  return -1
}

// ── combat-stage: three frozen-in-place thugs down the pistol lane. The proven
// `shooting` script walks into range and empties the soldier's pistol into them.
const combat = buildRun(7)
applyScenario(combat, 'shooting')
const combatJson = write('combat-stage', combat)
console.log(
  `combat-stage: seed 7, ${combat.entities.filter((e) => e.archetype === 'thug').length} thugs, ` +
    `player hp ${combat.entities.find((e) => e.playerCtl)?.health?.hp}`,
)

// ── fire-stage: a lit crate row ending in a flammable bystander. No input
// needed — fire spreads down the row and burns the bystander to death while the
// player watches from the north. Lower the victim's hp so the burn lands inside
// a short, watchable clip; assert on death in the video test.
const fire = buildRun(424242)
applyScenario(fire, 'fire')
const victim = fire.entities.find((e) => e.flammable && e.archetype === 'civilian')
if (!victim?.health) throw new Error('fire scenario did not spawn a flammable civilian')
victim.health = { hp: 12, max: 12, iframes: 0 }
const fireJson = write('fire-stage', fire)
const victimDeadTick = ticksUntil(fireJson, (w) => {
  const v = w.byId.get(victim.id)
  return !v || !!v.dead || (v.health?.hp ?? 1) <= 0
})
console.log(`fire-stage: seed 424242, victim id ${victim.id} hp 12, burns to death at tick ${victimDeadTick}`)

console.log(`\nwrote combat-stage.json and fire-stage.json to ${dir}`)
