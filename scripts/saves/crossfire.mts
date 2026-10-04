// Craft the `crossfire` save: a market plaza on a neutral floor. A rootcult crew
// holds the north arcade and a warden line walks its beat up from the south.
// They are sworn enemies and open fire on sight. Shoppers scatter, the lockkeeper
// guards his door, and nobody is after the player until the player gives them a
// reason. Shoot a bystander and the wardens turn on you too.
//
// Run: pnpm exec tsx scripts/saves/crossfire.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { assignPatrol, spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { spawnObject } from '../../src/game/systems/objects'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 46
const H = 36
const s = new Sketch(W, H, '#')
s.fill(1, 1, W - 2, H - 2, '-')
s.fill(6, 8, W - 7, H - 9, '+') // the plaza
s.fill(19, 15, 26, 20, ',') // the green at its heart
// North arcade: a colonnade the rootcult shoots from.
s.fill(4, 3, W - 5, 3, '#')
for (let x = 6; x < W - 6; x += 5) s.fill(x, 5, x, 6, '#')
// South: the warden barricade line, with gaps.
for (let x = 7; x < W - 7; x += 6) s.fill(x, H - 7, x + 2, H - 7, '#')
// East: the club, its door on the plaza.
s.room(W - 9, 12, W - 2, 23, '.').put(W - 9, 17, '.').put(W - 9, 18, '.')
s.put(3, 17, '@')
s.put(1, 2, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }), hostile: false })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'shotgun', [
  { id: 'choke', stacks: 1 },
  { id: 'heavy', stacks: 1 },
])

const cast: Array<[archetype: string, x: number, y: number]> = [
  ['acolyte', 10.5, 9.5],
  ['acolyte', 20.5, 8.5],
  ['acolyte', 30.5, 9.5],
  ['mutant', 15.5, 10.5],
  ['mutant', 25.5, 10.5],
  ['mutant', 35.5, 10.5],
  ['civilian', 14.5, 14.5],
  ['civilian', 22.5, 13.5],
  ['civilian', 30.5, 16.5],
  ['civilian', 17.5, 22.5],
  ['scientist', 27.5, 21.5],
  ['shopkeeper', 11.5, 18.5],
  ['lockkeeper', W - 10.5, 17.5],
]
for (const [archetype, x, y] of cast) spawnNpc(w, archetype, x, y)
// The warden line walks its beat up into the plaza, straight at the arcade.
for (const x of [10.5, 16.5, 22.5, 28.5, 34.5]) {
  assignPatrol(spawnNpc(w, 'warden', x, 30.5), [
    { x, y: 30.5 },
    { x, y: 14.5 },
  ])
}
for (const [tx, ty] of [
  [11, 17],
  [12, 19],
  [33, 12],
  [34, 22],
]) {
  spawnObject(w, 'crate', tx, ty)
}
spawnObject(w, 'vending', 8, 10)
spawnObject(w, 'barrel', 22, 26)
spawnObject(w, 'barrel', 23, 26)

w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Survive the crossfire' }

writeSave('crossfire', w)
