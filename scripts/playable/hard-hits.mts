// hard-hits: sleeping bog mutants and spore mites a few steps from a shotgun.
// Big blows throw the body (death tumble); the render draws it, the sim does not.
import { arm, asleep, npc, room, save, stage } from './lib.mts'

const rows = room(26, 15, 5, 7, '+').rows
const { w, p } = stage(rows, { hp: 200 })
arm(p, 'shotgun', [{ id: 'heavy', stacks: 1 }])
const px = p.pos.x
const py = p.pos.y
for (const [x, y] of [
  [8, 5],
  [9, 7],
  [8, 9],
] as const)
  asleep(npc(w, 'mutant', x, y), px, py, 10) // one volley finishes each
for (const [x, y] of [
  [10, 4],
  [11, 8],
  [10, 11],
] as const)
  asleep(npc(w, 'sporeling', x, y), px, py, 6)
save('hard-hits', w)
