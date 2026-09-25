// Adversarial unit tests for the observer's pure computation core (digest.ts).
// Run with the STANDALONE config in this directory (the root vitest config only
// includes src/**):  pnpm exec vitest run --config tools/observer/vitest.config.ts

import { describe, expect, it } from 'vitest'
import type { GameInfo } from '../../src/debug/protocol'
import {
  applyEvent,
  applySample,
  createSession,
  estimateTick,
  extractSample,
  formatWakeLine,
  outboxAnnotations,
  pickTarget,
  renderDigest,
  sparkline,
  updateIndex,
  type PlayerSnap,
  type Sample,
  type SessionState,
} from './digest'

// ── Builders ────────────────────────────────────────────────────────────────
const mkPlayer = (over: Partial<PlayerSnap> = {}): PlayerSnap => ({
  id: 7,
  playerId: 0,
  pos: { x: 10, y: 10 },
  vel: { x: 0, y: 0 },
  intent: { x: 0, y: 0 },
  hp: 30,
  maxHp: 30,
  cash: 0,
  weapon: 'pistol',
  mods: [],
  status: [],
  downed: false,
  ...over,
})

const mkSample = (over: Partial<Sample> = {}): Sample => ({
  wallMs: 1_000_000,
  tick: 100,
  seed: 111,
  floor: 1,
  alarm: 0,
  gameOver: false,
  mission: { template: 'steal', description: 'Steal the core', complete: false, exitUnlocked: false, alerted: false },
  players: [mkPlayer()],
  threats: [],
  frozen: false,
  ...over,
})

/** A session that has already absorbed one baseline sample. */
const primed = (over: Partial<Sample> = {}): SessionState => {
  const s = createSession()
  applySample(s, mkSample(over))
  return s
}

const kinds = (wakes: { kind: string }[]): string[] => wakes.map((w) => w.kind)

// ── Run identity ────────────────────────────────────────────────────────────
describe('run identity', () => {
  it('first sample starts a run without a seedChange wake', () => {
    const s = createSession()
    const wakes = applySample(s, mkSample())
    expect(kinds(wakes)).not.toContain('seedChange')
    expect(s.run?.seed).toBe(111)
    expect(s.run?.startTick).toBe(100)
  })

  it('seed change ends the run and wakes, even mid-window', () => {
    const s = primed()
    applyEvent(s, { type: 'death', tick: 120, entityId: 99 }, 1_001_000) // mid-window activity
    const wakes = applySample(s, mkSample({ seed: 222, tick: 5, wallMs: 1_002_000 }))
    expect(kinds(wakes)).toContain('seedChange')
    expect(s.runs).toHaveLength(1)
    expect(s.runs[0].seed).toBe(111)
    expect(s.runs[0].endCause).toBe('reset')
    expect(s.run?.seed).toBe(222)
    expect(s.run?.killsTotal).toBe(0) // the new run's ledger is fresh
  })

  it('a big tick regression on the SAME seed is a run restart', () => {
    const s = primed({ tick: 9000 })
    const wakes = applySample(s, mkSample({ tick: 12, wallMs: 1_060_000 }))
    expect(kinds(wakes)).toContain('seedChange')
    expect(s.runs[0].endCause).toBe('restart')
  })

  it('a small tick wobble is NOT a restart', () => {
    const s = primed({ tick: 9000 })
    const wakes = applySample(s, mkSample({ tick: 8990, wallMs: 1_001_500 }))
    expect(kinds(wakes)).toHaveLength(0)
    expect(s.runs).toHaveLength(0)
  })

  it('gameOver latches once and sets the completed run cause', () => {
    const s = primed()
    const w1 = applySample(s, mkSample({ gameOver: true, tick: 500, wallMs: 1_010_000 }))
    const w2 = applySample(s, mkSample({ gameOver: true, tick: 530, wallMs: 1_011_000 }))
    expect(kinds(w1)).toContain('gameOver')
    expect(kinds(w2)).not.toContain('gameOver')
    applySample(s, mkSample({ seed: 999, tick: 0, wallMs: 1_020_000 }))
    expect(s.runs[0].endCause).toBe('gameOver')
  })
})

