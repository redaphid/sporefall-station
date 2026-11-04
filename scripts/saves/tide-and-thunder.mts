// Craft the `tide-and-thunder` save: a sunken causeway grid on a bog tide, three
// gloamhound packs denned in the flood lanes, and the player on a raised
// boardwalk island with a shock pistol. When the tide is in, every hound in the
// water is wet, and a shock round arcs from one wet body to the next.
// The first flood comes about three seconds in.
//
// Run: pnpm exec tsx scripts/saves/tide-and-thunder.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnPlayer } from '../../src/game/player'
import { spawnPack } from '../../src/game/systems/groups'
import { startFloorModifier } from '../../src/game/systems/modifierSystem'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 46
const H = 38
const s = new Sketch(W, H, '#')
s.fill(1, 1, W - 2, H - 2, ':')
// City blocks between the flood lanes; each keeps a dry boardwalk lip.
for (const bx of [4, 18, 32]) {
  for (const by of [4, 22]) {
    s.fill(bx, by, bx + 9, by + 11, '-')
    s.fill(bx + 1, by + 1, bx + 8, by + 10, '#')
  }
}
// The island in the middle: dry ground to stand on while the water rises.
s.fill(19, 17, 26, 20, '-')
s.put(22, 18, '@')
s.put(W - 3, H - 3, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'pistol', [
  { id: 'bulk', stacks: 1 },
  { id: 'shock', stacks: 1 },
  { id: 'bounce', stacks: 1 },
  { id: 'velocity', stacks: 1 },
])

spawnPack(w, { x: 9.5, y: 18.5 }, 5)
spawnPack(w, { x: 38.5, y: 18.5 }, 5)
spawnPack(w, { x: 22.5, y: 34.5 }, 5)

// As if the floor had begun 12 s ago: the first flood rolls in at about 3 s.
startFloorModifier(w, 'bogTide', 360)
w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Weather the tide, reach the far corner' }

writeSave('tide-and-thunder', w)
