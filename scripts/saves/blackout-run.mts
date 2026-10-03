// Craft the `blackout-run` save: a dim station wing on brownout. The way out is
// a power-sealed door at the east end. The generator that feeds it sits up a
// side passage past three barracks of sleeping gang. Cutting the power opens
// the door, and it also wakes every sleeper and turns the Derelict Units in
// the east hall hostile. Sneak in, pull the plug, then run.
//
// Run: pnpm exec tsx scripts/saves/blackout-run.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { startFloorModifier } from '../../src/game/systems/modifierSystem'
import { spawnObject } from '../../src/game/systems/objects'
import { worldFromState } from '../../src/game/world'
import { arm, placeDoor, Sketch, writeSave } from './lib.mts'

const s = new Sketch(60, 27, '#')
s.room(0, 10, 9, 18, '.') // the airlock you arrive in
s.fill(9, 13, 45, 15, '%') // the spine corridor
s.room(11, 3, 21, 12, '+').fill(16, 12, 16, 12, '+') // north barracks A
s.room(23, 3, 33, 12, '+').fill(28, 12, 28, 12, '+') // north barracks B
s.room(11, 16, 21, 25, '+').fill(16, 16, 16, 16, '+') // south barracks
s.room(35, 1, 43, 8, '.') // the generator room
s.fill(38, 8, 40, 12, '%') // its passage down to the spine
s.room(45, 8, 53, 20, '%').fill(45, 13, 45, 15, '%') // the east hall
s.room(53, 10, 59, 18, '.') // the exit bay, behind the power door
s.put(53, 14, '.') // the power door's frame
s.put(3, 14, '@')
s.put(57, 14, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'pistol', [
  { id: 'choke', stacks: 1 },
  { id: 'overload', stacks: 2 },
  { id: 'incendiary', stacks: 1 },
])

const sleepers: Array<[archetype: string, x: number, y: number]> = [
  ['thug', 13.5, 5.5],
  ['thug', 19.5, 5.5],
  ['gangster', 13.5, 10.5],
  ['thug', 25.5, 5.5],
  ['gangster', 31.5, 9.5],
  ['thug', 30.5, 4.5],
  ['thug', 13.5, 23.5],
  ['gangster', 19.5, 18.5],
  ['brute', 41.5, 3.5],
]
for (const [archetype, x, y] of sleepers) {
  const e = spawnNpc(w, archetype, x, y)
  e.status!.sleep = 100000
}
for (const [tx, ty] of [
  [13, 4],
  [19, 4],
  [25, 4],
  [31, 4],
  [13, 24],
  [19, 24],
]) {
  spawnObject(w, 'bunk', tx, ty)
}

for (const [x, y] of [
  [48.5, 10.5],
  [50.5, 17.5],
  [51.5, 13.5],
]) {
  const robot = spawnNpc(w, 'robot', x, y)
  robot.ai!.guard = true
}

const generator = spawnObject(w, 'generator', 38, 3)
generator.wing = 'east'
placeDoor(w, 53, 14, { locked: true, lockLevel: 3, sealKind: 'power', wing: 'east' })

startFloorModifier(w, 'brownout')
w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Cut the power, reach the exit bay' }

writeSave('blackout-run', w)