// ── Floor / alarm / mission transitions ─────────────────────────────────────
describe('floor, alarm, mission', () => {
  it('floor change wakes once even when the event AND the sample both report it', () => {
    const s = primed()
    const evWakes = applyEvent(s, { type: 'floorChange', tick: 400, floor: 2 }, 1_009_000)
    const smWakes = applySample(s, mkSample({ floor: 2, tick: 410, wallMs: 1_010_000 }))
    expect(kinds(evWakes)).toContain('floorChange')
    expect(kinds(smWakes)).not.toContain('floorChange')
    expect(s.run?.floors.map((f) => f.floor)).toEqual([1, 2])
  })

  it('alarm changes wake with the transition detail', () => {
    const s = primed()
    const wakes = applySample(s, mkSample({ alarm: 3, tick: 200, wallMs: 1_002_000 }))
    expect(wakes.find((w) => w.kind === 'alarmChange')?.detail).toBe('alarm 0→3')
    expect(s.run?.floors[0].alarm3Tick).toBe(200)
  })

  it('missionComplete: event and state-flag paths dedupe on one latch', () => {
    const s = primed()
    const evWakes = applyEvent(s, { type: 'missionComplete', tick: 300, description: 'done' }, 1_005_000)
    const smWakes = applySample(s, mkSample({ tick: 310, wallMs: 1_006_000, mission: { ...mkSample().mission, complete: true } }))
    expect(kinds(evWakes)).toContain('missionComplete')
    expect(kinds(smWakes)).not.toContain('missionComplete')
    expect(s.run?.floors[0].completeTick).toBe(300)
  })

  it('a world that STARTS complete:true (default pre-mission world) never wakes', () => {
    const s = createSession()
    const w1 = applySample(s, mkSample({ mission: { complete: true, template: 'reach' } }))
    const w2 = applySample(s, mkSample({ tick: 150, wallMs: 1_001_500, mission: { complete: true, template: 'reach' } }))
    expect([...kinds(w1), ...kinds(w2)]).not.toContain('missionComplete')
  })
})

// ── HP wake hysteresis ──────────────────────────────────────────────────────
describe('lowHp edge-triggering', () => {
  const hpSample = (hp: number, tick: number): Sample =>
    mkSample({ tick, wallMs: 1_000_000 + tick * 33, players: [mkPlayer({ hp })] })

  it('fires once crossing below 25 and does NOT spam while flapping around it', () => {
    const s = createSession()
    let wakes: string[] = []
    for (const [hp, t] of [[30, 100], [24, 150], [26, 200], [24, 250], [10, 300], [26, 350]] as const)
      wakes = wakes.concat(kinds(applySample(s, hpSample(hp, t))))
    expect(wakes.filter((k) => k === 'lowHp')).toHaveLength(1)
  })

  it('re-arms only after recovering above 50', () => {
    const s = createSession()
    let wakes: string[] = []
    for (const [hp, t] of [[30, 100], [20, 150], [45, 200], [24, 250], [55, 300], [24, 350]] as const)
      wakes = wakes.concat(kinds(applySample(s, hpSample(hp, t))))
    // Crossing at t150 fires; the dip at t250 (only recovered to 45) does not;
    // after t300 (>50) the dip at t350 fires again.
    expect(wakes.filter((k) => k === 'lowHp')).toHaveLength(2)
  })

  it('latches reset on a new run — a fresh run at low hp wakes again', () => {
    const s = createSession()
    applySample(s, hpSample(10, 100)) // fires, disarms
    const wakes = applySample(s, mkSample({ seed: 999, tick: 5, wallMs: 1_050_000, players: [mkPlayer({ hp: 10 })] }))
    expect(kinds(wakes)).toContain('lowHp')
  })

  it('near-death moments are edge-recorded, not one per sample', () => {
    const s = createSession()
    for (const [hp, t] of [[30, 100], [15, 150], [12, 200], [30, 250], [14, 300]] as const)
      applySample(s, hpSample(hp, t))
    expect(s.run?.nearDeaths.map((n) => n.tick)).toEqual([150, 300])
  })
})

