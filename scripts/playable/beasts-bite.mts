// beasts-bite: a gloam hound pack, two mireclaw stalkers and a carapace brute
// come for you with teeth, claws and horns. No beast carries a knife.
import { spawnPack } from '../../src/game/systems/groups'
import { arm, npc, room, save, stage } from './lib.mts'

const rows = room(30, 18, 5, 9, ',').rows
const { w, p } = stage(rows, { hp: 500 })
arm(p, 'shotgun', [])
spawnPack(w, { x: 12.5, y: 6.5 }, 3)
npc(w, 'stalker', 12, 12)
npc(w, 'stalker', 14, 13)
// The brute runs with the beasts today rather than brawling them.
npc(w, 'brute', 15, 9).ai!.faction = 'neutral'
save('beasts-bite', w)
