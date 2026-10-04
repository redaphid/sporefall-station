// Debug: watch a player-vs-mutant fight tick by tick.
import { spawnPlayer } from '../../src/game/player'
import { spawnNpc } from '../../src/game/populate'
import { emptyInput } from '../../src/game/types'
import { createWorld, tickWorld } from '../../src/game/world'

const w = createWorld(5, 1)
const player = spawnPlayer(w, 0, 10.5, 1.5)
const mutant = spawnNpc(w, 'mutant', 11.5, 1.5)
player.facing = 0

const inputs = new Map([[0, { ...emptyInput(), attack: true }]])
for (let i = 0; i < 300; i++) {
  tickWorld(w, inputs)
  if (i % 15 === 0 || w.events.length > 0) {
    const dist = Math.hypot(mutant.pos.x - player.pos.x, mutant.pos.y - player.pos.y)
    console.log(
      `t=${w.tick} pHp=${player.health!.hp} tHp=${mutant.dead ? 'DEAD' : mutant.health!.hp} dist=${dist.toFixed(2)} ` +
        `pPos=(${player.pos.x.toFixed(1)},${player.pos.y.toFixed(1)}) tPos=(${mutant.pos.x.toFixed(1)},${mutant.pos.y.toFixed(1)}) ` +
        `tMode=${mutant.ai!.mode} events=${w.events.map((e) => e.type).join(',')}`,
    )
  }
  if (mutant.dead) break
}
