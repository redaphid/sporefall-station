// Headless playtest: one world per state file, one verb per call. No browser, no
// hub, deterministic, and safe to run in parallel (each agent owns its file).
//
//   npx tsx scripts/playtest.mts <state.json> new [--seed N] [--scenario NAME] [--floor F] [--sequenced] [--wandReactions]
//   npx tsx scripts/playtest.mts <state.json> look [radius]
//   npx tsx scripts/playtest.mts <state.json> step 30 '{"aimAt":42,"attack":true}'
//   npx tsx scripts/playtest.mts <state.json> <any debug verb line>   (spawn, addMod, get, entities, …)
//
// Each call loads the WorldJson (PRNG position included), runs the verb through
// the same dispatcher as `sporefall.verb`, prints its reply, and writes the world
// back. Splitting a run across calls is byte-identical to running it in one go.
import { readFileSync, writeFileSync } from 'node:fs'
import { HostSession } from '../src/app/hostSession'
import { runVerb } from '../src/debug/verbs'
import { applyScenario, isKnownScenario, SCENARIO_NAMES } from '../src/game/scenarios'
import { deserializeWorld, serializeWorld, type WorldJson } from '../src/game/serialize'
import { emptyInput } from '../src/game/types'

const [file, verb, ...rest] = process.argv.slice(2)
if (!file || !verb) {
  console.error('usage: playtest.mts <state.json> new [--seed N] [--scenario NAME] [--floor F] [--sequenced] [--wandReactions] | <verb line>')
  process.exit(2)
}

const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}

if (verb === 'new') {
  const seed = Number(flag('seed') ?? 1)
  const scenario = flag('scenario')
  if (scenario && !isKnownScenario(scenario)) {
    console.error(`unknown scenario "${scenario}"; known: ${SCENARIO_NAMES.join(', ')}`)
    process.exit(2)
  }
  // A typo'd switch must not quietly hand back a default-rules run.
  const known = new Set(['--seed', '--scenario', '--floor', '--sequenced', '--wandReactions'])
  const unknown = rest.filter((a) => a.startsWith('--') && !known.has(a))
  if (unknown.length) {
    console.error(`unknown option ${unknown.join(' ')}; known: ${[...known].join(' ')}`)
    process.exit(2)
  }
  // The same run rule main.ts latches from the feature flags: wandReactions wins
  // over sequencedMods, because reactive wands ARE sequenced casting plus more.
  const casting = rest.includes('--wandReactions') ? 'reactive' : rest.includes('--sequenced') ? 'sequence' : undefined
  const host = new HostSession(seed, { sample: emptyInput }, undefined, 'normal', casting)
  if (scenario) applyScenario(host.world, scenario, { floor: Number(flag('floor')) || undefined })
  writeFileSync(file, JSON.stringify(serializeWorld(host.world)))
  console.log(runVerb(host.world, 'look'))
} else {
  const w = deserializeWorld(JSON.parse(readFileSync(file, 'utf8')) as WorldJson)
  const reply = runVerb(w, [verb, ...rest].join(' '))
  writeFileSync(file, JSON.stringify(serializeWorld(w)))
  console.log(reply)
}
