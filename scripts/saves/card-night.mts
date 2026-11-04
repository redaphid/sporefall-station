// Craft the `card-night` save: the settlers' mess on a quiet shift. Two card
// tables with chairs round them, a row of lab benches, bunks in the back, and a
// handful of settlers with nothing urgent to do. They drift to the tables, sit,
// and deal once enough seats fill; a game ends for the whole table at once.
// Nobody here is hostile. Hurt one of them and the table breaks up and runs.
//
// Run: pnpm exec tsx scripts/saves/card-night.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { spawnObject } from '../../src/game/systems/objects'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 30
const H = 20
const s = new Sketch(W, H, '#')
s.room(0, 0, W - 1, H - 1, '+') // the mess, tiled
s.room(0, 0, 9, 7, '.') // the bunk room, north-west
s.put(9, 4, '.').put(9, 5, '.') // its doorway into the mess
s.put(15, H - 2, '@') // the player comes in at the south wall
s.put(15, H - 1, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }), hostile: false })
arm(spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y), 'pistol', [])

// Two tables, four chairs round each, every chair turned to its table.
for (const [tx, ty] of [
  [14, 6],
  [22, 6],
]) {
  spawnObject(w, 'table', tx, ty)
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ]) {
    const chair = spawnObject(w, 'chair', tx + dx, ty + dy)
    chair.facing = Math.atan2(-dy, -dx)
  }
}
// Lab benches along the east wall, bunks in the back room.
for (const ty of [11, 13, 15]) spawnObject(w, 'bench', W - 3, ty)
for (const [tx, ty] of [
  [2, 2],
  [5, 2],
  [2, 5],
]) {
  spawnObject(w, 'bunk', tx, ty)
}

const cast: Array<[archetype: string, x: number, y: number]> = [
  ['civilian', 12.5, 12.5],
  ['civilian', 17.5, 13.5],
  ['scientist', 20.5, 11.5],
  ['civilian', 24.5, 13.5],
  ['shopkeeper', 10.5, 10.5],
  ['scientist', 26.5, 16.5],
  ['civilian', 6.5, 12.5],
]
for (const [archetype, x, y] of cast) spawnNpc(w, archetype, x, y)

w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Leave them to their game' }

writeSave('card-night', w)
