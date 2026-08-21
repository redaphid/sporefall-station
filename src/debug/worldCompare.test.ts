// The bar this file defends: float NOISE passes, a different WORLD does not.
//
// Half of these tests exist to prove the check can still go RED. A tolerance
// chosen too loosely produces a check that can never fail, which is strictly
// worse than deleting it — it still looks like protection. So every exactness
// rule below is demonstrated by breaking a real world on purpose, and the PRNG
// and identity rules are additionally run at an ABSURD epsilon to prove no
// tolerance can ever swallow them.

import { afterEach, describe, expect, it } from 'vitest'
import { populateWorld, spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { runTicks } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { createWorld, tickWorld, type World } from '../game/world'
import { captureState, StateRing } from './stateLink'
import { compareWorlds, WORLD_FLOAT_TOLERANCE } from './worldCompare'

// ---------------------------------------------------------------------------
// A stand-in for "the other device".
//
// ECMAScript does not require Math.sin/cos/atan2/hypot/pow/exp/log to be
// correctly rounded, so two conforming engines may return doubles one ulp
// apart. (Math.sqrt and + - * / ARE required to be correctly rounded by
// IEEE-754, so they are left alone — they are identical everywhere.) Nudging
// every such call by one ulp is a deliberately pessimistic model of an Android
// webview: real engines differ on SOME inputs, this differs on all of them.
// ---------------------------------------------------------------------------

const bits = new ArrayBuffer(8)
const asFloat = new Float64Array(bits)
const asInt = new BigUint64Array(bits)

/** The double `ulps` steps away from x — the most a conforming libm may differ. */
const ulpOff = (x: number, ulps: bigint): number => {
  if (!Number.isFinite(x) || x === 0) return x
  asFloat[0] = x
  asInt[0] += ulps
  return asFloat[0]!
}

const NATIVE = {
  sin: Math.sin,
  cos: Math.cos,
  atan2: Math.atan2,
  hypot: Math.hypot,
  pow: Math.pow,
  exp: Math.exp,
  log: Math.log,
}

const withForeignLibm = <T>(ulps: bigint, body: () => T): T => {
  Math.sin = (x) => ulpOff(NATIVE.sin(x), ulps)
  Math.cos = (x) => ulpOff(NATIVE.cos(x), ulps)
  Math.atan2 = (y, x) => ulpOff(NATIVE.atan2(y, x), ulps)
  Math.hypot = ((...a: number[]) => ulpOff(NATIVE.hypot(...a), ulps)) as typeof Math.hypot
  Math.pow = (x, y) => ulpOff(NATIVE.pow(x, y), ulps)
  Math.exp = (x) => ulpOff(NATIVE.exp(x), ulps)
  Math.log = (x) => ulpOff(NATIVE.log(x), ulps)
  try {
    return body()
  } finally {
    Object.assign(Math, NATIVE)
  }
}

afterEach(() => {
  Object.assign(Math, NATIVE) // belt and braces: never leak a patched Math
})

// ---- worlds ---------------------------------------------------------------

const DRIVE: Map<number, InputCmd> = new Map([[0, { ...emptyInput(), moveX: 1, attack: true }]])

/** Three entities: small enough to reason about, mid-run enough to have moved. */
const buildMidRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  return runTicks(w, new Map([[0, { moveX: -1, attack: true }]]), 50)
}

/** A real floor: ~130-230 entities, all of them running AI every tick. This is
 * what the drift numbers in `WORLD_FLOAT_TOLERANCE` were measured on. */
const buildPopulated = (seed: number): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  const sp = w.level.spawn
  spawnPlayer(w, 0, sp.x, sp.y)
  return runTicks(w, new Map([[0, { moveX: 1, attack: true }]]), 120)
}

interface Capture {
  captured: WorldJson
  rewind: { world: WorldJson; frames: { inputs: [number, InputCmd][] }[] }
}

/** Capture a world plus the run-up to it, exactly as a shared link does. */
const capture = (build: (seed: number) => World, seed: number, window: number, ticks: number): Capture => {
  const w = build(seed)
  const ring = new StateRing(w, window)
  for (let i = 0; i < ticks; i++) {
    tickWorld(w, new Map(DRIVE))
    ring.observe(w, DRIVE)
  }
  const payload = captureState(w, { note: 'tolerance' }, ring.rewind())
  return JSON.parse(JSON.stringify({ captured: payload.world, rewind: payload.rewind })) as Capture
}

/** Replay a capture's run-up forward — optionally on a foreign libm. */
const replay = (c: Capture, ulps?: bigint): WorldJson => {
  const run = (): WorldJson => {
    const w = deserializeWorld(c.rewind.world)
    for (const f of c.rewind.frames) tickWorld(w, new Map(f.inputs.map(([s, cmd]) => [s, { ...cmd }])))
    return serializeWorld(w)
  }
  return ulps === undefined ? run() : withForeignLibm(ulps, run)
}

