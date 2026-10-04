// Craft the `mireclaw-den` save: the Mireclaw Alpha in a round bog arena with
// four root-knot pillars, three spore pools blooming as you walk in. Above half
// health it broods sporelings; below half it hunts for spore to regrow in; under
// a fifth it enrages. The pools are spent within a few seconds of the bloom, so
// the regrow only finds spore a fight leaves behind. The machinegun's
// incendiary rounds burn the Mireclaw harder than bullets do (burning 1.25,
// physical 0.75). The exit behind the den opens when it dies.
//
// Run: pnpm exec tsx scripts/saves/mireclaw-den.mts

import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { seedSpore } from '../../src/game/systems/spore'
import { worldFromState } from '../../src/game/world'
import { arm, Sketch, writeSave } from './lib.mts'

const W = 42
const H = 40
const CX = 21
const CY = 18
const R = 16
const s = new Sketch(W, H, '#')
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - CX, (y + 0.5 - CY) * 1.05)
    if (d < R) s.put(x, y, d < 6 ? '~' : d < 11 ? ',' : '.')
  }
}
// Root-knot pillars to break the brood's charge.
for (const [x, y] of [
  [13, 12],
  [28, 12],
  [12, 23],
  [29, 23],
]) {
  s.fill(x, y, x + 1, y + 1, '#')
}
// The way in from the south, and the way out behind the den.
s.fill(19, CY + R - 1, 22, H - 1, '-')
s.put(20, CY + R - 3, '@') // just inside the arena, the Alpha in view
s.put(21, CY - R + 1, 'E')

const pools = [
  [9, 18],
  [32, 18],
  [21, 6],
]
const rows = s.rows
const w = worldFromState({ level: levelFromJson({ rows }) })
const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
arm(player, 'machinegun', [
  { id: 'incendiary', stacks: 1 },
  { id: 'rapid', stacks: 1 },
  { id: 'overload', stacks: 2 },
  { id: 'pierce', stacks: 1 },
])
for (const [x, y] of pools) seedSpore(w, x, y)

const boss = spawnNpc(w, 'boss', CX + 0.5, CY + 0.5)
w.mission = {
  template: 'assassinate',
  targetEntityId: boss.id,
  complete: false,
  exitUnlocked: false,
  description: 'Kill the Mireclaw Alpha',
}

writeSave('mireclaw-den', w)
