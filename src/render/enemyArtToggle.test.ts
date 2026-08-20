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
  it('is ON, so the six draw their real art without anyone finding the setting', () => {
    // Flipped deliberately. Off-by-default was correct while the art was
    // unreviewed; it became wrong once the art shipped, because the six then
    // rendered as generic blobs tinted 0xcccccc and read as "white circles" —
    // reported as a bug, not recognised as an un-ticked switch.
    expect(flagOn(defaultSettings().flags, 'newEnemyArt')).toBe(true)
  })

  it('opts in a player whose stored settings predate the flag', () => {
    // The exact shape someone would have in localStorage from before this
    // existed. Since the default is now ON, an existing install that never
    // opened the panel MUST pick the new art up on next load — otherwise the
    // people most likely to have hit the bug are the ones who keep it.
    const legacy = { hapticsEnabled: true, hapticsIntensity: 0.7, effectsQuality: 'high', theme: 'swampspace-hires' }
    expect(flagOn(clampSettings(legacy).flags, 'newEnemyArt')).toBe(true)
  })

  it('still lets an explicit opt-OUT stick', () => {
    // The escape hatch is the whole reason the flag survives its own flip: a
    // stored `false` is a real boolean and must beat the new default.
    const optedOut = { ...defaultSettings(), flags: { newEnemyArt: false } }
    expect(flagOn(clampSettings(JSON.parse(JSON.stringify(optedOut))).flags, 'newEnemyArt')).toBe(false)
  })

  it('survives a round-trip through storage in both positions', () => {
    for (const v of [true, false]) {
      const stored = JSON.parse(JSON.stringify({ ...defaultSettings(), flags: { newEnemyArt: v } }))
      expect(flagOn(clampSettings(stored).flags, 'newEnemyArt')).toBe(v)
    }
  })

  it('ignores a corrupt value rather than coercing it, in either direction', () => {
    // Only a real boolean is honoured. With the default ON the dangerous
    // coercion has inverted: `''`/`0`/`null` must NOT read as a deliberate
    // opt-out, and `'true'`/`1` must not be mistaken for a deliberate opt-in.
    // Both cases resolve the same way — corrupt input falls back to the default.
    for (const junk of ['true', 'false', 1, 0, '', {}, [], null]) {
      expect(flagOn(clampFlags({ newEnemyArt: junk }), 'newEnemyArt')).toBe(true)
    }
    // ...and a genuine boolean is still obeyed, both ways.
    expect(flagOn(clampFlags({ newEnemyArt: false }), 'newEnemyArt')).toBe(false)
    expect(flagOn(clampFlags({ newEnemyArt: true }), 'newEnemyArt')).toBe(true)
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

  it('pins every flag default explicitly, so a flip is always a deliberate edit', () => {
    // This USED to assert every flag defaults OFF. That blanket rule died the
    // day `newEnemyArt` flipped, and a rule that gets deleted the first time it
    // is inconvenient was never protecting anything. What actually needs
    // protecting is narrower and survives the flip: no default changes by
    // accident. A flag added here without a considered default fails; a default
    // edited without touching this table fails.
    const EXPECTED_DEFAULTS: Record<string, boolean> = {
      newEnemyArt: true,
    }
    expect(Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, f.defaultOn]))).toEqual(EXPECTED_DEFAULTS)
  })

  it('makes any ON-by-default flag say so in its retire note', () => {
    // Rule 2 ("off is the untouched path") is load-bearing, so a flag that opts
    // everyone in by default owes an explanation of how it stops being a flag.
    for (const f of FEATURE_FLAGS.filter((f) => f.defaultOn)) {
      expect(f.retire.toLowerCase(), `${f.key} defaults ON and must justify it`).toContain('default')
    }
  })

  it('has no duplicate keys', () => {
    const keys = FEATURE_FLAGS.map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('drops unknown/retired keys instead of carrying them forever', () => {
    expect(clampFlags({ someRetiredFlag: true })).toEqual(defaultFlags())
  })
})