/** Largest relative difference between any numeric pair in two snapshots. */
const worstRelativeDrift = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number')
    return a === b ? 0 : Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b))
  if (Array.isArray(a) && Array.isArray(b))
    return a.reduce<number>((m, _, i) => Math.max(m, worstRelativeDrift(a[i], b[i])), 0)
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = a as Record<string, unknown>
    const y = b as Record<string, unknown>
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].reduce(
      (m, k) => Math.max(m, worstRelativeDrift(x[k], y[k])),
      0,
    )
  }
  return 0
}

const SEEDS = [0xdecaf, 0xb0b, 0xa11ce, 0xc0de, 42]

// ===========================================================================
// CRITERION 1 — the divergence he actually hit must now pass.
// ===========================================================================

describe('cross-device float noise loads instead of refusing', () => {
  it('a replay on a 1-ulp-different libm reconverges on a populated floor', () => {
    for (const seed of SEEDS) {
      const c = capture(buildPopulated, seed, 30, 70)
      const played = replay(c, 1n)
      // It really is a DIFFERENT bit pattern — otherwise this test proves nothing.
      expect(JSON.stringify(played)).not.toBe(JSON.stringify(c.captured))
      expect(compareWorlds(c.captured, played)).toBeNull()
    }
  })

  it('still reconverges over a long run-up, and on a 4-ulp-worse libm', () => {
    const long = capture(buildPopulated, 0xdecaf, 180, 400)
    expect(compareWorlds(long.captured, replay(long, 1n))).toBeNull()
    const c = capture(buildPopulated, 0xc0de, 30, 70)
    expect(compareWorlds(c.captured, replay(c, 4n))).toBeNull()
  })

  it('the noise leaves the PRNG cursor and the entity set untouched', () => {
    // WHY THIS MATTERS: it is the evidence that tolerating float noise does not
    // tolerate behavioural change. If a 1-ulp libm flipped an AI branch, the
    // dice count would move and this would fail — and the check SHOULD refuse.
    for (const seed of SEEDS) {
      const c = capture(buildPopulated, seed, 30, 70)
      const played = replay(c, 1n)
      expect(played.rng).toBe(c.captured.rng)
      expect(played.baseRng).toBe(c.captured.baseRng)
      expect(played.entities.length).toBe(c.captured.entities.length)
    }
  })

  it('measures the drift, and shows the tolerance has real margin over it', () => {
    let worst = 0
    for (const seed of SEEDS) {
      const c = capture(buildPopulated, seed, 30, 70)
      worst = Math.max(worst, worstRelativeDrift(c.captured, replay(c, 1n)))
      worst = Math.max(worst, worstRelativeDrift(c.captured, replay(c, 4n)))
    }
    // NOWHERE NEAR zero — this is a real effect, not a theoretical one — but
    // bounded two orders of magnitude under the tolerance. The upper bound is
    // asserted so that if a future change makes the sim AMPLIFY error, this
    // goes red here instead of the tolerance being quietly outgrown in
    // production, which is the failure nobody would notice.
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThan(WORLD_FLOAT_TOLERANCE / 100)
  })
})

// ===========================================================================
// CRITERION 2 — and this matters more. A different world must STILL FAIL.
// ===========================================================================

describe('a genuinely different world still FAILS', () => {
  it('goes RED when a position is nudged', () => {
    const c = capture(buildPopulated, 0xdecaf, 30, 70)
    const played = replay(c, 1n) // float noise AND a real change, together
    const moved = JSON.parse(JSON.stringify(played)) as WorldJson
    const pos = (moved.entities[0] as { pos: { x: number } }).pos
    pos.x += 0.5 // half a tile: visible on screen, nowhere near a rounding artefact

    const d = compareWorlds(c.captured, moved)
    expect(d).not.toBeNull()
    expect(d!.path).toBe('entities[0].pos.x')
    expect(d!.kind).toBe('float')
    expect(d!.reason).toMatch(/expected .* got .* exceeds the 1e-10 relative tolerance/)
  })

  it('goes RED when an entity is removed', () => {
    const c = capture(buildPopulated, 0xb0b, 30, 70)
    const played = replay(c, 1n)
    const short = JSON.parse(JSON.stringify(played)) as WorldJson
    short.entities.splice(5, 1)

    const d = compareWorlds(c.captured, short)
    expect(d).not.toBeNull()
    expect(d!.path).toBe('entities.length')
    expect(d!.kind).toBe('identity')
    // No epsilon, however absurd, may excuse a missing entity.
    expect(compareWorlds(c.captured, short, { epsilon: 1e9 })).not.toBeNull()
  })

  it('goes RED for a different seed', () => {
    const a = serializeWorld(buildMidRun(0xdecaf))
    const b = serializeWorld(buildMidRun(0xdecaf + 1))

    const d = compareWorlds(a, b)
    expect(d).not.toBeNull()
    expect(d!.kind).not.toBe('float') // caught by an exact rule, not a tolerance
    // And the seed field itself is identity even at an absurd epsilon.
    const onlySeed = compareWorlds({ ...a, seed: 1 }, { ...a, seed: 2 }, { epsilon: 1e9 })
    expect(onlySeed?.path).toBe('seed')
    expect(onlySeed?.kind).toBe('identity')
  })

  it('goes RED when the PRNG cursor has drifted by ONE', () => {
    const c = capture(buildPopulated, 0xc0de, 30, 70)
    const played = replay(c, 1n)
    const drifted = { ...played, rng: played.rng + 1 }

    const d = compareWorlds(c.captured, drifted)
    expect(d).not.toBeNull()
    expect(d!.path).toBe('rng')
    expect(d!.kind).toBe('prng')
    expect(d!.reason).toMatch(/never compared with tolerance/)
    // THE KEYSTONE: no epsilon can ever swallow the PRNG cursor.
    expect(compareWorlds(c.captured, drifted, { epsilon: 1e30 })?.kind).toBe('prng')
    expect(compareWorlds(c.captured, { ...played, baseRng: played.baseRng - 1 })?.kind).toBe('prng')
  })
})

