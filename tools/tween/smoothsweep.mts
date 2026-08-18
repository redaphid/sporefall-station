import { run, metrics, constantWalk, SIM_RATE, type Strategy } from './model.mts'
const SPEED = 4.5
const f = (n: number, d = 2) => n.toFixed(d).padStart(7)

console.log('SMOOTH-CONSTANT SWEEP — is the artifact just a badly chosen constant?')
console.log('current algorithm unchanged, only SMOOTH varied. 3000 ticks x 8 seeds, straight walk.')
console.log()
for (const loss of [{ n: 'clean', p: 0 }, { n: '5% pkt loss', p: 0.0975 }]) {
  console.log(`--- ${loss.n} ---`)
  console.log('SMOOTH   meanLag(tiles)  lag(ms)   minSpd  maxSpd  spdSwing  rmsJerk  stall%  dart%')
  for (const k of [0.45, 0.35, 0.25, 0.2, 0.15, 0.1]) {
    let ml = 0, mn = 0, mx = 0, rj = 0, st = 0, dt = 0
    const seeds = 8
    for (let seed = 1; seed <= seeds; seed++) {
      const r = run({ ticks: 3000, traj: constantWalk(SPEED), snapLoss: loss.p, seed, strategy: { kind: 'current', smooth: k }, latencyMs: 25 })
      const m = metrics(r.samples, SPEED)
      ml += m.meanAbsErr; mn += m.minSpeed; mx = Math.max(mx, m.maxSpeed); rj += m.rmsJerk
      st += (m.stallTicks / 2970) * 100; dt += (m.dartTicks / 2970) * 100
    }
    const lag = ml / seeds
    console.log(`${String(k).padEnd(7)} ${f(lag)}      ${f((lag / SPEED) * 1000, 0)}  ${f(mn / seeds)} ${f(mx)}   ${f(mx / (mn / seeds), 1)}x ${f(rj / seeds)}  ${f(st / seeds, 1)} ${f(dt / seeds, 1)}`)
  }
  console.log()
}
