// Craft the `barracks-blaze` save: a feral barracks asleep in rows of bunks,
// with crates stacked between them and fuel barrels along the back wall. The
// player stands in the west doorway with an incendiary pistol. Fire spreads
// bunk to bunk; a burning sleeper wakes, panics, and carries the fire into
// whatever it runs past; the barrels go up together.
//
// Run: pnpm exec tsx scripts/saves/barracks-blaze.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { spawnObject } from '../../src/game/systems/objects'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 44
const H = 26
const s = new Sketch(W, H, '#')
s.room(0, 9, 8, 16, '-') // the yard outside
s.room(8, 2, W - 1, H - 3, '+') // the barracks
s.fill(8, 12, 8, 13, '+') // its west doors
s.room(W - 8, 9, W - 1, 16, '.').fill(W - 8, 12, W - 8, 13, '.') // the armoury, east
s.put(3, 12, '@')
s.put(W - 3, 12, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'pistol', [
  { id: 'incendiary', stacks: 1 },
  { id: 'velocity', stacks: 1 },
  { id: 'choke', stacks: 1 },
])

// Two bunk rows along each long wall, a crate run down the middle.
for (let x = 11; x <= 33; x++) {
  spawnObject(w, 'bunk', x, 4)
  spawnObject(w, 'bunk', x, H - 6)
  if (x % 2 === 1) spawnObject(w, 'crate', x, 12)
}
for (let y = 5; y <= 8; y++) spawnObject(w, 'barrel', 34, y)
for (let y = 17; y <= 20; y++) spawnObject(w, 'barrel', 34, y)

// Asleep in their bunks, two awake on watch by the crate run.
const sleepers: Array<[archetype: string, x: number, y: number]> = [
  ['mutant', 13.5, 4.5],
  ['mutant', 18.5, 4.5],
  ['acolyte', 23.5, 4.5],
  ['mutant', 28.5, 4.5],
  ['mutant', 15.5, 20.5],
  ['acolyte', 20.5, 20.5],
  ['mutant', 25.5, 20.5],
  ['brute', 31.5, 20.5],
]
for (const [archetype, x, y] of sleepers) spawnNpc(w, archetype, x, y).status!.sleep = 100000
spawnNpc(w, 'acolyte', 30.5, 10.5)
spawnNpc(w, 'mutant', 22.5, 14.5)

w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Burn the barracks, reach the armoury' }

writeSave('barracks-blaze', w)
