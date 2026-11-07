// rivet-driver-mods: the new sidearm carrying five mods, each with its own
// attachment on the gun, in a range with sleepers to freeze, burn and shock.
import { spawnObject } from '../../src/game/systems/objects'
import { arm, asleep, npc, room, save, stage } from './lib.mts'

const rows = room(28, 15, 5, 7, '%').rows
const { w, p } = stage(rows, { hp: 300 })
arm(p, 'rivetDriver', [
  { id: 'frost', stacks: 1 },
  { id: 'incendiary', stacks: 1 },
  { id: 'shock', stacks: 1 },
  { id: 'homing', stacks: 1 },
  { id: 'heavy', stacks: 1 },
])
for (const [x, y] of [
  [11, 4],
  [13, 7],
  [11, 10],
  [17, 5],
  [17, 9],
] as const)
  asleep(npc(w, 'mutant', x, y), p.pos.x, p.pos.y)
spawnObject(w, 'barrel', 21, 7)
spawnObject(w, 'barrel', 22, 4)
save('rivet-driver-mods', w)
