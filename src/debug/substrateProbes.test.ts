import { describe, expect, it } from 'vitest'
import { CENSUS_BUILDS, runFight } from './census'
import { kiterAtRange, stunProbe, teamFight } from './substrateProbes'

const build = (name: string) => CENSUS_BUILDS.find((b) => b.name === name)!

describe('substrate probes', () => {
  it('a team of one replays the census fight tick for tick', () => {
    for (const [arena, b] of [
      ['arena-brute', 'frost'],
      ['arena-bog-boss', 'shock'],
      ['arena-bog-boss-stock', 'seq hand shock-lead'],
    ] as const) {
      const solo = runFight(arena, build(b), 303)
      const team = teamFight(arena, build(b), 303, 1)
      expect({ outcome: team.outcome, ticks: team.ticks, damage: team.damage[0] }, `${arena} ${b}`).toEqual({
        outcome: solo.outcome,
        ticks: solo.ticks,
        damage: solo.damageTaken,
      })
    }
  })

  it('fields a second player beside the first, and loses only once both are down', () => {
    const r = teamFight('arena-bog-boss-stock', build('none'), 303, 2)
    expect(r.outcome).toBe('downed')
    expect(r.damage[0]).toBeGreaterThanOrEqual(120)
    expect(r.damage[1]).toBeGreaterThanOrEqual(120)
    expect(r.ticks).toBeGreaterThan(runFight('arena-bog-boss-stock', build('none'), 303).ticks)
  })

  it('a stun gun never arcs on dry ground', () => {
    const r = stunProbe(303, 'dry room', 2)
    expect(r.shots).toBeGreaterThan(0)
    expect(r.arcHits).toEqual([0, 0])
  })

  it('a stun gun on flooded ground arcs through both wet players and hurts more than on dry ground', () => {
    const dry = stunProbe(303, 'dry room', 2)
    const wet = stunProbe(303, 'flooded room', 2)
    expect(wet.arcHits[0]).toBeGreaterThan(0)
    expect(wet.arcHits[1]).toBeGreaterThan(0)
    expect(wet.damage[0] + wet.damage[1]).toBeGreaterThan(dry.damage[0] + dry.damage[1])
  })

  it('kiters staged out of sight replay identically, and gunfire draws a reply from 12 tiles', () => {
    const a = kiterAtRange(303, 12, build('none'))
    expect(kiterAtRange(303, 12, build('none'))).toEqual(a)
    expect(a.firstReply).toBeDefined()
    expect(a.damage).toBeGreaterThan(0)
  })
})
