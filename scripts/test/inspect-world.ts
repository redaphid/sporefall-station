// Headless world inspector — the "real JS debugger attach" entry point (#49).
//
// Loads a WorldJson snapshot (from the `dump` verb / serialize.ts) into a live,
// standalone world, runs N deterministic ticks with neutral input, and prints
// the resulting schema + state. Nothing here touches render/input/net, so it is
// a clean place to set BREAKPOINTS in the pure sim (systems, RNG, serialize).
//
// Run it:
//   npx tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
//   npx tsx scripts/test/inspect-world.ts --new 20260715 1 30
//
// Debug it (Chrome DevTools / VS Code — breakpoints, step, inspect `world`):
//   node --inspect-brk --import tsx scripts/test/inspect-world.ts src/game/__fixtures__/mid-run.json 30
//   → open chrome://inspect, click "inspect"; execution pauses at the `debugger`
//     line below with `world` already loaded. Set breakpoints in src/game/** and
//     resume; each `tickWorld` call runs the whole sim step under the debugger.

import { readFileSync } from 'node:fs'
import { serializeWorld, deserializeWorld, type WorldJson } from '../../src/game/serialize'
import { runVerb } from '../../src/debug/verbs'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const args = process.argv.slice(2)

const loadWorld = (): { world: World; ticks: number } => {
  if (args[0] === '--new') {
    const seed = Number(args[1])
    const floor = Number(args[2] ?? 1)
    if (!Number.isFinite(seed)) throw new Error('usage: inspect-world --new <seed> <floor> [ticks]')
    return { world: createWorld(seed, floor), ticks: Number(args[3] ?? 0) }
  }
  const file = args[0]
  if (!file) {
    console.error('usage: inspect-world <world.json> [ticks]   |   inspect-world --new <seed> <floor> [ticks]')
    process.exit(2)
  }
  const json = JSON.parse(readFileSync(file, 'utf8')) as WorldJson
  return { world: deserializeWorld(json), ticks: Number(args[1] ?? 0) }
}

const { world, ticks } = loadWorld()

// eslint-disable-next-line no-debugger
debugger // ← first pause under --inspect-brk: `world` is loaded, nothing stepped yet.

console.log(`[inspect] loaded world: seed=${world.seed} floor=${world.floor} tick=${world.tick} entities=${world.entities.length}`)
console.log(`[inspect] schema:\n${runVerb(world, 'schema')}`)

for (let i = 0; i < ticks; i++) tickWorld(world, new Map())

console.log(`[inspect] after ${ticks} tick(s): ${runVerb(world, 'state')}`)
console.log(`[inspect] final snapshot bytes: ${JSON.stringify(serializeWorld(world)).length}`)
