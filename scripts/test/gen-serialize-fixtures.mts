// Regenerate the committed JSON world fixtures used by `serialize.test.ts`.
// Run: npx tsx scripts/test/gen-serialize-fixtures.mts
// Deterministic: fixed seed + fixed inputs, so re-running is a no-op unless the
// entity model or sim changes (in which case the goldens are meant to update).

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { deserializeWorld, serializeWorld } from '../../src/game/serialize'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const SEED = 20260715

// Same shape as testkit.runTicks — kept inline so this script has no test deps.
const runTicks = (w: World, inputs: Map<number, InputCmd>, n: number): void => {
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([...inputs].map(([slot, cmd]) => [slot, { ...emptyInput(), ...cmd }])))
  }
}

// The action the golden test replays. Keep in sync with serialize.test.ts.
const DRIVE = new Map<number, InputCmd>([[0, { ...emptyInput(), moveX: -1, attack: true }]])

const buildMidRun = (): World => {
  const w = createWorld(SEED, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, 'soldier', sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  runTicks(w, DRIVE, 30) // drive some AI/combat so the sim RNG has really advanced
  return w
}

const dir = fileURLToPath(new URL('../../src/game/__fixtures__/', import.meta.url))
mkdirSync(dir, { recursive: true })

const midRun = buildMidRun()
writeFileSync(`${dir}mid-run.json`, JSON.stringify(serializeWorld(midRun), null, 2) + '\n')

// The golden "after" state: reload the snapshot and apply the action.
const acted = deserializeWorld(serializeWorld(midRun))
runTicks(acted, DRIVE, 10)
writeFileSync(`${dir}mid-run-plus-10.json`, JSON.stringify(serializeWorld(acted), null, 2) + '\n')

console.log('wrote mid-run.json and mid-run-plus-10.json to', dir)
