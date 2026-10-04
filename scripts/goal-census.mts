// Goal-churn census over real worlds: every crafted scene plus generated city
// and station floors, each run for --seconds with idle players. Prints one
// markdown table (src/debug/goalCensus.ts defines the metrics).
//
//   npx tsx scripts/goal-census.mts [--seconds 90] [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { censusRows, renderRows, traceGoals, type CensusRow, type GoalTrace } from '../src/debug/goalCensus'
import { spawnPlayer } from '../src/game/player'
import { populateWorld } from '../src/game/populate'
import { deserializeWorld, type WorldJson } from '../src/game/serialize'
import { playerSpawnPoint } from '../src/game/spawnPlacement'
import { setupFloor } from '../src/game/systems/missions'
import { SIM_RATE } from '../src/game/types'
import { createWorld, type World } from '../src/game/world'
import { SCENES } from '../src/scenes/registry'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args[i + 1]
}
const seconds = Number(flag('seconds') ?? 90)
const ticks = seconds * SIM_RATE

const fixture = (name: string): World =>
  deserializeWorld(
    JSON.parse(readFileSync(fileURLToPath(new URL(`../src/game/__fixtures__/${name}.json`, import.meta.url)), 'utf8')) as WorldJson,
  )

const generated = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  return w
}

const runs: [string, () => World][] = [
  ...SCENES.map((s): [string, () => World] => [`scene:${s.name}`, () => fixture(s.name)]),
  ...[11, 23, 47, 5, 88].map((seed): [string, () => World] => [`city:${seed}/f1`, () => generated(seed, 1)]),
  ...[11, 23, 47, 5, 88].map((seed): [string, () => World] => [`station:${seed}/f3`, () => generated(seed, 3)]),
]

const all: GoalTrace[] = []
const scenes: GoalTrace[] = []
const floors: GoalTrace[] = []
const perRun: CensusRow[] = []
const sessions: Record<string, number> = {}
for (const [label, make] of runs) {
  const traces = traceGoals(make(), ticks, { sessions })
  all.push(...traces)
  ;(label.startsWith('scene:') ? scenes : floors).push(...traces)
  perRun.push(censusRows(label, traces)[0])
  process.stderr.write(`goal-census: ${label} (${traces.length} NPCs)\n`)
}

const totals = [...censusRows('ALL', all), ...censusRows('scenes', scenes), ...censusRows('floors', floors)]
console.log(`Goal census, ${seconds} s per world, idle players. Sessions started: ${JSON.stringify(sessions)}.\n`)
console.log(renderRows(totals))
console.log('\nPer world:\n')
console.log(renderRows(perRun))
console.log('\nTop switches (ALL):', JSON.stringify(totals[0].topSwitches))
const out = flag('json')
if (out) writeFileSync(out, JSON.stringify({ seconds, sessions, totals, perRun }, null, 2))
