// Guarding the determinism swap in `simMath.ts` (Math.hypot -> sqrt(x*x + y*y)).
//
// NOTE ON WHAT IS *NOT* TESTED HERE. Asserting `vlen(x, y) === Math.sqrt(x * x +
// y * y)` would restate the implementation and prove nothing, so it is absent on
// purpose. What these tests pin down instead is the part a reader cannot see:
// the SIZE of the accuracy we traded away, the exact magnitudes where the
// substitution stops being valid, and the fact that this sim never goes near
// them. The last test stops the swap being quietly undone.

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { populateWorld } from './populate'
import { spawnPlayer } from './player'
import { playerSpawnPoint } from './spawnPlacement'
import { setupFloor } from './systems/missions'
import { emptyInput, LEVEL_H, LEVEL_W, type InputCmd } from './types'
import { createWorld, tickWorld } from './world'
import { vlen } from './simMath'

/** Distance between two finite positive doubles counted in representable steps
 * ("units in the last place"). 0 means bit-identical. */
const ulpsApart = (a: number, b: number): number => {
  const bits = new BigInt64Array(new Float64Array([a, b]).buffer)
  return Number(bits[0] > bits[1] ? bits[0] - bits[1] : bits[1] - bits[0])
}

describe('vlen vs Math.hypot', () => {
  // The honest cost of the swap. `Math.hypot` is often the more accurate of the
  // two, so results DO move — this bounds how far. If a future engine or edit
  // widens this, the number in simMath.ts's header is no longer true.
  it('differs from Math.hypot by at most 2 ULP at simulation scale', () => {
    let worst = 0
    let worstAt: [number, number] = [0, 0]
    // Sweep the magnitudes the sim actually produces: tile offsets across a
    // 64x64 grid, unit-ish intent vectors, and post-friction velocities.
    for (let i = -640; i <= 640; i += 7) {
      for (let j = -640; j <= 640; j += 13) {
        const x = i / 10
        const y = j / 10
        const d = ulpsApart(vlen(x, y), Math.hypot(x, y))
        if (d > worst) {
          worst = d
          worstAt = [x, y]
        }
      }
    }
    expect(worst, `worst case at (${worstAt[0]}, ${worstAt[1]})`).toBeLessThanOrEqual(2)
  })

  // --- The limits, made executable ------------------------------------------
  // These two are the reason `simMath.ts` says "bounded simulation values" and
  // not "everywhere". They are expected to FAIL to match hypot; that is the point.

  it('overflows to Infinity above ~1.3e154, where Math.hypot stays finite', () => {
    const big = 1e200
    expect(vlen(big, big)).toBe(Infinity) // x * x is Infinity before the sqrt
    expect(Math.hypot(big, big)).toBeCloseTo(big * Math.SQRT2, -195)
    expect(Number.isFinite(Math.hypot(big, big))).toBe(true)
  })

  it('underflows to 0 below ~1.5e-154, where Math.hypot stays exact', () => {
    const tiny = 1e-200
    expect(vlen(tiny, tiny)).toBe(0) // x * x flushes to 0 before the sqrt
    expect(Math.hypot(tiny, tiny)).toBeGreaterThan(0)
  })
})

describe('the simulation stays inside the safe band', () => {
  // The substitution above is only sound because the sim's operands are bounded.
  // This asserts that premise against a real soak rather than trusting a comment:
  // if the world ever grows unbounded coordinates, this fails before a player
  // meets an Infinity.
  it('keeps every position and velocity far from the overflow/underflow limits', () => {
    // Widest magnitude that keeps x * x finite, and smallest that keeps it normal.
    const OVERFLOW_LIMIT = 1.3e154
    const UNDERFLOW_LIMIT = 1.5e-154

    let maxAbs = 0
    let minNonZero = Infinity
    const note = (v: number): void => {
      expect(Number.isFinite(v)).toBe(true)
      const a = Math.abs(v)
      if (a > maxAbs) maxAbs = a
      if (a > 0 && a < minNonZero) minNonZero = a
    }

    for (const seed of [1, 4242]) {
      const w = createWorld(seed, 1, 'normal')
      populateWorld(w)
      setupFloor(w)
      const at = playerSpawnPoint(w.level, 0)
      spawnPlayer(w, 0, at.x, at.y)
      for (let t = 0; t < 300; t++) {
        const ang = t * 0.11 + seed
        const cmd: InputCmd = {
          ...emptyInput(),
          moveX: Math.cos(ang),
          moveY: Math.sin(ang),
          aimX: Math.cos(ang * 1.7),
          aimY: Math.sin(ang * 1.7),
          attack: t % 7 === 0,
        }
        tickWorld(w, new Map([[0, cmd]]))
        for (const e of w.entities) {
          // The operands vlen actually receives are DIFFERENCES of these.
          note(e.pos.x)
          note(e.pos.y)
          note(e.pos.x - e.prevPos.x)
          note(e.pos.y - e.prevPos.y)
          if (e.vel) {
            note(e.vel.x)
            note(e.vel.y)
          }
        }
      }
    }

    // Positions live on the tile grid; nothing should escape it by much.
    expect(maxAbs).toBeLessThan(Math.max(LEVEL_W, LEVEL_H) * 4)
    expect(maxAbs).toBeLessThan(OVERFLOW_LIMIT)
    // movement.ts snaps |vel| < 0.01 to exactly 0, so nothing decays into the
    // subnormal range where x * x would lose its precision.
    expect(minNonZero).toBeGreaterThan(UNDERFLOW_LIMIT)
  })
})

describe('the swap stays swapped', () => {
  // src/game IS the simulation layer. `Math.hypot` is implementation-defined, so
  // a single reintroduction anywhere in here re-opens the cross-device drift this
  // whole change closed — and it would look like a harmless tidy-up in review.
  it('finds no Math.hypot call anywhere under src/game', () => {
    const offenders: string[] = []
    for (const rel of readdirSync('src/game', { recursive: true, encoding: 'utf-8' })) {
      const path = `src/game/${rel}`
      if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue
      const text = readFileSync(path, 'utf-8')
      // `Math.hypot(` — a call. Prose mentions in comments are fine and expected.
      if (text.includes('Math.hypot(')) offenders.push(path)
    }
    expect(offenders, 'use vlen() from src/game/simMath.ts instead').toEqual([])
  })
})
