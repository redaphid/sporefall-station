// Comparing two worlds the way a HUMAN means it: "is this the same world?" —
// not "are these the same bytes?".
//
// WHY THIS EXISTS AT ALL
// `firstDifference` (stateLink.ts) demands bit-exact equality, which is the
// right bar for a self-check that runs on ONE machine. It is the wrong bar the
// moment the two worlds were computed on two different engines. `Math.sin`,
// `Math.cos`, `Math.atan2` and `Math.hypot` are explicitly NOT required by
// ECMAScript to be correctly rounded, so an Android webview and desktop V8 can
// legitimately return neighbouring doubles for the same input. The sim calls
// those functions on every AI tick. Result: a `?state=` link shared from a
// phone to a laptop would refuse to show the world at all — over noise in the
// last bit of a float. Refusing to show a bug is a worse failure than showing
// it a hair off, so the replay path compares with tolerance instead.
//
// WHAT IS DELIBERATELY *NOT* TOLERANT — read this before widening anything
// A tolerance that swallows everything is worse than no check, because it still
// looks like protection. Three classes stay bit-exact, forever:
//
//   1. PRNG stream positions (`rng`, `baseRng`). The determinism keystone. Two
//      worlds identical in every visible way but sitting at different cursors
//      behave differently on the VERY NEXT TICK. A tolerant comparison here
//      would be actively dishonest.
//   2. Identity: entity ids, entity COUNT, `seed`, `floor`, `levelChecksum`,
//      `tick`, `nextId`. A missing entity or a different level is a different
//      world at any epsilon.
//   3. Anything discrete: strings, booleans, enums, and any pair of values that
//      are BOTH integers. Counts, hp, ammo, cooldown ticks and mission counters
//      are integers; float noise never turns 3 into 4, so demanding exactness
//      there costs nothing and catches real divergence for free.
//
// So the tolerance applies to exactly one thing: a pair of numbers where at
// least one is non-integral — positions, velocities, angles, fractional timers.
//
// POLICY LIVES IN THE CALLER, NOT HERE
// `compareWorlds` reports; it never decides. It returns "these diverged, here,
// by this much" or `null`, and the call site chooses what that means. A shared
// link that diverges refuses to load; a save game that diverges may well want
// to load anyway with a warning. Same comparison, different blast radius — so
// the verdict is not baked in.

import type { FieldDifference } from './stateLink'

/**
 * The RELATIVE tolerance for float comparison. Relative, not absolute: an
 * absolute epsilon tuned at the origin is meaningless at x = 400, where a
 * double's own spacing is already ~5e-14.
 *
 * CHOSEN ON MEASURED DATA, not vibes. A sweep of 90 replays — 15 seeds, fully
 * populated floors (90-236 entities), 70- and 400-tick run-ups — was replayed
 * against an emulated platform whose libm returns a neighbouring double from
 * every transcendental call. Worst relative drift observed:
 *
 *     libm  1 ulp off (what a real engine does) : 6.0e-14
 *     libm  4 ulp off (pessimistic)             : 2.3e-13
 *     libm 16 ulp off (stress, not a real engine): 2.3e-13
 *
 * Two things that sweep establishes and that this number depends on:
 *   - The error does NOT compound. A 400-tick run-up is no worse than a
 *     70-tick one, and a 16x worse libm is not 16x worse drift; it saturates.
 *   - In all 90 runs the PRNG cursor and the entity count were BIT-IDENTICAL.
 *     Float noise of this size never flipped a branch, so tolerating it does
 *     not tolerate behavioural change.
 *
 * 1e-10 therefore sits ~440x above the worst drift the most pessimistic model
 * produced, and ~1700x above what a realistic 1-ulp engine produces — enough
 * margin that a legitimate world is not refused over a floor or an archetype
 * the sweep happened not to cover. It is still ~7 orders of magnitude BELOW the
 * smallest distance the sim can act on (the tightest AI threshold is
 * NODE_ARRIVE at 0.45 tiles; at a coordinate of 100 this tolerance permits
 * 1e-8 tiles). Nothing that could change behaviour fits in that gap.
 *
 * ONE NAMED CONSTANT ON PURPOSE. The same comparison is intended to gate save
 * loading, where a false refusal costs somebody their run rather than a link.
 * Whoever retunes it should have exactly one place to change and the numbers
 * above to argue with.
 */
export const WORLD_FLOAT_TOLERANCE = 1e-10

/** Why a given field was held to bit-exactness, or that it was a float compare. */
export type DivergenceKind =
  /** Shape: array length, missing key, or a type change. */
  | 'shape'
  /** PRNG stream position. Never tolerant. */
  | 'prng'
  /** Identity: ids, seed, floor, tick, level checksum, entity count. Never tolerant. */
  | 'identity'
  /** Both values integers, or a non-number (string/bool/null). Never tolerant. */
  | 'discrete'
  /** A float pair that exceeded the relative tolerance. */
  | 'float'

export interface WorldDivergence extends FieldDifference {
  kind: DivergenceKind
  /** `|expected - actual|`, for numeric divergences. */
  delta?: number
  /** `delta / max(1, |expected|, |actual|)` — what the tolerance is compared against. */
  relative?: number
  /** The tolerance that was applied, when one was. */
  tolerance?: number
  /**
   * One line, ready to show a human: names the field, BOTH values, and — for a
   * float — how far apart they are versus how far apart they were allowed to
   * be. Without the magnitude nobody can tell last-ULP noise from a broken sim,
   * which is the entire judgement this check exists to support.
   */
  reason: string
}

export interface WorldCompareOptions {
  /** Relative float tolerance. Defaults to {@link WORLD_FLOAT_TOLERANCE}. */
  epsilon?: number
}

