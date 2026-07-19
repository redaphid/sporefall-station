// Trace exactly WHO damages the idle player at spawn on seed 7.
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import type { InputCmd } from '../../src/game/types'

const idle: InputCmd = { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, attack: false, interact: false, special: false, hotbar: -1, throwItem: false, roll: false }

const w = createWorld(7, 1, 'normal')
populateWorld(w)
setupFloor(w)
const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
const inputs = new Map<number, InputCmd>([[0, idle]])
let lastHp = p.health!.hp
for (let t = 0; t < 600; t++) {
  tickWorld(w, inputs)
  for (const ev of w.events) {
    if (ev.type === 'hit' && ev.targetId === p.id) {
      // who is near?
      const near = w.entities.filter(e => e.kind === 'npc' && Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) < 3)
        .map(e => `${e.archetype}#${e.id}@${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)} mode=${e.ai?.mode} tgt=${e.ai?.targetId} weapon=${e.combat?.weapon}`)
      const projs = w.entities.filter(e => e.kind === 'projectile').map(e => `proj#${e.id}@${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)} owner=${e.projectile?.ownerId}`)
      console.log(`t=${t} hit player for ${ev.amount} (hp ${p.health!.hp}) near=[${near.join(' | ')}] projs=[${projs.join(' | ')}]`)
    }
    if (ev.type === 'down' as string || ev.type === 'runOver') console.log(`t=${t}`, JSON.stringify(ev))
  }
  if (p.health!.hp !== lastHp) {
    if (w.events.every(ev => ev.type !== 'hit')) console.log(`t=${t} hp changed ${lastHp} -> ${p.health!.hp} with NO hit event`)
    lastHp = p.health!.hp
  }
  if (p.downed) { console.log(`t=${t} DOWNED`); break }
}
console.log('final hp', p.health!.hp, 'downed', !!p.downed, 'gameOver', w.gameOver)
