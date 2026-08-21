/**
 * Exact model of netClient.ts's remote-entity smoothing, so the tween behaviour
 * can be measured in isolation and alternatives swept without a 60s real run.
 *
 * Mirrors, tick for tick:
 *   netClient.ts:27   SMOOTH = 0.45      (fraction of remaining error per TICK)
 *   netClient.ts:28   SNAP_DIST = 2.5    (teleport threshold, tiles)
 *   netClient.ts:443  prevPos = pos      (start of tick, all entities)
 *   netClient.ts:454  ease toward target (end of tick, remote entities)
 *   types.ts:1        SIM_RATE = 30
 *   net/types.ts:41   SNAPSHOT_INTERVAL_TICKS = 3  -> 10 Hz snapshots
 *
 * The renderer (main.ts:796 accumulator, sprites.ts:349) draws
 * prevPos + (pos-prevPos)*alpha, i.e. exact linear interpolation between
 * consecutive per-tick positions. So the RENDERED path is the piecewise-linear
 * path through the per-tick positions: sub-tick alpha subdivides segments but
 * cannot remove a speed discontinuity at a tick boundary. Per-tick displacement
 * is therefore the honest proxy for apparent on-screen speed.
 */

export const SIM_RATE = 30
export const SIM_DT = 1 / SIM_RATE
export const SNAPSHOT_INTERVAL_TICKS = 3
export const SMOOTH = 0.45
export const SNAP_DIST = 2.5

export type Strategy =
  | { kind: 'current'; smooth?: number }
  | { kind: 'interp'; delayMs: number }
  | { kind: 'deadReckon'; capMs: number }
  | { kind: 'hybrid'; capMs: number; smooth: number }

export interface Sample { tick: number; trueX: number; renderX: number; speed: number; err: number }

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** True trajectory of the remote entity. 1-D is enough: the filter is separable
 * (x and y ease independently), and a straight walk is the common case. */
export type Traj = (tickIdx: number) => number

export const constantWalk = (speed: number): Traj => (t) => t * speed * SIM_DT

/** Walk, then reverse at `atTick` — the case extrapolation gets wrong. */
export const reversal = (speed: number, atTick: number): Traj => (t) =>
  t <= atTick ? t * speed * SIM_DT : (atTick - (t - atTick)) * speed * SIM_DT

export interface RunOpts {
  ticks: number
  traj: Traj
  /** Probability a whole snapshot is lost (all-or-nothing: one lost BLE fragment
   * loses the message). */
  snapLoss: number
  seed: number
  strategy: Strategy
  /** One-way link latency in ms — a snapshot describes the world this long ago. */
  latencyMs: number
  /** Deterministic drops by snapshot index (1-based), for reproducible figures.
   * When present, `snapLoss` is ignored. */
  forcedDrops?: number[]
}

export interface RunResult {
  samples: Sample[]
  /** Wall-clock gaps between APPLIED snapshots, in ms. */
  gapsMs: number[]
}

