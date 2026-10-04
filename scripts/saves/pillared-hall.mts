// Craft the `pillared-hall` save: a long colonnade, eight 2x2 pillars in two
// rows, hunters and stalkers waiting among them. The player's pistol bounces
// and homes, so a shot banked off a pillar finds the gunman behind it.
//
// Run: pnpm exec tsx scripts/saves/pillared-hall.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 50
const H = 24
const s = new Sketch(W, H, '#')
// Antechamber (west), the hall, and the exit alcove (east).
s.room(0, 8, 8, 15, '.')
s.room(8, 2, 44, 21, '+')
s.room(44, 9, 49, 14, '.')
s.fill(8, 10, 8, 13, '.') // the hall's west arch
s.fill(44, 10, 44, 13, '+') // the east arch
for (const px of [13, 20, 27, 34]) {
  for (const py of [6, 16]) s.fill(px, py, px + 1, py + 1, '#')
}
s.fill(39, 10, 40, 13, '#') // a screen wall in front of the east arch
s.put(47, 11, 'E')
s.put(3, 11, '@')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'pistol', [
  { id: 'bounce', stacks: 2 },
  { id: 'homing', stacks: 1 },
  { id: 'velocity', stacks: 1 },
])

const cast: Array<[archetype: string, x: number, y: number]> = [
  ['gangster', 16.5, 4.5],
  ['gangster', 23.5, 19.5],
  ['gangster', 30.5, 4.5],
  ['gangster', 37.5, 19.5],
  ['stalker', 22.5, 7.5],
  ['stalker', 36.5, 16.5],
  ['thug', 29.5, 11.5],
  ['cinder', 42.5, 6.5],
  ['gangster', 42.5, 18.5],
  ['gangster', 17.5, 12.5],
  ['brute', 41.5, 11.5],
]
for (const [archetype, x, y] of cast) spawnNpc(w, archetype, x, y)

w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Cross the pillared hall' }

writeSave('pillared-hall', w)