// ── Event fold: ledger, attribution, adversarial inputs ─────────────────────
describe('event fold', () => {
  it('deaths of indexed npcs land in the kill ledger by archetype', () => {
    const s = primed()
    updateIndex(s, [{ id: 41, kind: 'npc', archetype: 'brute' }, { id: 42, kind: 'npc', archetype: 'brute' }])
    applyEvent(s, { type: 'death', tick: 120, entityId: 41, x: 0, y: 0 }, 1_001_000)
    applyEvent(s, { type: 'death', tick: 130, entityId: 42, x: 0, y: 0 }, 1_001_100)
    expect(s.run?.kills).toEqual({ brute: 2 })
    expect(s.run?.killsTotal).toBe(2)
  })

  it('a death with an id never indexed still counts (as unknown)', () => {
    const s = primed()
    applyEvent(s, { type: 'death', tick: 120, entityId: 555 }, 1_001_000)
    expect(s.run?.kills.unknown).toBe(1)
  })

  it('a PLAYER death wakes playerDeath and never pollutes the kill ledger', () => {
    const s = primed()
    const wakes = applyEvent(s, { type: 'death', tick: 120, entityId: 7 }, 1_001_000)
    expect(kinds(wakes)).toContain('playerDeath')
    expect(s.run?.killsTotal).toBe(0)
    expect(s.run?.playerDeaths).toBe(1)
  })

  it('hits split into damage taken (player target) vs dealt (npc target)', () => {
    const s = primed()
    updateIndex(s, [{ id: 41, kind: 'npc', archetype: 'brute' }])
    applyEvent(s, { type: 'hit', tick: 120, targetId: 7, amount: 4 }, 1_001_000)
    applyEvent(s, { type: 'hit', tick: 121, targetId: 41, amount: 9 }, 1_001_033)
    expect(s.run?.dmgTaken).toBe(4)
    expect(s.run?.dmgDealt).toBe(9)
    expect(s.run?.dmgTakenLog).toEqual([{ tick: 120, amount: 4 }])
  })

  it('out-of-order ticks never corrupt the ledger or throw', () => {
    const s = primed({ tick: 5000 })
    updateIndex(s, [{ id: 41, kind: 'npc', archetype: 'brute' }])
    applyEvent(s, { type: 'hit', tick: 4990, targetId: 7, amount: 3 }, 1_001_000) // behind
    applyEvent(s, { type: 'death', tick: 4500, entityId: 41 }, 1_001_100) // far behind
    applyEvent(s, { type: 'hit', tick: 5010, targetId: 7, amount: 2 }, 1_001_200)
    expect(s.run?.dmgTaken).toBe(5)
    expect(s.run?.killsTotal).toBe(1)
    expect(s.run?.lastTick).toBe(5010) // a stale tick never rolls the clock back
  })

  it('unknown event types are kept as generic lines, not dropped or fatal', () => {
    const s = primed()
    applyEvent(s, { type: 'someFutureEvent', tick: 120, whatever: 1 }, 1_001_000)
    expect(s.malformedEvents).toBe(0)
    expect(s.recentLines.some((l) => l.text === 'event someFutureEvent')).toBe(true)
  })

  it('malformed events are counted and skipped', () => {
    const s = primed()
    for (const bad of [null, 42, 'x', [], {}, { type: 'hit' }, { tick: 5 }, { type: 7, tick: 5 }, { type: 'hit', tick: NaN }])
      applyEvent(s, bad, 1_001_000)
    expect(s.malformedEvents).toBe(9)
    expect(s.eventCount).toBe(0)
  })

  it('events far AHEAD of the target clock are skipped as another game\'s', () => {
    const s = primed({ tick: 100 })
    applyEvent(s, { type: 'death', tick: 999_999, entityId: 41 }, 1_000_100)
    expect(s.foreignEvents).toBe(1)
    expect(s.run?.killsTotal).toBe(0)
  })

  it('after a run reset, low-tick events from the NEW run are accepted', () => {
    const s = primed({ tick: 50_000 })
    applySample(s, mkSample({ seed: 222, tick: 10, wallMs: 1_001_000 }))
    const wakes = applyEvent(s, { type: 'death', tick: 25, entityId: 7 }, 1_001_100)
    expect(s.foreignEvents).toBe(0)
    expect(kinds(wakes)).toContain('playerDeath')
  })

  it('events with no run yet are safe (no run ledger, no throw)', () => {
    const s = createSession()
    expect(() => applyEvent(s, { type: 'hit', tick: 5, targetId: 1, amount: 2 }, 1_000)).not.toThrow()
  })
})

