// cast-parade: the new walk cycles on parade. Everyone patrols their own lane
// and nobody is hostile, so you can walk among them and watch every facing.
import type { Entity } from '../../src/game/entity'
import { assignPatrol } from '../../src/game/populate'
import { arm, npc, room, save, stage } from './lib.mts'

const CAST = ['robot', 'mutant', 'lurker', 'brute', 'bellwether', 'cinder', 'sporeling', 'drowner', 'mender', 'breacher', 'gloamhound', 'stalker']
// Two columns of six lanes, so the whole parade fits one phone screen.
const rows = room(36, 16, 18, 8, '+').rows
const { w, p } = stage(rows, { hostile: false })
arm(p, 'rivetDriver', [])
CAST.forEach((arch, i) => {
  const y = 3 + 2 * (i % 6)
  const [x0, x1] = i < 6 ? [3.5, 15.5] : [20.5, 32.5]
  const e: Entity = npc(w, arch, Math.floor(x0) + 2 + ((i * 3) % 8), y)
  // A peaceful parade: no grudge against players, no group to rally to.
  e.ai!.faction = 'civ'
  e.ai!.rel = { [p.id]: { hate: 0, fear: 0 } as never }
  e.ai!.dormant = false // the lurker would otherwise crouch in wait
  e.ai!.wakeOn = undefined
  assignPatrol(e, [
    { x: x0, y: y + 0.5 },
    { x: x1, y: y + 0.5 },
  ])
})
save('cast-parade', w)
