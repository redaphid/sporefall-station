// skid-lane: a big empty deck and nobody to bother you. Sprint, let go, and
// watch the stop: lean back, slide a hair, kick up dust. Every direction.
import { arm, room, save, stage } from './lib.mts'

const rows = room(40, 24, 20, 12, '%').fill(1, 1, 38, 2, 'x').fill(1, 21, 38, 22, 'x').rows
const { w, p } = stage(rows, { hostile: false })
arm(p, 'pistol', [])
save('skid-lane', w)
