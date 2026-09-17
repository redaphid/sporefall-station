// The boss REGISTRY — the shared surface every future boss lands through.
//
// These are mostly INVARIANT tests rather than behaviour tests, because the
// failure modes this registry exists to prevent are all "someone added a row
// and something three layers away quietly broke":
//
//   - a boss registered with no `NPCS` row → `spawnNpc` spawns an archetype
//     with no definition and throws mid-floor-generation;
//   - a phase table that does not cover full health → the HUD renders an empty
//     label over a live boss;
//   - a selection draw taken from the wrong stream → every frozen level
//     checksum and pinned mission placement in the repo moves.

import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../rng'
import { NPCS } from './npcs'
import {
  BOSSES,
  DEFAULT_BOSS,
  MIRECLAW_ENRAGE_FRAC,
  MIRECLAW_RETREAT_FRAC,
  bossDef,
  bossPhaseAt,
  eligibleBosses,
  isBoss,
  pickBoss,
} from './bosses'

describe('registry integrity — the mistakes that break a floor, not a pixel', () => {
  it('every registered boss has a real NPCS row to spawn from', () => {
    // `missions.ts` calls `spawnNpc(w, def.archetype, …)`, which does
    // `NPCS[archetype].speed` — an unregistered archetype is a crash during
    // floor generation, not a visual glitch.
    for (const [key, def] of Object.entries(BOSSES)) {
      expect(NPCS[def.archetype], `BOSSES.${key} → NPCS.${def.archetype}`).toBeDefined()
    }
  })

  it('the registry key IS the archetype, so lookups by archetype always hit', () => {
    for (const [key, def] of Object.entries(BOSSES)) expect(key).toBe(def.archetype)
  })

  it('every boss has a non-empty name that is not just its archetype id', () => {
    for (const def of Object.values(BOSSES)) {
      expect(def.name.length).toBeGreaterThan(0)
      expect(def.name.toLowerCase()).not.toBe(def.archetype.toLowerCase())
    }
  })

  it('every boss has a mission name that reads correctly mid-sentence', () => {
    // The mission line is `Purge ${missionName} in the cargo hold`. A display
    // name substituted there produces "Purge the The Vigil", which is why the
    // prose form is its own field — so this pins that it IS the prose form.
    for (const [key, def] of Object.entries(BOSSES)) {
      expect(def.missionName.length, key).toBeGreaterThan(0)
      expect(def.missionName.trim(), key).toBe(def.missionName)
      expect(`Purge ${def.missionName} in the cargo hold`, key).not.toMatch(/\bthe the\b/i)
    }
  })

  it('keeps the Mireclaw mission line byte-identical to the one that shipped', () => {
    // Generalising the mission text must not silently reword the existing boss.
    expect(`Purge ${BOSSES.boss.missionName} in the reactor core`).toBe(
      'Purge the Mireclaw Alpha in the reactor core',
    )
  })

  it('every phase table is TOTAL — a boss at full health always has a label', () => {
    // The last row must cover 1. Without this a full-hp boss falls off the end
    // of the ladder and the HUD draws a blank phase line under its name.
    for (const [key, def] of Object.entries(BOSSES)) {
      expect(def.phases.length, `${key} has no phases`).toBeGreaterThan(0)
      expect(def.phases[def.phases.length - 1].atOrBelow, `${key} final band`).toBeGreaterThanOrEqual(1)
    }
  })

  it('every phase table is ordered most-wounded-first, as bossPhaseAt assumes', () => {
    // bossPhaseAt takes the FIRST row the fraction has reached, so an unsorted
    // table silently reports the wrong phase rather than failing loudly.
    for (const [key, def] of Object.entries(BOSSES)) {
      for (let i = 1; i < def.phases.length; i++) {
        expect(def.phases[i].atOrBelow, `${key} phase ${i}`).toBeGreaterThan(def.phases[i - 1].atOrBelow)
      }
    }
  })

  it('every boss resolves a label at every hp fraction from 0 to 1', () => {
    for (const [key, def] of Object.entries(BOSSES)) {
      for (let f = 0; f <= 1.0001; f += 0.01) {
        const { label, phase } = bossPhaseAt(def, Math.min(1, f))
        expect(label, `${key} @ ${f.toFixed(2)}`).not.toBe('')
        expect(phase, `${key} @ ${f.toFixed(2)}`).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('Mireclaw parity — the generalisation must change nothing on screen', () => {
  const mireclaw = BOSSES.boss

  it('is the default boss, so any unknown archetype degrades to the shipped fight', () => {
    expect(DEFAULT_BOSS).toBe(mireclaw)
    expect(bossDef('boss')).toBe(mireclaw)
    expect(bossDef('no.such.boss')).toBe(mireclaw)
  })

  it('reproduces the exact three labels the HUD hardcoded, at the exact thresholds', () => {
    expect(bossPhaseAt(mireclaw, 1)).toEqual({ phase: 1, label: 'SUMMONING BROOD', danger: false })
    expect(bossPhaseAt(mireclaw, MIRECLAW_RETREAT_FRAC + 0.01).phase).toBe(1)
    // Each boundary belongs to the WOUNDED band, exactly as the old ladder read.
    expect(bossPhaseAt(mireclaw, MIRECLAW_RETREAT_FRAC)).toEqual({
      phase: 2,
      label: 'REGENERATING — BURN THE SPORES',
      danger: false,
    })
    expect(bossPhaseAt(mireclaw, MIRECLAW_ENRAGE_FRAC + 0.01).phase).toBe(2)
    expect(bossPhaseAt(mireclaw, MIRECLAW_ENRAGE_FRAC)).toEqual({ phase: 3, label: 'ENRAGED', danger: true })
    expect(bossPhaseAt(mireclaw, 0).phase).toBe(3)
  })

  it('keeps the thresholds the SIM runs on identical to the ones the HUD shows', () => {
    // systems/mireclaw.ts and systems/behaviors.ts both branch on these two
    // numbers. They live here now; a drift between sim and HUD is the bug this
    // co-location exists to make impossible.
    expect(MIRECLAW_RETREAT_FRAC).toBe(0.5)
    expect(MIRECLAW_ENRAGE_FRAC).toBe(0.2)
  })

  it('isBoss recognises registered archetypes only', () => {
    expect(isBoss('boss')).toBe(true)
    expect(isBoss('vigil')).toBe(true)
    expect(isBoss('echo')).toBe(true)
    expect(isBoss('thug')).toBe(false)
  })
})

describe('per-floor eligibility and selection', () => {
  it('floor 1 fields ONLY the Mireclaw — the tutorial city stays a fixed encounter', () => {
    // Floor 1 is byte-frozen (levelgen/floor1.frozen.test.ts) and is the floor
    // every scripted demo replays on, so it keeps exactly the boss it had.
    expect(eligibleBosses(1).map((b) => b.archetype)).toEqual(['boss'])
  })

  it('deeper floors field the wider pool', () => {
    // Registry ORDER, not sorted — eligibleBosses preserves BOSSES insertion.
    expect(eligibleBosses(2).map((b) => b.archetype)).toEqual(['boss', 'vigil', 'echo', 'sealkeeper'])
    expect(eligibleBosses(9).map((b) => b.archetype)).toEqual(['boss', 'vigil', 'echo', 'sealkeeper'])
  })

  it('draws NOTHING from the stream when only one boss is eligible', () => {
    // The shallow-floor path must not acquire an RNG draw it never had. Even on
    // a dedicated fork this is the first thing a reviewer checks, so it is
    // asserted rather than argued.
    let draws = 0
    const counting = {
      int: (lo: number, hi: number): number => {
        draws++
        return lo + (hi - lo)
      },
    }
    expect(pickBoss(1, counting).archetype).toBe('boss')
    expect(draws).toBe(0)
  })

  it('is deterministic: the same fork seed picks the same boss every time', () => {
    const pick = (): string => pickBoss(5, mulberry32(12345).fork('boss')).archetype
    expect(pick()).toBe(pick())
    expect(pick()).toBe(pick())
  })

  it('actually reaches every eligible boss across seeds (the selection is not a constant)', () => {
    // The playtest complaint this feature answers was "6 runs → the same boss
    // 4 times". A picker that compiles but always returns index 0 would pass
    // every other test in this file.
    const seen = new Set<string>()
    for (let seed = 1; seed <= 200; seed++) seen.add(pickBoss(5, mulberry32(seed).fork('boss')).archetype)
    expect([...seen].sort()).toEqual(['boss', 'echo', 'sealkeeper', 'vigil'])
  })

  it('never returns an unspawnable boss, at any floor', () => {
    for (let floor = 1; floor <= 12; floor++) {
      for (let seed = 1; seed <= 25; seed++) {
        const def = pickBoss(floor, mulberry32(seed).fork('boss'))
        expect(NPCS[def.archetype], `floor ${floor} seed ${seed}`).toBeDefined()
        expect(floor).toBeGreaterThanOrEqual(def.minFloor)
      }
    }
  })
})
