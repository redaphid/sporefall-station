// The `newEnemyArt` switch: the six Sporefall threats draw their bespoke art or
// the generic procedural blobs they shipped as before.
//
// What these tests are really defending:
//
//  1. OFF IS THE HISTORICAL PATH, not a lookalike. The flag ADDS the six to the
//     charset map; it never subtracts. A player who never touches the setting
//     must be provably unaffected, which is the entire point of defaulting off.
//  2. IT NEVER REACHES THE WIRE. Which sprites a client draws is local
//     presentation. Two peers on different settings stay in sync and merely see
//     different pixels — the `ARCHETYPES` bug already proved that rendering and
//     the wire are entangled in this codebase, so this is pinned, not assumed.
//  3. IT SURVIVES A RELOAD, including offline (the game is a PWA and he may be
//     flipping this on a plane).

import { describe, expect, it } from 'vitest'
import { clampFlags, defaultFlags, flagOn, FEATURE_FLAGS } from '../app/featureFlags'
import { clampSettings, defaultSettings } from '../app/settings'

describe('newEnemyArt — the default', () => {
  it('is OFF, so landing the art is visually inert until it is chosen', () => {
    expect(flagOn(defaultSettings().flags, 'newEnemyArt')).toBe(false)
  })

  it('stays off for a player whose stored settings predate the flag', () => {
    // The exact shape someone would have in localStorage from before this
    // existed. It must not silently opt them in.
    const legacy = { hapticsEnabled: true, hapticsIntensity: 0.7, effectsQuality: 'high', theme: 'swampspace-hires' }
    expect(flagOn(clampSettings(legacy).flags, 'newEnemyArt')).toBe(false)
  })

  it('survives a round-trip through storage in both positions', () => {
    for (const v of [true, false]) {
      const stored = JSON.parse(JSON.stringify({ ...defaultSettings(), flags: { newEnemyArt: v } }))
      expect(flagOn(clampSettings(stored).flags, 'newEnemyArt')).toBe(v)
    }
  })

  it('rejects a corrupt value rather than coercing it truthy', () => {
    // 'true' the STRING must not enable it — a truthiness bug here would opt
    // people in silently, which is the one outcome the default exists to avoid.
    for (const junk of ['true', 1, {}, [], null]) {
      expect(flagOn(clampFlags({ newEnemyArt: junk }), 'newEnemyArt')).toBe(false)
    }
  })
})

describe('newEnemyArt — it is presentation, never simulation', () => {
  it('is not referenced anywhere under src/game (the sim) or src/net (the wire)', async () => {
    // A grep-as-test. If someone later branches game logic or serialization on
    // this flag, two peers with different settings desync — and it would show up
    // as a rare, unreproducible multiplayer bug rather than as a failure here.
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full, out)
        else if (full.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const offenders: string[] = []
    for (const root of ['src/game', 'src/net']) {
      let files: string[]
      try {
        files = walk(root)
      } catch {
        continue // directory may not exist in every checkout
      }
      for (const f of files) {
        const src = readFileSync(f, 'utf8')
        // No flag key, and no reading of the flags bag at all.
        if (FEATURE_FLAGS.some((fl) => src.includes(fl.key)) || src.includes('featureFlags')) offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the flag registry itself', () => {
  it('gives every flag a plain-English label and a description of what it changes', () => {
    for (const f of FEATURE_FLAGS) {
      expect(f.label.trim().length, `${f.key} needs a label`).toBeGreaterThan(0)
      expect(f.description.trim().length, `${f.key} needs a description`).toBeGreaterThan(0)
    }
  })

  it('gives every flag a way to DIE', () => {
    // The INFECTION_ENABLED lesson: this repo already carries a dead flag hiding
    // an entire unfinished system. A flag with no exit condition is permanent
    // scaffolding, so the exit condition is mandatory and checked.
    for (const f of FEATURE_FLAGS) {
      expect(f.retire.trim().length, `${f.key} must record when it is removed`).toBeGreaterThan(0)
    }
  })

  it('defaults every flag OFF, so new work ships dark until he opts in', () => {
    for (const f of FEATURE_FLAGS) expect(f.defaultOn, `${f.key} should ship off`).toBe(false)
  })

  it('has no duplicate keys', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('drops unknown/retired keys instead of carrying them forever', () => {
    expect(clampFlags({ someRetiredFlag: true })).toEqual(defaultFlags())
  })
})
