// wall-kill: sleepers standing flush against a bulkhead. Kill one and its
// thrown body has nowhere to go: it should settle at the foot of the wall.
import { arm, asleep, npc, room, save, stage } from './lib.mts'

const rows = room(22, 11, 6, 5, '%').rows
const { w, p } = stage(rows, { hp: 200 })
arm(p, 'shotgun', [{ id: 'heavy', stacks: 1 }])
for (const y of [3, 5, 7]) {
  const m = asleep(npc(w, 'mutant', 19, y), p.pos.x, p.pos.y, 10)
  // Flush on the east wall (x 21): its radius touches the bulkhead.
  m.pos.x = 20.62
  m.prevPos.x = m.pos.x
  if (m.ai) m.ai.home = { x: m.pos.x, y: m.pos.y }
}
save('wall-kill', w)
