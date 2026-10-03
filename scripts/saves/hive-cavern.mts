// Craft the `hive-cavern` save: a spore cavern with three hive spires and a
// swarm of sporelings, against a shotgun carrying detonator, pierce, split, heavy and
// incendiary. Fire is what the spires fear.
// Every kill bursts, and the burst catches the sporelings packed in beside it
// (a burst does not set off another burst). Three barrels sit in the swarm's
// path. Once the player is within reach, the spires bud fresh sporelings at
// them and plant new spires, so the cavern refills until they are shot down.
//
// Run: pnpm exec tsx scripts/saves/hive-cavern.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { spawnHive } from '../../src/game/systems/groups'
import { spawnObject } from '../../src/game/systems/objects'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 44
const H = 38
const s = new Sketch(W, H, '#')
// A lumpy cavern: overlapping blobs of bog and floor.
const blobs: Array<[cx: number, cy: number, r: number, glyph: string]> = [
  [22, 19, 14, ','],
  [12, 12, 7, '~'],
  [32, 12, 7, '~'],
  [22, 28, 7, '~'],
  [22, 19, 4, ','],
]
for (const [cx, cy, r, glyph] of blobs) {
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r) s.put(x, y, glyph)
  }
}
// Stalagmites to funnel the swarm.
for (const [x, y] of [
  [16, 18],
  [28, 18],
  [22, 13],
  [22, 24],
]) {
  s.fill(x, y, x, y + 1, '#')
}
s.fill(21, 33, 23, H - 2, '.') // the tunnel you came down
s.put(22, 30, '@') // at the tunnel mouth, the swarm in view
s.put(22, 6, 'E')

const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'shotgun', [
  { id: 'detonator', stacks: 1 },
  { id: 'pierce', stacks: 1 },
  { id: 'split', stacks: 1 },
  { id: 'heavy', stacks: 1 },
  { id: 'incendiary', stacks: 1 },
])

for (const [x, y] of [
  [12.5, 11.5],
  [32.5, 11.5],
  [22.5, 9.5],
]) {
  spawnHive(w, x, y)
}
for (let i = 0; i < 14; i++) {
  const a = (i / 14) * Math.PI * 2
  const r = 4 + (i % 2) * 3
  spawnNpc(w, 'sporeling', 22.5 + Math.cos(a) * r, 18.5 + Math.sin(a) * r * 0.8)
}
for (const [tx, ty] of [
  [18, 22],
  [26, 22],
  [22, 16],
]) {
  spawnObject(w, 'barrel', tx, ty)
}

w.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Clear the cavern, climb out the north shaft' }

writeSave('hive-cavern', w)
