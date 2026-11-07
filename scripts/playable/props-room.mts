// props-room: the eight regenerated props (colony plumbing kit) furnishing one
// mess hall beside the crate, barrel and chair they share floors with.
import { spawnObject } from '../../src/game/systems/objects'
import { arm, room, save, stage } from './lib.mts'

const rows = room(16, 11, 8, 8, '+').rows
const { w, p } = stage(rows, { hostile: false })
arm(p, 'pistol', [])
const plan: [string, number, number][] = [
  ['vending', 2, 2], ['cryoTerminal', 4, 2], ['tv', 7, 2], ['locker', 10, 2], ['cabinet', 12, 2],
  ['toilet', 2, 5], ['desk', 6, 5], ['chair', 7, 5], ['crate', 11, 5], ['barrel', 12, 5],
  ['bench', 3, 7], ['bench', 4, 7], ['bunk', 12, 8],
]
for (const [arch, x, y] of plan) spawnObject(w, arch, x, y)
save('props-room', w)
