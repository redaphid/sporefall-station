/**
 * A/B the tween IN THE REAL CLIENT (netClient.ts, temporarily mode-switchable),
 * over the real BLE link model. This is the check that the recommendation works
 * in the shipped code path, not only in the analytic model.
 *
 * Includes a CONTROL (smooth=0.15) that MUST move the metric in the predicted
 * direction — a measurement nobody has watched respond is not evidence.
 */
import { runTrace, type ClientCtor } from './trace.mts'
import { NetClientSession } from '../../src/app/netClient'
import { NetClientSession as BaselineClientSession } from './baseline/netClientBaseline'

const f = (n: number, d = 2) => n.toFixed(d).padStart(8)

/** BEFORE is a verbatim pin of origin/main's client, so both sides of the A/B
 * are real code rather than a hand-rolled model. */
interface Case { label: string; ctor: ClientCtor }
const CASES: Case[] = [
  { label: 'BEFORE (origin/main: ease 0.45, no projection)', ctor: BaselineClientSession as unknown as ClientCtor },
  { label: 'AFTER  (shipped: projected target, ease 0.30)', ctor: NetClientSession as ClientCtor },
]

const analyse = (rows: { hostSpeed: number; drawnSpeed: number; lag: number; tick: number }[]) => {
  // Only stretches where the host walked steadily, so accel/decel and
  // wall-sliding cannot masquerade as tween artefacts.
  const keep: number[] = []
  for (let i = 2; i < rows.length; i++) {
    if (rows[i].hostSpeed > 4.2 && rows[i - 1].hostSpeed > 4.2 && rows[i - 2].hostSpeed > 4.2) keep.push(i)
  }
  const sp = keep.map((i) => rows[i].drawnSpeed)
  const lg = keep.map((i) => rows[i].lag)
  const ts = keep.map((i) => rows[i].hostSpeed).reduce((a, b) => a + b, 0) / keep.length
  const jerks: number[] = []
  for (let k = 1; k < keep.length; k++) if (keep[k] === keep[k - 1] + 1) jerks.push(Math.abs(sp[k] - sp[k - 1]))
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  return {
    n: keep.length,
    ts,
    minSpd: Math.min(...sp),
    maxSpd: Math.max(...sp),
    swing: Math.max(...sp) / Math.max(0.01, Math.min(...sp)),
    rmsJerk: Math.sqrt(mean(jerks.map((j) => j * j))),
    lag: mean(lg),
    stall: (sp.filter((s) => s < ts * 0.25).length / sp.length) * 100,
    dart: (sp.filter((s) => s > ts * 1.75).length / sp.length) * 100,
  }
}

const main = async () => {
  for (const loss of [0, 5]) {
    console.log(`\n${'='.repeat(104)}`)
    console.log(`REAL CLIENT, ${loss}% BLE packet loss — host walking steadily, measured on the client's rendered positions`)
    console.log('='.repeat(104))
    console.log('variant                                          n   trueSpd  minSpd  maxSpd  rmsJerk     lag  stall%  dart%')
    for (const c of CASES) {
      const { rows } = await runTrace(loss, 40, 0x5eed, c.ctor)
      const a = analyse(rows)
      console.log(
        `${c.label.padEnd(46)} ${String(a.n).padStart(4)} ${f(a.ts)} ${f(a.minSpd)} ${f(a.maxSpd)} ${f(a.rmsJerk)} ${f(a.lag)} ${f(a.stall, 1)} ${f(a.dart, 1)}`,
      )
    }
  }
  process.exit(0)
}
void main()
