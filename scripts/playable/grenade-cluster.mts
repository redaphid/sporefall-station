// grenade-cluster: four sleepers in a huddle, a grenade in your hand. One blast
// throws them all outward from the same point.
import { arm, asleep, npc, room, save, stage } from './lib.mts'

const rows = room(24, 13, 4, 6, '.').rows
const { w, p } = stage(rows, { hp: 200 })
arm(p, 'pistol', [])
p.loadout!.inventory.push({ itemId: 'grenade', qty: 6 })
p.loadout!.activeSlot = 1
const hx = 10.5
const hy = 6.5
for (const [dx, dy] of [
  [-0.45, -0.4],
  [0.45, -0.35],
  [-0.3, 0.45],
  [0.5, 0.5],
] as const) {
  const m = asleep(npc(w, 'mutant', 10, 6), p.pos.x, p.pos.y)
  m.pos = { x: hx + dx, y: hy + dy }
  m.prevPos = { ...m.pos }
  m.ai!.home = { ...m.pos }
}
save('grenade-cluster', w)
