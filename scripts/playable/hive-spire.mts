// hive-spire: one spire in a mossy cave. Stand near it and it buds spore mites
// at you (its drawn attack clip); back off and watch it idle and spread.
import { spawnHive } from '../../src/game/systems/groups'
import { arm, room, save, stage } from './lib.mts'

const rows = room(30, 17, 6, 8, ',').fill(12, 4, 26, 12, '~').fill(14, 6, 24, 10, ',').rows
const { w, p } = stage(rows, { hp: 400 })
arm(p, 'phosphorHose', [])
spawnHive(w, 19.5, 8.5)
save('hive-spire', w)
