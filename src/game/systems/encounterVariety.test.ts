// #78 follow-up — the resist-differentiated Sporefall roster (brute/cinder/
// sporeling/robot) is wired into NORMAL floor encounters, so the anti-dominance
// matchups actually come up in a real run (not just scenarios/debug). Injected
// on a dedicated `encounters` rng fork, so the loot/position/weapon streams stay
// byte-identical. Asserts variety, a sane distribution, matchup-reachability,
// and determinism.

import { describe, expect, it } from 'vitest'
import { populateWorld } from '../populate'
import { createWorld, type World } from '../world'

const ROSTER = ['brute', 'cinder', 'sporeling', 'robot'] as const
const built = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  return w
}
const countOf = (w: World, arch: string): number =>
  w.entities.filter((e) => e.archetype === arch && !e.dead).length

describe('#78 encounters — the resist roster shows up in normal play', () => {
  it('every new enemy type appears across a sweep of deep-floor seeds', () => {
    const totals: Record<string, number> = { brute: 0, cinder: 0, sporeling: 0, robot: 0 }
    let floorsWithVariety = 0
    const seeds = 24
    for (let seed = 1; seed <= seeds; seed++) {
      const w = built(seed, 3)
      let present = 0
      for (const a of ROSTER) {
        const c = countOf(w, a)
        totals[a] += c
        if (c > 0) present++
      }
      if (present >= 2) floorsWithVariety++
    }
    // Every archetype is reachable in normal play…
    for (const a of ROSTER) expect(totals[a], `${a} never spawned`).toBeGreaterThan(0)
    // …and most deep floors field at least two distinct new threats.
    expect(floorsWithVariety).toBeGreaterThanOrEqual(seeds * 0.6)
  })

  it('depth scales the swarm: floor 5 fields more spore-vermin than floor 1', () => {
    const sum = (floor: number): number => {
      let n = 0
      for (let seed = 1; seed <= 12; seed++) n += countOf(built(seed, floor), 'sporeling')
      return n
    }
    expect(sum(5)).toBeGreaterThan(sum(1))
  })

  it('spawned encounter enemies carry their resist tables — the matchups are real', () => {
    // Find a real floor with a brute and a cinder and assert their affinities.
    let brute: { resist?: Record<string, number> } | undefined
    let cinder: { resist?: Record<string, number> } | undefined
    for (let seed = 1; seed <= 40 && (!brute || !cinder); seed++) {
      const w = built(seed, 4)
      brute ??= w.entities.find((e) => e.archetype === 'brute' && !e.dead)
      cinder ??= w.entities.find((e) => e.archetype === 'cinder' && !e.dead)
    }
    expect(brute, 'a brute should appear on a floor-4 sweep').toBeDefined()
    expect(cinder, 'a cinder should appear on a floor-4 sweep').toBeDefined()
    expect(brute!.resist!.physical).toBeLessThan(1) // armour → bullets weak
    expect(brute!.resist!.burning).toBeGreaterThan(1) // → burn it
    expect(cinder!.resist!.burning).toBeLessThan(1) // fireproof → shoot it
  })

  it('is deterministic: same seed+floor → the same encounter set', () => {
    const arches = (w: World): string[] => w.entities.map((e) => e.archetype).sort()
    expect(arches(built(9, 4))).toEqual(arches(built(9, 4)))
  })

  it('floor 1 stays gentle: no brutes or robots on the opening deck', () => {
    for (let seed = 1; seed <= 16; seed++) {
      const w = built(seed, 1)
      expect(countOf(w, 'brute')).toBe(0)
      expect(countOf(w, 'robot')).toBe(0)
    }
  })
})
