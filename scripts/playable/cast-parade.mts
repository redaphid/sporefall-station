// cast-parade: the new walk cycles on parade. Everyone patrols their own lane
// and nobody is hostile, so you can walk among them and watch every facing.
import type { Entity } from '../../src/game/entity'
import { assignPatrol } from '../../src/game/populate'
import { arm, npc, room, save, stage } from './lib.mts'

const CAST = ['robot', 'mutant', 'lurker', 'brute', 'bellwether', 'cinder', 'sporeling', 'drowner', 'mender', 'breacher', 'gloamhound', 'stalker']
const rows = room(36, 2 * CAST.length + 5, 3, CAST.length + 2, ',').rows
const { w, p } = stage(rows, { hostile: false })
arm(p, 'pistol', [])
CAST.forEach((arch, i) => {
  const y = 2 + 2 * i
  const e: Entity = npc(w, arch, 8 + ((i * 5) % 20), y)
  // A peaceful parade: no grudge against players, no group to rally to.
  e.ai!.faction = 'civ'
  e.ai!.rel = { [p.id]: { hate: 0, fear: 0 } as never }
  e.ai!.dormant = false // the lurker would otherwise crouch in wait
  e.ai!.wakeOn = undefined
  assignPatrol(e, [
    { x: 7.5, y: y + 0.5 },
    { x: 32.5, y: y + 0.5 },
  ])
})
save('cast-parade', w)