// ===========================================================================
// The leaf rules, stated one at a time.
// ===========================================================================

describe('what is tolerant and what is exact', () => {
  it('is RELATIVE, so the bar scales with the coordinate', () => {
    // The same relative error passes at the origin and 400 tiles out. An
    // ABSOLUTE epsilon would be wrong at one end or the other.
    expect(compareWorlds({ x: 1.5 }, { x: 1.5 * (1 + 1e-13) })).toBeNull()
    expect(compareWorlds({ x: 400.5 }, { x: 400.5 * (1 + 1e-13) })).toBeNull()
    expect(compareWorlds({ x: 400.5 }, { x: 400.5 * (1 + 1e-8) })).not.toBeNull()
  })

  it('has a real edge: just inside passes, just outside fails', () => {
    const base = 100.5
    expect(compareWorlds({ x: base }, { x: base + base * (WORLD_FLOAT_TOLERANCE / 2) })).toBeNull()
    expect(compareWorlds({ x: base }, { x: base + base * (WORLD_FLOAT_TOLERANCE * 10) })).not.toBeNull()
  })

  it('never tolerates two whole numbers — counts, hp and ammo stay exact', () => {
    const d = compareWorlds({ hp: 12 }, { hp: 13 }, { epsilon: 1e9 })
    expect(d?.kind).toBe('discrete')
    expect(d?.reason).toMatch(/whole numbers/)
    // ...but a float that merely LANDS on a whole number is still tolerant.
    expect(compareWorlds({ x: 12 }, { x: 12.000000000000002 })).toBeNull()
  })

  it('never tolerates an entity id', () => {
    const d = compareWorlds({ entities: [{ id: 7 }] }, { entities: [{ id: 8 }] }, { epsilon: 1e9 })
    expect(d?.path).toBe('entities[0].id')
    expect(d?.kind).toBe('identity')
  })

  it('never tolerates strings, booleans or a type change', () => {
    expect(compareWorlds({ mode: 'casual' }, { mode: 'normal' })?.kind).toBe('discrete')
    expect(compareWorlds({ gameOver: false }, { gameOver: true })?.kind).toBe('discrete')
    expect(compareWorlds({ a: 1 }, { a: '1' })?.kind).toBe('shape')
    expect(compareWorlds({ a: [1] }, { a: { 0: 1 } })?.kind).toBe('shape')
  })

  it('forgives absent-vs-undefined but not null (a JSON artefact vs a real value)', () => {
    expect(compareWorlds({ a: 1, path: undefined }, { a: 1 })).toBeNull()
    expect(compareWorlds({ a: null }, { a: undefined })?.path).toBe('a')
  })

  it('names the field and BOTH values, so noise is tellable from a broken sim', () => {
    const d = compareWorlds({ entities: [{ pos: { x: 10.5 } }] }, { entities: [{ pos: { x: 12.25 } }] })
    expect(d?.path).toBe('entities[0].pos.x')
    expect(d?.reason).toContain('expected 10.5')
    expect(d?.reason).toContain('got 12.25')
    expect(d?.delta).toBeCloseTo(1.75, 10)
    expect(d?.relative).toBeCloseTo(1.75 / 12.25, 10)
    expect(d?.tolerance).toBe(WORLD_FLOAT_TOLERANCE)
  })

  it('an identical world is null (the comparator is not simply always-true)', () => {
    const c = capture(buildPopulated, 42, 30, 70)
    expect(compareWorlds(c.captured, replay(c))).toBeNull()
    expect(compareWorlds(c.captured, c.captured)).toBeNull()
  })
})
