// drowner-reel: tough drowned divers at range across the lock. Every hit plays
// their hurt clip: snap back, arms flung, sway, settle.
import { arm, npc, room, save, stage } from './lib.mts'

const rows = room(34, 15, 5, 7, '%').fill(1, 1, 32, 3, '~').fill(1, 11, 32, 13, '~').rows
const { w, p } = stage(rows, { hp: 400 })
arm(p, 'rivetDriver', [])
for (const [x, y] of [
  [14, 5],
  [15, 8],
  [14, 10],
] as const) {
  const d = npc(w, 'drowner', x, y)
  d.health = { ...d.health!, hp: 160, max: 160 }
  d.ai!.guard = true
  d.facing = Math.PI
}
save('drowner-reel', w)
