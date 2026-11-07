// How big can an authored world get before the sim's tick cost bites? Builds a
// synthetic W x H swamp (rooms, bog, boardwalk) with N hostiles spread over it,
// walks a player down the middle, and prints ms/tick (mean, p95, max).
// Run: pnpm exec tsx scripts/test/world-scale-probe.mts [W] [H] [npcs] [ticks]
import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnPlayer } from '../../src/game/player'
import { spawnObject } from '../../src/game/systems/objects'
import { spawnHive, spawnPack } from '../../src/game/systems/groups'
import { emptyInput } from '../../src/game/types'
import { tickWorld, worldFromState } from '../../src/game/world'
import { Sketch } from '../saves/lib.mts'

const [W, H, N, T] = process.argv.slice(2).map(Number)
const w0 = W || 78, h0 = H || 300, n0 = N || 200, t0 = T || 1800
const s = new Sketch(w0, h0, '#')
s.fill(1, 1, w0 - 2, h0 - 2, ',')
for (let y = 4; y < h0 - 8; y += 14) for (let x = 3; x < w0 - 12; x += 18) s.room(x, y, x + 10, y + 9, '+').put(x + 5, y + 9, '+')
for (let y = 10; y < h0; y += 23) s.fill(2, y, w0 - 3, y + 2, '~')
s.fill(Math.floor(w0 / 2) - 1, 1, Math.floor(w0 / 2) + 1, h0 - 2, '-')
s.put(Math.floor(w0 / 2), 2, '@')
const w = worldFromState({ level: levelFromJson({ rows: s.rows }) })
const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
const arch = ['drowner', 'mutant', 'acolyte', 'sporeling', 'brute', 'lobber']
let k = 0
for (let i = 0; i < n0; i++) {
  const x = 3 + ((i * 37) % (w0 - 6)) + 0.5, y = 6 + ((i * 53) % (h0 - 10)) + 0.5
  if (w.level.solid[Math.floor(y) * w0 + Math.floor(x)]) continue
  spawnNpc(w, arch[k++ % arch.length], x, y)
}
for (let i = 0; i < 6; i++) spawnPack(w, { x: 20.5 + i * 7, y: 40.5 + i * 40 }, 4)
for (let i = 0; i < 4; i++) spawnHive(w, 12.5 + i * 12, 60.5 + i * 50)
for (let i = 0; i < 300; i++) {
  const x = 2 + ((i * 29) % (w0 - 4)), y = 3 + ((i * 41) % (h0 - 6))
  if (!w.level.solid[y * w0 + x]) spawnObject(w, ['crate', 'barrel', 'bunk', 'shelf', 'plant'][i % 5], x, y)
}
p.health!.hp = p.health!.max = 1e9
const times: number[] = []
for (let t = 0; t < t0; t++) {
  const inp = emptyInput()
  inp.moveY = 1
  inp.moveX = Math.sin(t / 40)
  inp.attack = t % 3 === 0
  inp.aimX = p.pos.x + 3
  inp.aimY = p.pos.y + 3
  const t1 = performance.now()
  tickWorld(w, new Map([[0, inp]]))
  times.push(performance.now() - t1)
}
times.sort((a, b) => a - b)
const mean = times.reduce((a, b) => a + b, 0) / times.length
console.log(`${w0}x${h0} npcs=${n0} entities=${w.entities.length} alive=${w.entities.filter((e) => e.ai && !e.dead).length} player.y=${p.pos.y.toFixed(1)}`)
console.log(`ms/tick mean ${mean.toFixed(3)} p50 ${times[times.length >> 1].toFixed(3)} p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} max ${times[times.length - 1].toFixed(3)}`)