export const run = (o: RunOpts): RunResult => {
  const rnd = mulberry32(o.seed)
  const forced = o.forcedDrops ? new Set(o.forcedDrops) : null
  let snapIdx = 0
  const latTicks = Math.round((o.latencyMs / 1000) * SIM_RATE)

  let pos = o.traj(0)
  let prev = pos
  // Latest applied snapshot target + the one before it (for velocity inference).
  let target = pos
  let targetTick = 0
  let prevTarget = pos
  let prevTargetTick = 0
  let lastAppliedTick = 0
  const gapsMs: number[] = []
  const samples: Sample[] = []
  // Interpolation buffer: (simTick, position) history of applied snapshots, plus
  // a LOCAL RENDER CLOCK that advances every tick regardless of arrivals. Tying
  // render time to arrivals is the classic mistake: it re-injects the very
  // stutter interpolation exists to remove.
  const buf: { t: number; x: number }[] = [{ t: 0, x: pos }]
  let renderClock = 0
  let clockInit = false

  for (let tick = 1; tick <= o.ticks; tick++) {
    // --- snapshot arrival (host sends every 3 ticks; arrives `latTicks` later)
    const sentTick = tick - latTicks
    if (sentTick > 0 && sentTick % SNAPSHOT_INTERVAL_TICKS === 0) {
      snapIdx++
      const lost = forced ? forced.has(snapIdx) : rnd() < o.snapLoss
      if (!lost) {
        prevTarget = target
        prevTargetTick = targetTick
        target = o.traj(sentTick)
        targetTick = sentTick
        buf.push({ t: sentTick, x: target })
        if (buf.length > 40) buf.shift()
        gapsMs.push(((tick - lastAppliedTick) * 1000) / SIM_RATE)
        lastAppliedTick = tick
      }
    }

    prev = pos // netClient.ts:443

    switch (o.strategy.kind) {
      case 'current': {
        const d = target - pos
        const k = o.strategy.smooth ?? SMOOTH
        if (Math.abs(d) > SNAP_DIST) pos = target
        else pos += d * k
        break
      }
      case 'interp': {
        // Render `delayMs` behind the newest snapshot's SIM time, on a clock that
        // advances CONTINUOUSLY (1 tick per tick) and is drift-corrected toward
        // the target offset. Always between two known states; never guesses.
        const delayTicks = (o.strategy.delayMs / 1000) * SIM_RATE
        const want = targetTick - delayTicks
        if (!clockInit) { renderClock = want; clockInit = true }
        else {
          renderClock += 1
          const drift = want - renderClock
          if (Math.abs(drift) > 15) renderClock = want // gross desync: resync hard
          else renderClock += drift * 0.02 // gentle time dilation
        }
        // Clamp: never render past the newest known state (that would be
        // extrapolation). Past the newest sample the entity FREEZES.
        const newest = buf[buf.length - 1]
        const rt = Math.min(renderClock, newest.t)
        let a = buf[0], b = newest
        for (let i = 0; i < buf.length - 1; i++) {
          if (buf[i].t <= rt && buf[i + 1].t >= rt) { a = buf[i]; b = buf[i + 1]; break }
        }
        const span = b.t - a.t
        const f = span > 0 ? Math.min(1, Math.max(0, (rt - a.t) / span)) : 1
        pos = a.x + (b.x - a.x) * f
        break
      }
      case 'deadReckon': {
        // Infer velocity from the last two applied snapshots, project forward,
        // then ease toward that projection with the same filter.
        const dt = targetTick - prevTargetTick
        const v = dt > 0 ? (target - prevTarget) / dt : 0
        const ahead = Math.min(tick - targetTick, (o.strategy.capMs / 1000) * SIM_RATE)
        const proj = target + v * Math.max(0, ahead)
        const d = proj - pos
        if (Math.abs(d) > SNAP_DIST) pos = proj
        else pos += d * SMOOTH
        break
      }
      case 'hybrid': {
        const dt = targetTick - prevTargetTick
        const v = dt > 0 ? (target - prevTarget) / dt : 0
        const capTicks = (o.strategy.capMs / 1000) * SIM_RATE
        // Project forward only over the NORMAL interval; past the cap, hold
        // (freeze) rather than run away.
        const ahead = Math.min(Math.max(0, tick - targetTick), capTicks)
        const proj = target + v * ahead
        const d = proj - pos
        if (Math.abs(d) > SNAP_DIST) pos = proj
        else pos += d * o.strategy.smooth
        break
      }
    }

    const trueX = o.traj(tick)
    samples.push({
      tick,
      trueX,
      renderX: pos,
      speed: Math.abs(pos - prev) * SIM_RATE, // tiles/s as drawn
      err: pos - trueX,
    })
  }
  return { samples, gapsMs }
}

export interface Metrics {
  meanAbsErr: number
  maxAbsErr: number
  /** Apparent on-screen speed statistics, tiles/s. */
  minSpeed: number
  maxSpeed: number
  meanSpeed: number
  /** Worst single-tick change in apparent speed — the "jerk" a player sees. */
  maxJerk: number
  /** RMS jerk: overall visual roughness. */
  rmsJerk: number
  /** Ticks where apparent speed fell below 25% of true speed: a visible stall. */
  stallTicks: number
  /** Ticks where apparent speed exceeded 175% of true: a visible dart. */
  dartTicks: number
  snaps: number
}

export const metrics = (s: Sample[], trueSpeed: number, warmup = 30): Metrics => {
  const w = s.slice(warmup)
  const errs = w.map((x) => Math.abs(x.err))
  const speeds = w.map((x) => x.speed)
  const jerks: number[] = []
  for (let i = 1; i < w.length; i++) jerks.push(Math.abs(w[i].speed - w[i - 1].speed))
  return {
    meanAbsErr: errs.reduce((a, b) => a + b, 0) / errs.length,
    maxAbsErr: Math.max(...errs),
    minSpeed: Math.min(...speeds),
    maxSpeed: Math.max(...speeds),
    meanSpeed: speeds.reduce((a, b) => a + b, 0) / speeds.length,
    maxJerk: Math.max(...jerks),
    rmsJerk: Math.sqrt(jerks.reduce((a, b) => a + b * b, 0) / jerks.length),
    stallTicks: speeds.filter((v) => v < trueSpeed * 0.25).length,
    dartTicks: speeds.filter((v) => v > trueSpeed * 1.75).length,
    snaps: 0,
  }
}