// ── Boss half-hp wake ───────────────────────────────────────────────────────
describe('bossHalf', () => {
  const bossThreat = (hp: number): Sample =>
    mkSample({ tick: 200, wallMs: 1_002_000, threats: [{ id: 90, archetype: 'boss', dist: 5, hp, maxHp: 200 }] })

  it('fires once when a sampled boss drops below half, never re-fires', () => {
    const s = primed()
    expect(kinds(applySample(s, bossThreat(120)))).not.toContain('bossHalf')
    expect(kinds(applySample(s, { ...bossThreat(90), tick: 230, wallMs: 1_003_000 }))).toContain('bossHalf')
    expect(kinds(applySample(s, { ...bossThreat(40), tick: 260, wallMs: 1_004_000 }))).not.toContain('bossHalf')
  })

  it('also triggers from hit events against a bossReveal-tracked id', () => {
    const s = primed()
    applyEvent(s, { type: 'bossReveal', tick: 150, entityId: 90, maxHp: 100, x: 0, y: 0 }, 1_001_000)
    expect(kinds(applyEvent(s, { type: 'hit', tick: 160, targetId: 90, amount: 30 }, 1_001_100))).not.toContain('bossHalf')
    expect(kinds(applyEvent(s, { type: 'hit', tick: 170, targetId: 90, amount: 30 }, 1_001_200))).toContain('bossHalf')
    expect(kinds(applyEvent(s, { type: 'hit', tick: 180, targetId: 90, amount: 30 }, 1_001_300))).not.toContain('bossHalf')
  })
})

// ── Build timeline ──────────────────────────────────────────────────────────
describe('build timeline', () => {
  it('records mod pickups in order and tracks peak stacks from samples', () => {
    const s = primed()
    applyEvent(s, { type: 'modPickup', tick: 120, entityId: 1, byId: 7, modId: 'homing', weapon: 'pistol', maxed: false }, 1_001_000)
    applyEvent(s, { type: 'modPickup', tick: 180, entityId: 2, byId: 7, modId: 'frost', weapon: 'pistol', maxed: false }, 1_002_000)
    applySample(s, mkSample({ tick: 200, wallMs: 1_003_000, players: [mkPlayer({ mods: [{ id: 'homing', stacks: 2 }, { id: 'frost', stacks: 1 }] })] }))
    expect(s.run?.modPickups.map((m) => m.modId)).toEqual(['homing', 'frost'])
    expect(s.run?.peakModStacks).toBe(3)
  })

  it('weapon changes and cash movement land in the run record', () => {
    const s = primed()
    applySample(s, mkSample({ tick: 200, wallMs: 1_002_000, players: [mkPlayer({ weapon: 'shotgun', cash: 40 })] }))
    expect(s.run?.weaponChanges).toEqual([{ tick: 200, playerId: 0, from: 'pistol', to: 'shotgun' }])
    expect(s.run?.cashLog.at(-1)).toEqual({ tick: 200, cash: 40 })
  })

  it('coverage counts distinct 8x8 quadrants per floor', () => {
    const s = createSession()
    applySample(s, mkSample({ tick: 100, players: [mkPlayer({ pos: { x: 2, y: 2 } })] }))
    applySample(s, mkSample({ tick: 130, wallMs: 1_001_000, players: [mkPlayer({ pos: { x: 3, y: 3 } })] })) // same quadrant
    applySample(s, mkSample({ tick: 160, wallMs: 1_002_000, players: [mkPlayer({ pos: { x: 20, y: 2 } })] }))
    applySample(s, mkSample({ tick: 190, wallMs: 1_003_000, floor: 2, players: [mkPlayer({ pos: { x: 2, y: 2 } })] }))
    expect(s.run?.coverage.size).toBe(3)
  })
})

