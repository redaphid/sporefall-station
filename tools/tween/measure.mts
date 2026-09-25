import { run, metrics, constantWalk, reversal, SIM_RATE, type Strategy } from './model.mts'

const SPEED = 4.5 // netClient.ts:399 stepSelf; NPCs 2.5-4.6 (data/npcs.ts)
const fmt = (n: number, d = 2) => n.toFixed(d).padStart(7)

// ------------------------------------------------------- 1. deterministic trace
// Force an exact drop pattern by running the filter by hand, so the shape of a
// dropped snapshot is visible tick by tick rather than averaged away.
const trace = (dropAfter: number, dropCount: number) => {
  const SMOOTH = 0.45
  let pos = 0
  let target = 0
  const rows: { tick: number; truth: number; drawn: number; speed: number; snap: string }[] = []
  let applied = 0
  for (let tick = 1; tick <= 30; tick++) {
    let snap = ''
    if (tick % 3 === 0) {
      applied++
      const lost = applied > dropAfter && applied <= dropAfter + dropCount
      if (lost) snap = 'LOST'
      else { target = tick * SPEED / SIM_RATE; snap = 'ok' }
    }
    const prev = pos
    pos += (target - pos) * SMOOTH
    rows.push({ tick, truth: tick * SPEED / SIM_RATE, drawn: pos, speed: Math.abs(pos - prev) * SIM_RATE, snap })
  }
  return rows
}

console.log('='.repeat(78))
console.log('TRACE A: clean link, no loss. Remote player walking straight at 4.5 tiles/s.')
console.log('='.repeat(78))
console.log(' tick   snap    true_x   drawn_x   lag_tiles   drawn_speed(t/s)')
for (const r of trace(999, 0).slice(0, 18))
  console.log(`  ${String(r.tick).padStart(3)}  ${r.snap.padEnd(5)} ${fmt(r.truth)}  ${fmt(r.drawn)}   ${fmt(r.truth - r.drawn)}      ${fmt(r.speed)}`)

console.log()
console.log('='.repeat(78))
console.log('TRACE B: ONE snapshot dropped (a 200 ms gap). Same walk.')
console.log('='.repeat(78))
console.log(' tick   snap    true_x   drawn_x   lag_tiles   drawn_speed(t/s)')
for (const r of trace(3, 1)) {
  const mark = r.speed < SPEED * 0.25 ? '  <-- STALL' : r.speed > SPEED * 1.75 ? '  <-- DART' : ''
  console.log(`  ${String(r.tick).padStart(3)}  ${r.snap.padEnd(5)} ${fmt(r.truth)}  ${fmt(r.drawn)}   ${fmt(r.truth - r.drawn)}      ${fmt(r.speed)}${mark}`)
}

console.log()
console.log('='.repeat(78))
console.log('TRACE C: THREE consecutive dropped (the 400 ms worst-case gap).')
console.log('='.repeat(78))
console.log(' tick   snap    true_x   drawn_x   lag_tiles   drawn_speed(t/s)')
for (const r of trace(3, 3)) {
  const mark = r.speed < SPEED * 0.25 ? '  <-- STALL' : r.speed > SPEED * 1.75 ? '  <-- DART' : ''
  console.log(`  ${String(r.tick).padStart(3)}  ${r.snap.padEnd(5)} ${fmt(r.truth)}  ${fmt(r.drawn)}   ${fmt(r.truth - r.drawn)}      ${fmt(r.speed)}${mark}`)
}

// ------------------------------------------------------- 2. strategy comparison
const STRATS: { name: string; s: Strategy }[] = [
  { name: 'current (ease 0.45/tick)', s: { kind: 'current' } },
  { name: 'interp buffer 100ms', s: { kind: 'interp', delayMs: 100 } },
  { name: 'interp buffer 200ms', s: { kind: 'interp', delayMs: 200 } },
  { name: 'dead-reckon cap 400ms', s: { kind: 'deadReckon', capMs: 400 } },
  { name: 'hybrid cap 100ms s=.45', s: { kind: 'hybrid', capMs: 100, smooth: 0.45 } },
  { name: 'hybrid cap 150ms s=.30', s: { kind: 'hybrid', capMs: 150, smooth: 0.3 } },
]

const LOSSES = [
  { name: 'clean (0% snapshot loss)', p: 0 },
  { name: '2% pkt -> 4.0% snap loss', p: 0.0396 },
  { name: '5% pkt -> 9.75% snap loss', p: 0.0975 },
  { name: '10% pkt -> 19% snap loss', p: 0.19 },
]

