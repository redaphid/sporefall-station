// Probe: does the player die shortly after spawn with NO input? Which entity
// does the damage, and how common is it across seeds?
import { createWorld, tickWorld } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import type { InputCmd } from '../../src/game/types'

const idle: InputCmd = { seq: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, attack: false, interact: false, special: false, hotbar: -1, throwItem: false, roll: false }

const probe = (seed: number, verbose: boolean): { died: boolean; tick: number } => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  if (verbose) {
    console.log(`seed ${seed}: spawn at ${w.level.spawn.x},${w.level.spawn.y}, player hp ${p.health!.hp}`)
    for (const e of w.entities) {
      if (e.kind === 'npc') {
        const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y)
        if (d < 12) console.log(`  nearby npc: ${e.archetype} id=${e.id} at ${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)} dist=${d.toFixed(1)} weapon=${e.combat?.weapon} behavior=${e.ai?.behavior ?? 'basic'} faction=${e.ai?.faction}`)
      }
    }
  }
  const inputs = new Map<number, InputCmd>([[0, idle]])
  for (let t = 0; t < 300; t++) {
    tickWorld(w, inputs)
    if (verbose) {
      for (const ev of w.events) {
        if (ev.type === 'damage' || ev.type === 'shot' || ev.type === 'down' || ev.type === 'death') {
          console.log(`  t=${t} event:`, JSON.stringify(ev))
        }
      }
      if (p.downed) { console.log(`  t=${t} PLAYER DOWNED (hp ${p.health!.hp})`); return { died: true, tick: t } }
    }
    if (p.downed || p.dead) return { died: true, tick: t }
  }
  return { died: false, tick: -1 }
}

// Verbose on seed 7 (the reported one)
probe(7, true)

// Sweep seeds 1..40
let deaths = 0
const dead: number[] = []
for (let s = 1; s <= 40; s++) {
  const r = probe(s, false)
  if (r.died) { deaths++; dead.push(s) }
}
console.log(`\nSweep 1..40 (idle player, 300 ticks = 10s): ${deaths}/40 seeds die. Seeds: ${dead.join(', ')}`)

// Variant probes: stuck buttons
const probeCmd = (seed: number, patch: Partial<InputCmd>, label: string): void => {
  const w = createWorld(seed, 1, 'normal')
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  const cmd = { ...idle, ...patch }
  const inputs = new Map<number, InputCmd>([[0, cmd]])
  for (let t = 0; t < 300; t++) {
    tickWorld(w, inputs)
    if (p.downed || p.dead) { console.log(`${label}: seed ${seed} DIED at t=${t} (hp ${p.health!.hp})`); return }
  }
  console.log(`${label}: seed ${seed} survives 300 ticks (hp ${p.health!.hp}/${p.health!.max})`)
}
probeCmd(7, { attack: true }, 'attack held')
probeCmd(7, { special: true }, 'special held')
probeCmd(7, { throwItem: true }, 'throw held')
probeCmd(7, { attack: true, special: true, throwItem: true }, 'all held')
probeCmd(7, { moveX: 1, moveY: 1 }, 'move diag')
