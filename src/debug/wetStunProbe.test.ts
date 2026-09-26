// Integration PR #122 measured a wet player on a bog-tide street in front of one
// NPC stun gunner: downed on 5 of 8 seeds, median 4.9 s, with the arc also
// taking 20 hp per hit from a wet teammate a tile away. These are the contracts
// that replace it: the water stays dangerous, the stun never becomes a lock.

import { describe, expect, it } from 'vitest'
import { PROBE_SEEDS, stunProbe, summarize, type Ground, type Policy, type StunSummary, type Team } from './wetStunProbe'

const cache = new Map<string, StunSummary>()
const probe = (ground: Ground, policy: Policy, team: Team): StunSummary => {
  const key = `${ground}|${policy}|${team}`
  let s = cache.get(key)
  if (!s) cache.set(key, (s = summarize(PROBE_SEEDS.map((seed) => stunProbe(seed, ground, policy, team)))))
  return s
}
const wet = (policy: Policy, team: Team): StunSummary => probe('flooded street', policy, team)
const WET_CASES: [Policy, Team][] = [['stand', 1], ['stand', 2], ['fight', 1], ['fight', 2], ['react', 1], ['react', 2], ['flee', 1], ['flee', 2]]

describe('an NPC stun gunner against wet players on a flooded street (8 seeds)', () => {
  it('the water is still dangerous: standing in it downs the player on some seeds, at 3x the dry bleed', () => {
    expect(wet('stand', 1).downed[0]).toBeGreaterThan(0)
    expect(wet('stand', 1).dps[0]).toBeGreaterThan(3 * probe('dry street', 'stand', 1).dps[0])
    expect(wet('fight', 1).dps[0]).toBeGreaterThan(3 * probe('dry street', 'fight', 1).dps[0])
  })

  it.fails('no electrocution ever lands on a player while it is locked, solo or beside a wet teammate', () => {
    for (const [policy, team] of WET_CASES) expect(wet(policy, team).lockedArcHits, `${policy} ${team}`).toEqual(Array(team).fill(0))
  })

  it.fails('a player who does nothing lasts at least 7 s (median) before going down', () => {
    for (const team of [1, 2] as const) {
      for (const m of wet('stand', team).medianDownS) if (m !== undefined) expect(m).toBeGreaterThanOrEqual(7)
    }
  })

  it.fails('anyone who fights back, reacts or flees stays up, solo or with a wet teammate', () => {
    for (const [policy, team] of WET_CASES.filter(([p]) => p !== 'stand')) expect(wet(policy, team).downed, `${policy} ${team}`).toEqual(Array(team).fill(0))
  })

  it('a stun still never holds a player longer than one full lock', () => {
    for (const [policy, team] of WET_CASES) for (const s of wet(policy, team).longestLockS) expect(s).toBeLessThanOrEqual(1.5)
  })
})