/**
 * Root-level `WorldJson` keys that are never compared with tolerance.
 *
 * `rng`/`baseRng` are called out separately below so their failure message can
 * explain WHY they are special; the rest are identity.
 */
const EXACT_ROOT = new Set([
  'v',
  'seed',
  'floor',
  'tick',
  'nextId',
  'levelChecksum',
  'gameOver',
  'hostile',
  'mode',
  'revivesLeft',
])

/** The two PRNG cursors. Their own set purely so the report can say why. */
const PRNG_ROOT = new Set(['rng', 'baseRng'])

/** Key names that mean identity wherever they appear (e.g. `entities[7].id`). */
const IDENTITY_KEYS = new Set(['id'])

const brief = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s === undefined) return 'undefined'
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

/**
 * Relative closeness. `max(1, ...)` in the denominator so the test degrades to
 * an ABSOLUTE epsilon near zero — otherwise comparing 1e-18 against 0 would
 * demand infinite precision and a velocity that has coasted to a stop would
 * report a divergence forever.
 */
const withinTolerance = (a: number, b: number, eps: number): boolean =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

const divergence = (
  path: string,
  expected: unknown,
  actual: unknown,
  kind: DivergenceKind,
  why: string,
  extra: Partial<WorldDivergence> = {},
): WorldDivergence => {
  const here = path || '<root>'
  const e = brief(expected)
  const a = brief(actual)
  return {
    path: here,
    expected: e,
    actual: a,
    kind,
    reason: `${here}: expected ${e}, got ${a} — ${why}`,
    ...extra,
  }
}

const walk = (a: unknown, b: unknown, path: string, eps: number, depth: number): WorldDivergence | null => {
  if (a === b) return null
  const here = path || '<root>'
  const leafKey = path.slice(path.lastIndexOf('.') + 1)

  // ---- numbers: the only place tolerance can apply ------------------------
  if (typeof a === 'number' && typeof b === 'number') {
    const delta = Math.abs(a - b)

    // The determinism keystone. Stated first and separately so nobody widens it
    // by accident while widening "positions".
    if (depth === 1 && PRNG_ROOT.has(leafKey))
      return divergence(
        path,
        a,
        b,
        'prng',
        'PRNG stream position — never compared with tolerance: two worlds that differ here ' +
          'behave differently on the very next tick',
        { delta },
      )

    if (depth === 1 && EXACT_ROOT.has(leafKey))
      return divergence(path, a, b, 'identity', 'world identity — never compared with tolerance', { delta })

    if (IDENTITY_KEYS.has(leafKey))
      return divergence(path, a, b, 'identity', 'entity identity — never compared with tolerance', { delta })

    // NaN/Infinity never survive JSON, but if one ever appeared it is a genuine
    // fault and must not be quietly tolerated.
    if (!Number.isFinite(a) || !Number.isFinite(b))
      return divergence(path, a, b, 'discrete', 'non-finite number', { delta })

    // Both integers => discrete. Float noise cannot turn 3 into 4, so exactness
    // here is free, and it makes every count, hp, ammo and cooldown tick in the
    // world an exact check without having to enumerate them.
    if (Number.isInteger(a) && Number.isInteger(b))
      return divergence(path, a, b, 'discrete', `both values are whole numbers (differ by ${delta})`, { delta })

    if (withinTolerance(a, b, eps)) return null

    const relative = delta / Math.max(1, Math.abs(a), Math.abs(b))
    return divergence(
      path,
      a,
      b,
      'float',
      `differs by ${delta.toExponential(3)} (relative ${relative.toExponential(3)}), ` +
        `which exceeds the ${eps.toExponential(0)} relative tolerance`,
      { delta, relative, tolerance: eps },
    )
  }

  const bothObjects = typeof a === 'object' && typeof b === 'object' && a !== null && b !== null
  if (!bothObjects) {
    // A key absent on one side and `undefined` on the other is a JSON artefact
    // (a live NPC carries `ai.path === undefined`; its restored twin has no
    // `path` key at all), not a real divergence. `null` is NOT excused — it
    // survives JSON intact, so a value/null change is real.
    if (a === undefined && b === undefined) return null
    return divergence(path, a, b, typeof a === typeof b ? 'discrete' : 'shape', 'values are not equal')
  }

  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return divergence(path, a, b, 'shape', 'one is an array and the other is not')

  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    // Length is identity, not a value: a missing entity is a different world at
    // any epsilon, so this is reported before anything is compared elementwise.
    if (x.length !== y.length)
      return divergence(
        `${here}.length`,
        x.length,
        y.length,
        'identity',
        `${here} has a different number of elements — a different world at any tolerance`,
        { delta: Math.abs(x.length - y.length) },
      )
    for (let i = 0; i < x.length; i++) {
      const d = walk(x[i], y[i], `${path}[${i}]`, eps, depth + 1)
      if (d) return d
    }
    return null
  }

  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    const d = walk(x[k], y[k], path ? `${path}.${k}` : k, eps, depth + 1)
    if (d) return d
  }
  return null
}

/**
 * Walk two serialized worlds and report the FIRST field that genuinely differs,
 * depth-first in a stable key order — or `null` when they are the same world.
 *
 * Mirrors `firstDifference`'s traversal and path format (`entities[3].pos.x`)
 * so the two are interchangeable at a call site and a reader who knows one
 * knows the other. The only thing that changes is the rule at the leaves.
 *
 * Reports. Does not decide — see the note at the top of this file.
 */
export const compareWorlds = (
  expected: unknown,
  actual: unknown,
  options: WorldCompareOptions = {},
): WorldDivergence | null => walk(expected, actual, '', options.epsilon ?? WORLD_FLOAT_TOLERANCE, 0)