// ── Extraction ──────────────────────────────────────────────────────────────
describe('extractSample', () => {
  const stateJson = { tick: 500, seed: 42, floor: 2, alarm: 1, gameOver: false, mission: { template: 'steal', description: 'x', complete: false, exitUnlocked: false } }
  const playerEnt = {
    id: 7, kind: 'player', archetype: 'player', pos: { x: 10.123, y: 11.987 }, vel: { x: 0.5, y: 0 }, intent: { x: 1, y: 0 },
    health: { hp: 22, max: 30 }, combat: { weapon: 'pistol', cooldown: 0 },
    playerCtl: { playerId: 0, abilityCooldown: 0, cash: 55, crimeUntilTick: 0 },
    loadout: { inventory: [{ itemId: 'pistol', qty: 60, mods: [{ id: 'homing', stacks: 2 }] }], activeSlot: 0 },
    fx: { burning: { until: 600 } },
  }
  const nearNpc = { id: 41, kind: 'npc', archetype: 'brute', pos: { x: 14, y: 11 }, health: { hp: 18, max: 26 }, ai: { mode: 'aggro', goal: 'battle', faction: 'gang' } }
  const farNpc = { id: 60, kind: 'npc', archetype: 'skitter', pos: { x: 60, y: 60 }, ai: { mode: 'idle', faction: 'civ' } }
  const farBoss = { id: 90, kind: 'npc', archetype: 'boss', pos: { x: 60, y: 60 }, health: { hp: 200, max: 200 }, ai: { mode: 'sleep', faction: 'gang' } }

  it('extracts compact players (mods, fx status, cash) and 12-tile threats + far boss', () => {
    const { sample, index } = extractSample(stateJson, [playerEnt, nearNpc, farNpc, farBoss], 5_000, false)
    expect(sample.tick).toBe(500)
    const p = sample.players[0]
    expect(p.hp).toBe(22)
    expect(p.cash).toBe(55)
    expect(p.mods).toEqual([{ id: 'homing', stacks: 2 }])
    expect(p.status).toContain('burning')
    expect(sample.threats.map((t) => t.id)).toEqual([41, 90]) // near brute + far boss; far skitter excluded
    expect(sample.threats[0]).toMatchObject({ archetype: 'brute', mode: 'aggro', goal: 'battle', faction: 'gang', hp: 18 })
    expect(index).toContainEqual({ id: 60, kind: 'npc', archetype: 'skitter' })
  })

  it('survives garbage replies without throwing', () => {
    for (const [st, ents] of [[null, null], ['x', 'y'], [{}, {}], [{ tick: 'NaN' }, [null, 7, 'str', {}]]] as const)
      expect(() => extractSample(st, ents, 0, false)).not.toThrow()
  })
})

