// Worst-case cost of settler activities: a 120x60 hall with 400 settlers and
// 60 card tables (four chairs each), ticked for 20 s. Prints the mean and p99
// tick time.
//   npx tsx scripts/test/activity-stress.mts
import { levelFromJson } from '../../src/game/levelgen/levelText'
import { spawnNpc } from '../../src/game/populate'
import { spawnObject } from '../../src/game/systems/objects'
import { tickWorld, worldFromState } from '../../src/game/world'

const W = 120
const H = 60
const rows = Array.from({ length: H }, (_, y) =>
  Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : x === 2 && y === 2 ? '@' : '.')).join(''),
)
const w = worldFromState({ level: levelFromJson({ rows }), hostile: false })
for (let i = 0; i < 60; i++) {
  const tx = 6 + (i % 12) * 9
  const ty = 6 + Math.floor(i / 12) * 10
  spawnObject(w, 'table', tx, ty)
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ])
    spawnObject(w, 'chair', tx + dx, ty + dy)
}
for (let i = 0; i < 400; i++) spawnNpc(w, 'civilian', 3.5 + (i % 40) * 2.9, 3.5 + Math.floor(i / 40) * 5.3)

const times: number[] = []
for (let i = 0; i < 600; i++) {
  const t0 = performance.now()
  tickWorld(w, new Map())
  times.push(performance.now() - t0)
}
const sorted = [...times].sort((a, b) => a - b)
const mean = times.reduce((a, b) => a + b, 0) / times.length
const playing = w.entities.filter((e) => e.ai?.activity?.phase === 'playing').length
console.log(`mean ${mean.toFixed(2)} ms, p99 ${sorted[Math.floor(sorted.length * 0.99)].toFixed(2)} ms, ${playing} settlers playing at the end`)
