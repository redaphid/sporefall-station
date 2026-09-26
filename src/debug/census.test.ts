import { describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import type { Entity } from '../game/entity'
import { applyScenario } from '../game/scenarios'
import { emptyInput } from '../game/types'
import type { World } from '../game/world'
import {
  botInput,
  byStrength,
  CENSUS_BUILDS,
  FIGHT_TICKS,
  reachProbe,
  renderCensus,
  runFight,
  summarize,
  type CensusBuild,
  type FightResult,
} from './census'

const build = (name: string): CensusBuild => {
  const b = CENSUS_BUILDS.find((x) => x.name === name)
  if (!b) throw new Error(`no census build "${name}"`)
  return b
}

const staged = (at: { x: number; y: number }[]): { w: World; me: Entity; cast: Entity[] } => {
  const w = new HostSession(303, { sample: emptyInput }).world
  applyScenario(w, 'arena-kiter')
  const me = w.entities.find((e) => e.playerCtl)!
  const cast = w.entities.filter((e) => e.ai)
  cast.forEach((e, i) => {
    e.pos = { x: me.pos.x + at[i].x, y: me.pos.y + at[i].y }
  })
  return { w, me, cast }
}

describe('botInput', () => {
  it('aims at the nearest living foe and fires without moving while healthy and uncrowded', () => {
    const { w, me, cast } = staged([
      { x: 6, y: 0 },
      { x: 3, y: 1 },
      { x: 0, y: 5 },
    ])
    expect(botInput(w, me)).toEqual({ aimAt: cast[1].id, attack: true })
    cast[1].dead = true
    expect(botInput(w, me)).toEqual({ aimAt: cast[2].id, attack: true })
  })

  it('walks straight away from a foe inside 1.5 tiles', () => {
    const { w, me, cast } = staged([
      { x: 0.6, y: 0.8 },
      { x: 6, y: 0 },
      { x: 0, y: 5 },
    ])
    const input = botInput(w, me)
    expect(input?.aimAt).toBe(cast[0].id)
    expect(input?.moveX).toBeCloseTo(-0.6)
    expect(input?.moveY).toBeCloseTo(-0.8)
  })

  it('walks away from the nearest foe below half health, even at range', () => {
    const { w, me, cast } = staged([
      { x: 4, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 5 },
    ])
    me.health!.hp = 59
    expect(botInput(w, me)).toEqual({ aimAt: cast[0].id, attack: true, moveX: -1, moveY: 0 })
    me.health!.hp = 60
    expect(botInput(w, me)).toEqual({ aimAt: cast[0].id, attack: true })
  })

  it('has nothing to do once no foe is alive', () => {
    const { w, me, cast } = staged([
      { x: 4, y: 0 },
      { x: 6, y: 0 },
      { x: 0, y: 5 },
    ])
    for (const e of cast) e.dead = true
    expect(botInput(w, me)).toBeUndefined()
  })
})

describe('runFight (a tiny census subset)', () => {
  const subset: [string, string][] = [
    ['arena-brute', 'none'],
    ['arena-brute', 'seq hand fire-lead'],
    ['arena-cinder', 'hand'],
  ]

  it('replays byte-identically: same arena, build and seed give the same fight', () => {
    for (const [arena, b] of subset) expect(runFight(arena, build(b), 303)).toEqual(runFight(arena, build(b), 303))
  })

  it('ends every fight in exactly one consistent outcome', () => {
    for (const [arena, b] of subset) {
      const f = runFight(arena, build(b), 303)
      expect(f.ticks).toBeLessThanOrEqual(FIGHT_TICKS)
      expect(f.damageTaken).toBeGreaterThanOrEqual(0)
      if (f.outcome === 'won') expect(f.foeHpLeft).toBe(0)
      else expect(f.foeHpLeft).toBeGreaterThan(0)
      if (f.outcome === 'downed') expect(f.damageTaken).toBeGreaterThanOrEqual(120)
      if (f.outcome === 'timeout') expect(f.ticks).toBe(FIGHT_TICKS)
    }
  })

  it('downs a passive player in the brute arena, and the hp trace hash tells two different fights apart', () => {
    const passive = runFight('arena-brute', build('none'), 303, 'passive')
    expect(passive.outcome).toBe('downed')
    expect(passive.foeHpLeft).toBe(passive.foeHpMax)
    expect(runFight('arena-brute', build('none'), 303).hpTraceHash).not.toBe(passive.hpTraceHash)
  })

  it('refuses an arena it does not know', () => {
    expect(() => runFight('arena-nowhere', build('none'), 303)).toThrow('unknown arena')
  })
})

describe('reachProbe', () => {
  it('starts the foe the given distance away and credits hits on it only when the player fires', () => {
    const still = reachProbe('gangster', 303, 6, false)
    const firing = reachProbe('gangster', 303, 6, true)
    expect(still.closest).toBeLessThanOrEqual(6)
    expect(still.foeDamage).toBe(0)
    expect(firing.foeDamage).toBeGreaterThan(0)
    expect(reachProbe('gangster', 303, 6, true)).toEqual(firing)
  })
})

describe('summarize and renderCensus', () => {
  const fight = (build: string, outcome: FightResult['outcome'], ticks: number, damageTaken: number, foeHpLeft = 0): FightResult => ({
    arena: 'arena-brute',
    build,
    seed: 1,
    policy: 'bot',
    outcome,
    ticks,
    damageTaken,
    foeHpLeft,
    foeHpMax: 95,
    hpTraceHash: '0',
  })

  it('ranks by wins, then downs, then foe hp left, then damage, then kill time', () => {
    const rows = [
      summarize('slow', [fight('slow', 'won', 300, 0), fight('slow', 'won', 300, 0)]),
      summarize('lost', [fight('lost', 'won', 100, 0), fight('lost', 'downed', 80, 120, 40)]),
      summarize('hurt', [fight('hurt', 'won', 100, 50), fight('hurt', 'won', 100, 50)]),
      summarize('fast', [fight('fast', 'won', 100, 0), fight('fast', 'won', 120, 0)]),
      summarize('stalled', [fight('stalled', 'won', 100, 0), fight('stalled', 'timeout', FIGHT_TICKS, 10, 40)]),
    ].sort(byStrength)
    expect(rows.map((r) => r.build)).toEqual(['fast', 'slow', 'hurt', 'stalled', 'lost'])
    expect(rows[0]).toEqual({ build: 'fast', fights: 2, wins: 2, downs: 0, timeouts: 0, distinctFights: 1, medianTtk: 110, meanDamage: 0, meanFoeHpLeftWhenNotWon: undefined })
  })

  it('ties two builds that never won on the same terms, and counts a replayed fight once', () => {
    const a = summarize('a', [fight('a', 'downed', 90, 120, 40)])
    const b = summarize('b', [fight('b', 'downed', 60, 120, 40)])
    expect(byStrength(a, b)).toBe(0)
    expect(summarize('c', [{ ...fight('c', 'won', 90, 0), hpTraceHash: 'x' }, { ...fight('c', 'won', 90, 0), hpTraceHash: 'x' }, { ...fight('c', 'won', 90, 0), hpTraceHash: 'y' }]).distinctFights).toBe(2)
  })

  it('renders the build x arena matrix with the column winner in bold', () => {
    const md = renderCensus({
      arenas: ['arena-brute'],
      seeds: [1],
      rooms: ['seed 1: test room'],
      fights: [fight('none', 'downed', 90, 120, 40), fight('frost', 'won', 150, 30), { ...fight('hand', 'won', 150, 30), hpTraceHash: '0' }],
      reach: [],
      reachArchetype: 'gangster',
    })
    expect(md).toContain('| build | arena-brute |')
    expect(md).toContain('| frost | **1/1 · 30** |')
    expect(md).toContain('| none | 0/1 · 120 |')
    expect(md).toContain('| hand | **1/1 · 30** |')
    expect(md).toContain('| arena-brute | frost = hand: 1/1 won, 5.0 s, 30 dmg | none: 0/1 won, n/a s, 120 dmg | 1/1 won, 5.0 s, 30 dmg | 1/3 |')
    expect(md).toContain('- arena-brute: none = frost = hand.')
  })
})
