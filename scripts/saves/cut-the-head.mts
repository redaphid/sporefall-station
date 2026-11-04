// Craft the `cut-the-head` save: a walled bog courtyard with broken cover, and a
// staging raid gathering at the north end around its Bellwether. The raid is
// brave while the bell rings; drop the Bellwether and the rest rout.
//
// Run: pnpm exec tsx scripts/saves/cut-the-head.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnPlayer } from '../../src/game/player'
import { spawnRaid } from '../../src/game/systems/groups'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 40
const H = 36
const s = new Sketch(W, H, '#')
s.room(0, 0, W - 1, H - 1, ',')
s.fill(3, 3, W - 4, H - 4, '.')
// Bog pools the raid has to wade around.
s.fill(6, 12, 11, 16, '~').fill(28, 18, 33, 22, '~').fill(17, 8, 22, 9, '~')
// Broken low walls: cover for both sides.
for (const [x, y, len] of [
  [6, 24, 5],
  [16, 21, 3],
  [25, 26, 5],
  [12, 17, 2],
  [29, 12, 4],
  [19, 14, 2],
] as const) {
  s.fill(x, y, x + len - 1, y, '#')
}
s.fill(18, H - 1, 21, H - 1, '-') // the south gate, a paved break in the wall
s.fill(18, H - 4, 21, H - 2, '-')
s.put(19, H - 6, '@')
s.put(20, 1, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'machinegun', [
  { id: 'heavy', stacks: 2 },
  { id: 'pierce', stacks: 1 },
  { id: 'lifesteal', stacks: 2 },
  { id: 'rapid', stacks: 1 },
])

spawnRaid(w, 'staging', { x: 20.5, y: 5.5 }, player, ['leader', 'medic', 'grunt', 'grunt', 'grunt'])

w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Break the raid, take the north gate' }

writeSave('cut-the-head', w)
