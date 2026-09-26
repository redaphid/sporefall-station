/**
 * fireSystem and full-tick cost on the busiest floor among a few seeds, in two
 * states: CALM (no fire anywhere) and BLAZE (a fire under every NPC, player and
 * flammable prop). Every rep restarts from the same snapshot, so two checkouts
 * compare like for like.
 *
 * Run: npx tsx scripts/test/fire-tick-bench.mts
 */
import { spawnPlayer } from '../../src/game/player'
import { populateWorld } from '../../src/game/populate'
import { deserializeWorld, serializeWorld, type WorldJson } from '../../src/game/serialize'
import { fireSystem, igniteCell } from '../../src/game/systems/fire'
import { nextFloor, setupFloor } from '../../src/game/systems/missions'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const PLAYERS = 4
const FIRE_CALLS = 300
const TICKS = 300
const REPS = 15

const build = (seed: number, floor: number): World => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w)
  setupFloor(w)
  for (let s = 0; s < PLAYERS; s++) spawnPlayer(w, s, w.level.spawn.x + s * 0.6, w.level.spawn.y)
  while (w.floor < floor) nextFloor(w)
  return w
}

const census = (w: World) => ({
  entities: w.entities.filter((e) => !e.dead).length,
  npcs: w.entities.filter((e) => !e.dead && e.ai).length,
  players: w.entities.filter((e) => !e.dead && e.playerCtl).length,
  flammables: w.entities.filter((e) => !e.dead && e.flammable).length,
  fires: w.entities.filter((e) => !e.dead && e.fire).length,
})

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const fireCallUs = (snap: WorldJson): number => {
  const w = deserializeWorld(snap)
  const t0 = performance.now()
  for (let i = 0; i < FIRE_CALLS; i++) {
    w.tick++
    fireSystem(w)
  }
  return ((performance.now() - t0) / FIRE_CALLS) * 1000
}

const tickMs = (snap: WorldJson): number => {
  const w = deserializeWorld(snap)
  const inputs = new Map(Array.from({ length: PLAYERS }, (_, s) => [s, emptyInput()]))
  const t0 = performance.now()
  for (let i = 0; i < TICKS; i++) tickWorld(w, inputs)
  return (performance.now() - t0) / TICKS
}

let busiest: { seed: number; floor: number; w: World } | undefined
for (const seed of [1234, 42, 20260808, 31337]) {
  for (const floor of [1, 2, 3]) {
    const w = build(seed, floor)
    if (!busiest || census(w).entities > census(busiest.w).entities) busiest = { seed, floor, w }
  }
}
const { seed, floor, w } = busiest!
const calm = serializeWorld(w)
for (const e of w.entities) {
  if (e.dead || !(e.ai || e.playerCtl || e.flammable)) continue
  igniteCell(w, Math.floor(e.pos.x), Math.floor(e.pos.y))
}
const blaze = serializeWorld(w)

console.log(`seed ${seed} floor ${floor}`)
for (const [name, snap] of [['calm', calm], ['blaze', blaze]] as [string, WorldJson][]) {
  const c = census(deserializeWorld(snap))
  fireCallUs(snap)
  tickMs(snap)
  const us = median(Array.from({ length: REPS }, () => fireCallUs(snap)))
  const ms = median(Array.from({ length: REPS }, () => tickMs(snap)))
  console.log(
    `${name.padEnd(5)} ${JSON.stringify(c)} fireSystem=${us.toFixed(2)}us/call tick=${ms.toFixed(3)}ms (${(1000 / ms).toFixed(0)} ticks/s)`,
  )
}