// ── Target picking / tick estimation ────────────────────────────────────────
describe('pickTarget & estimateTick', () => {
  const game = (over: Partial<GameInfo>): GameInfo => ({
    id: 'g1', name: 'g1', live: true, ticking: true, tick: 100, gameOver: false, lastSeenMs: 10, ageMs: 1000, ...over,
  })

  it('prefers the live ticking real-time game over the harness and frozen games', () => {
    const harness = game({ id: 'g1', ticking: null, tick: null })
    const frozen = game({ id: 'g2', ticking: false })
    const liveGame = game({ id: 'g3', ticking: true })
    expect(pickTarget([harness, frozen, liveGame])?.id).toBe('g3')
  })

  it('falls back to a frozen real-time game (tabbed out) over nothing', () => {
    const harness = game({ id: 'g1', ticking: null, tick: null })
    const frozen = game({ id: 'g2', ticking: false })
    expect(pickTarget([harness, frozen])?.id).toBe('g2')
    expect(pickTarget([harness])).toBeNull()
    expect(pickTarget([])).toBeNull()
  })

  it('estimateTick extrapolates at 30tps but HOLDS while frozen', () => {
    const s = primed({ tick: 100, wallMs: 1_000_000 })
    expect(estimateTick(s, 1_001_000)).toBe(130)
    const f = primed({ tick: 100, wallMs: 1_000_000, frozen: true })
    expect(estimateTick(f, 1_001_000)).toBe(100)
  })
})

// ── Rendering ───────────────────────────────────────────────────────────────
describe('rendering', () => {
  it('sparkline maps 0..max onto the block ramp', () => {
    expect(sparkline([0, 15, 30], 30)).toBe('▁▅█')
    expect(sparkline([NaN], 30)).toBe('·')
    expect(sparkline([5, 5], 0)).toBe('··') // degenerate max never divides by zero
  })

  it('digest carries every section and the live facts', () => {
    const s = primed()
    updateIndex(s, [{ id: 41, kind: 'npc', archetype: 'brute' }])
    applyEvent(s, { type: 'death', tick: 150, entityId: 41 }, 1_001_000)
    applySample(s, mkSample({ tick: 200, wallMs: 1_002_000, players: [mkPlayer({ hp: 12 })] }))
    const d = renderDigest(s, 1_002_500)
    for (const section of ['## NOW', '## LAST 60s', '## THIS RUN', '## SESSION']) expect(d).toContain(section)
    expect(d).toContain('seed 111')
    expect(d).toContain('kill brute#41')
    expect(d).toContain('WAKE lowHp P0 hp 12/30')
    expect(d).toContain('kills 1: brute×1')
  })

  it('digest renders with no sample and with a noGame note', () => {
    const s = createSession()
    s.noGame = 'no real-time game connected'
    const d = renderDigest(s, 1_000)
    expect(d).toContain('no real-time game connected')
  })

  it('completed runs appear as one SESSION line each', () => {
    const s = primed()
    applySample(s, mkSample({ seed: 222, tick: 10, wallMs: 1_010_000 }))
    const d = renderDigest(s, 1_011_000)
    expect(d).toContain('seed 111')
    expect(d).toContain('(current)')
  })

  it('wake lines are iso-ish + tick-stamped', () => {
    expect(formatWakeLine({ kind: 'lowHp', tick: 123, detail: 'P0 hp 20/30' }, 0)).toBe('1970-01-01T00:00:00Z t123 EVENT lowHp P0 hp 20/30')
  })
})

// ── Outbox ──────────────────────────────────────────────────────────────────
describe('outboxAnnotations', () => {
  it('stacks non-empty lines at x16, y 110+78i with ttl tick+1800', () => {
    const anns = outboxAnnotations('hello\n\n  world  \n', 1000)
    expect(anns).toEqual([
      { id: 'observer-msg-0', kind: 'text', text: 'hello', x: 16, y: 110, ttlTick: 2800 },
      { id: 'observer-msg-1', kind: 'text', text: 'world', x: 16, y: 188, ttlTick: 2800 },
    ])
  })

  it('quotes and backslashes survive a JSON round-trip losslessly', () => {
    const anns = outboxAnnotations('say "hi" \\ done', 0)
    const parsed = JSON.parse(JSON.stringify(anns)) as typeof anns
    expect(parsed[0].text).toBe('say "hi" \\ done')
  })

  it('caps at 8 lines and 200 chars, and yields nothing for whitespace', () => {
    expect(outboxAnnotations('a\n'.repeat(20), 0)).toHaveLength(8)
    expect(outboxAnnotations('x'.repeat(500), 0)[0].text).toHaveLength(200)
    expect(outboxAnnotations('  \n \n', 0)).toEqual([])
  })
})
