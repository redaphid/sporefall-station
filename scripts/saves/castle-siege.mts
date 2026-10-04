// Craft the `castle-siege` save: a hand-drawn castle with a moat, four towers
// and a keep, mortars either side of it, a player at the drawbridge carrying a split/frost/pierce/homing
// pistol, and a garrison inside. No seed builds any of it.
//
// Run: pnpm exec tsx scripts/saves/castle-siege.mts
// Writes src/game/__fixtures__/castle-siege.json, which ships in the bundle, so
// the save plays at /?world=castle-siege on any build that contains it. The
// JSON is the save; edit it by hand (rows, entity positions, mods) or rerun
// this script after changing the setup below. Copy this file to craft another.
//
// Legend (src/game/levelgen/levelText.ts): # wall  . floor  + tiled floor
// ~ bog  , grass  - sidewalk  E exit  @ player spawn  1-4 bevelled corners

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { spawnRaid } from '../../src/game/systems/groups'
import { serializeWorld } from '../../src/game/serialize'
import { worldFromState } from '../../src/game/world'

const rows = [
  ',,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  ',,~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~,,',
  ',,~1####~~~~~~~~~~~~~~~~~~~~~~~~~~~~####2~,,',
  ',,~#+++##############################+++#~,,',
  ',,~#+++#............................#+++#~,,',
  ',,~#+++#......################......#+++#~,,',
  ',,~##.##......#++++++++++++++#......##.##~,,',
  ',,~~#.........#++++++E+++++++#.........#~~,,',
  ',,~~#.........#++#++++++++#++#.........#~~,,',
  ',,~~#.........#++++++++++++++#.........#~~,,',
  ',,~~#.........#++++++++++++++#.........#~~,,',
  ',,~~#.........#++#++++++++#++#.........#~~,,',
  ',,~~#.........#++++++++++++++#.........#~~,,',
  ',,~~#.........#######..#######.........#~~,,',
  ',,~~#..................................#~~,,',
  ',,~~#....~~~...........................#~~,,',
  ',,~~#....~~~..................,,,,,....#~~,,',
  ',,~~#....~~~..................,,,,,....#~~,,',
  ',,~~#.........................,,,,,....#~~,,',
  ',,~~#.........................,,,,,....#~~,,',
  ',,~~#..................................#~~,,',
  ',,~~#..................................#~~,,',
  ',,~##.##............................##.##~,,',
  ',,~#+++#............................#+++#~,,',
  ',,~#+++#............................#+++#~,,',
  ',,~#+++#############...##############+++#~,,',
  ',,~4####~~~~~~~~~~~~---~~~~~~~~~~~~~####3~,,',
  ',,~~~~~~~~~~~~~~~~~~---~~~~~~~~~~~~~~~~~~~,,',
  ',,,,,,,,,,,,,,,,,,,,---,,,,,,,,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,,,,,,,---,,,,,,,,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,,,,,,,-@-,,,,,,,,,,,,,,,,,,,,,',
  ',,,,,,,,,,,,,,,,,,,,---,,,,,,,,,,,,,,,,,,,,,',
]

const w = worldFromState({ level: levelFromJson({ rows }) })

const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
player.loadout!.inventory[0].mods = [
  { id: 'split', stacks: 1 },
  { id: 'frost', stacks: 1 },
  { id: 'pierce', stacks: 2 },
  { id: 'homing', stacks: 1 },
]

const garrison: Array<[archetype: string, x: number, y: number]> = [
  ['thug', 10.5, 20.5],
  ['thug', 14.5, 22.5],
  ['thug', 28.5, 21.5],
  ['thug', 33.5, 14.5],
  ['brute', 21.5, 15.5],
  ['gangster', 18.5, 10.5],
  ['gangster', 25.5, 10.5],
]
for (const [archetype, x, y] of garrison) spawnNpc(w, archetype, x, y)

// A mortar either side of the keep. A lobber only lobs as a raid's artillery
// (its brain reads the group), so each is a one-gun siege raid: it shells the
// player whenever it can see them in range, and joins the fight when rushed.
for (const [x, y] of [
  [9.5, 8.5],
  [34.5, 8.5],
]) {
  spawnRaid(w, 'siege', { x, y }, player, ['artillery'])
}

// The keep's exit opens when the castle lord falls; it leads on to floor 2.
const lord = spawnNpc(w, 'boss', 21.5, 9.5)
w.mission = {
  template: 'assassinate',
  targetEntityId: lord.id,
  complete: false,
  exitUnlocked: false,
  description: 'Slay the castle lord',
}

const out = fileURLToPath(new URL('../../src/game/__fixtures__/castle-siege.json', import.meta.url))
writeFileSync(out, JSON.stringify(serializeWorld(w), null, 2) + '\n')
console.log(`wrote ${out} (${w.entities.length} entities)`)
