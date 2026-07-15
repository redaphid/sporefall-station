import { describe, expect, it } from 'vitest'
import { hashLabel, mulberry32 } from './rng'

describe('mulberry32', () => {
  it('is deterministic for the same seed', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next())
  })

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const same = Array.from({ length: 100 }, () => a.next() === b.next()).filter(Boolean)
    expect(same.length).toBeLessThan(5)
  })

  it('int() stays within inclusive bounds and hits both ends', () => {
    const rng = mulberry32(99)
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(3, 7)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
      seen.add(v)
    }
    expect(seen).toEqual(new Set([3, 4, 5, 6, 7]))
  })

  it('forks are stable regardless of draw order on the parent', () => {
    const a = mulberry32(42)
    a.next()
    a.next()
    const forkA = a.fork('levelgen')

    const b = mulberry32(42)
    const forkB = b.fork('levelgen')

    for (let i = 0; i < 100; i++) expect(forkA.next()).toBe(forkB.next())
  })

  it('forks with different labels diverge', () => {
    const rng = mulberry32(42)
    expect(rng.fork('levelgen').next()).not.toBe(rng.fork('sim').next())
  })

  it('state() captures a position that reconstructs the identical sequence', () => {
    const a = mulberry32(777)
    for (let i = 0; i < 137; i++) a.next() // advance to an arbitrary mid-stream point

    // Rebuild from the seed + captured counter — the resume must be exact.
    const b = mulberry32(777, a.state())
    for (let i = 0; i < 500; i++) expect(b.next()).toBe(a.next())
  })

  it('state() of a fresh rng round-trips (zero draws)', () => {
    const a = mulberry32(999)
    const b = mulberry32(999, a.state())
    for (let i = 0; i < 100; i++) expect(b.next()).toBe(a.next())
  })

  it('a reconstructed FORK resumes exactly (the serialize path)', () => {
    // Mirrors how a world resumes its sim stream: fork a labelled child, advance
    // it, then rebuild that child from hashLabel(seed, label) + its state().
    const seed = 314159
    const child = mulberry32(seed).fork('sim:1')
    for (let i = 0; i < 40; i++) child.next()

    const rebuilt = mulberry32(hashLabel(seed >>> 0, 'sim:1'), child.state())
    for (let i = 0; i < 200; i++) expect(rebuilt.next()).toBe(child.next())
  })
})
