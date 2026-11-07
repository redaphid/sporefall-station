// quickdraw: a flooded lock hall, three drowned divers on guard at the far end.
// Walk in and they spot you, draw (16 ticks) and only then shoot.
import { arm, npc, room, save, stage } from './lib.mts'

const rows = room(38, 13, 10, 6, '%')
  .fill(1, 1, 36, 2, '~')
  .fill(1, 10, 36, 11, '~')
  .fill(12, 3, 12, 4, '#')
  .fill(12, 8, 12, 9, '#').rows
const { w, p } = stage(rows, { hp: 240 })
arm(p, 'rivetDriver', [])
for (const [x, y] of [
  [29, 4],
  [31, 6],
  [29, 8],
] as const) {
  const d = npc(w, 'drowner', x, y)
  d.ai!.guard = true // they hold the far end until they see you
  d.facing = Math.PI
}
save('quickdraw', w)
