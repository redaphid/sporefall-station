import { Tile } from '../../src/game/levelgen/level'
import { spawnPlayer } from '../../src/game/player'
import { spawnNpc } from '../../src/game/populate'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld, type World } from '../../src/game/world'

const w = createWorld(7, 1, 'normal', false)
for (let y = 4; y <= 40; y++) for (let x = 4; x <= 60; x++) { w.level.tiles[y * w.level.w + x] = Tile.Floor; w.level.solid[y * w.level.w + x] = 0 }
const run = (w: World, n: number) => { for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, { ...emptyInput() }]])) }
const player = spawnPlayer(w, 0, 10.5, 20.5)
const hunter = spawnNpc(w, 'gangster', 15.5, 20.5)
hunter.combat!.weapon = 'bat'
hunter.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
run(w, 12)
console.log('t12', hunter.ai!.mode, hunter.ai!.goal, hunter.ai!.targetId, JSON.stringify(hunter.ai!.lastKnownTargetPos))
player.pos.x = 45.5; player.prevPos.x = 45.5
for (let i = 0; i < 400; i++) {
  run(w, 1)
  if (i % 20 === 0 || w.tick < 40) console.log(w.tick, hunter.ai!.mode, hunter.ai!.goal, 'tgt', hunter.ai!.targetId, 'lk', JSON.stringify(hunter.ai!.lastKnownTargetPos), 'search', JSON.stringify(hunter.ai!.search), 'pos', hunter.pos.x.toFixed(1), hunter.pos.y.toFixed(1))
  if (hunter.ai!.targetId === undefined) { console.log('gave up at', w.tick); break }
}