for (const L of LOSSES) {
  console.log()
  console.log('='.repeat(100))
  console.log(`STRATEGY SWEEP @ ${L.name} — straight walk, 4.5 tiles/s, 3000 ticks x 8 seeds`)
  console.log('='.repeat(100))
  console.log('strategy                    meanLag  maxLag   minSpd  maxSpd   maxJerk  rmsJerk  stall%  dart%')
  for (const st of STRATS) {
    const acc = { ml: 0, xl: 0, mn: 0, mx: 0, mj: 0, rj: 0, st: 0, dt: 0 }
    const seeds = 8
    for (let seed = 1; seed <= seeds; seed++) {
      const r = run({ ticks: 3000, traj: constantWalk(SPEED), snapLoss: L.p, seed, strategy: st.s, latencyMs: 25 })
      const m = metrics(r.samples, SPEED)
      acc.ml += m.meanAbsErr; acc.xl = Math.max(acc.xl, m.maxAbsErr)
      acc.mn += m.minSpeed; acc.mx = Math.max(acc.mx, m.maxSpeed)
      acc.mj = Math.max(acc.mj, m.maxJerk); acc.rj += m.rmsJerk
      acc.st += m.stallTicks / 2970 * 100; acc.dt += m.dartTicks / 2970 * 100
    }
    console.log(
      `${st.name.padEnd(26)} ${fmt(acc.ml / seeds)} ${fmt(acc.xl)}  ${fmt(acc.mn / seeds)} ${fmt(acc.mx)}  ${fmt(acc.mj)}  ${fmt(acc.rj / seeds)}  ${fmt(acc.st / seeds, 1)} ${fmt(acc.dt / seeds, 1)}`,
    )
  }
}

// ------------------------------------------------------- 3. the reversal case
console.log()
console.log('='.repeat(100))
console.log('DIRECTION REVERSAL @ 5% pkt loss — the case extrapolation is supposed to get wrong')
console.log('(player runs one way, then reverses at tick 300; 20 reversals over the run)')
console.log('='.repeat(100))
console.log('strategy                    meanLag  maxLag   maxJerk  overshoot(tiles)')
for (const st of STRATS) {
  let ml = 0, xl = 0, mj = 0, ov = 0
  const seeds = 8
  for (let seed = 1; seed <= seeds; seed++) {
    // sawtooth: reverse every 90 ticks (3s)
    const traj = (t: number) => {
      const period = 180, ph = t % period
      return (ph < 90 ? ph : 180 - ph) * SPEED / SIM_RATE
    }
    const r = run({ ticks: 3000, traj, snapLoss: 0.0975, seed, strategy: st.s, latencyMs: 25 })
    const m = metrics(r.samples, SPEED)
    ml += m.meanAbsErr; xl = Math.max(xl, m.maxAbsErr); mj = Math.max(mj, m.maxJerk)
    // overshoot: rendered position beyond the turning point
    let worst = 0
    for (const s of r.samples) {
      const period = 180, ph = s.tick % period
      const peak = 90 * SPEED / SIM_RATE
      if (ph > 80 && ph < 110) worst = Math.max(worst, s.renderX - peak)
    }
    ov = Math.max(ov, worst)
  }
  console.log(`${st.name.padEnd(26)} ${fmt(ml / seeds)} ${fmt(xl)}  ${fmt(mj)}  ${fmt(ov)}`)
}

// ------------------------------------------------------- 4. gap distribution
console.log()
console.log('='.repeat(78))
console.log('OBSERVED SNAPSHOT GAP DISTRIBUTION (what a client actually experiences)')
console.log('='.repeat(78))
for (const L of LOSSES) {
  const hist = new Map<number, number>()
  for (let seed = 1; seed <= 20; seed++) {
    const r = run({ ticks: 6000, traj: constantWalk(SPEED), snapLoss: L.p, seed, strategy: { kind: 'current' }, latencyMs: 25 })
    for (const g of r.gapsMs) hist.set(g, (hist.get(g) ?? 0) + 1)
  }
  const total = [...hist.values()].reduce((a, b) => a + b, 0)
  const keys = [...hist.keys()].sort((a, b) => a - b)
  const line = keys.slice(0, 6).map((k) => `${k}ms:${((hist.get(k)! / total) * 100).toFixed(1)}%`).join('  ')
  console.log(`${L.name.padEnd(28)} ${line}   worst=${Math.max(...keys)}ms`)
}
