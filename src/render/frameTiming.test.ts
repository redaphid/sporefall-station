// Per-frame clip timing (manifest `animTiming`) and the weapon-variant seam
// (weaponVariant.ts). Timing lets a one-shot hold its anticipation, snap
// through in one tick a frame and hold the braced end: the quickdraw. The
// variant chain (exact weapon → class → generic) is where per-weapon draws,
// aims and braces slot in later; today a pack with no weapon-specific entry
// must behave exactly as before.

import { describe, expect, it } from 'vitest'
import { arm, walledRoom, worldFromRows } from '../game/testkit'
import { animFrame, clipLength, DEFAULT_TPF, MAX_ANIM_FRAMES } from './animState'
import { fakeArt, shown, tank, trace, type Scene } from './animTestkit'
import { resolveAnimTimings, validateManifest, type LoadedTheme, type ThemeChain } from './theme'
import { frameKeyChain, pickVariant, weaponClassOf, weaponVariants } from './weaponVariant'

/** A quickdraw: anticipation held, a one-tick snap, a one-frame overshoot, a long braced hold. */
const QUICK = [3, 2, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6]

describe('animFrame with per-frame durations', () => {
  it('frame k lasts durations[k] ticks, then the last frame holds', () => {
    const seen = Array.from({ length: 20 }, (_, t) => animFrame('draw', 5, 100 + t, 100, 2, 7, [2, 1, 1, 3, 1]))
    expect(seen).toEqual([0, 0, 1, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4])
  })

  it('a frame past the list lasts the cadence; a short list is not an error', () => {
    expect(Array.from({ length: 8 }, (_, t) => animFrame('draw', 4, t, 0, 2, 1, [1]))).toEqual([0, 1, 1, 2, 2, 3, 3, 3])
    expect(clipLength(4, 2, [1])).toBe(7)
  })

  it('without durations it is exactly the old frames x tpf indexing', () => {
    for (const tpf of [1, 2, 3, 5])
      for (let t = -3; t < 40; t++)
        expect(animFrame('draw', 8, 50 + t, 50, tpf, 3, undefined)).toBe(Math.min(7, Math.floor(Math.max(0, t) / tpf)))
    expect(clipLength(8, 2)).toBe(16)
  })

  it('before its start a timed clip shows frame 0, never a negative index', () => {
    expect(animFrame('draw', 5, 90, 100, 2, 1, [2, 1, 1, 3, 1])).toBe(0)
  })

  it('loops ignore durations', () => {
    for (let t = 0; t < 60; t++) expect(animFrame('walk', 8, t, 0, 6, 4, [1, 1, 1, 1, 1, 1, 1, 1])).toBe(animFrame('walk', 8, t, 0, 6, 4))
  })

  it('degenerate durations (0, negative, fractional) count as at least one tick', () => {
    expect(clipLength(3, 2, [0, -4, 1.7])).toBe(3)
    expect([0, 1, 2, 3].map((t) => animFrame('draw', 3, t, 0, 2, 1, [0, -4, 1.7]))).toEqual([0, 1, 2, 2])
  })
})

describe('manifest animTiming', () => {
  it('keeps valid per-frame timings, weapon and class variants included', () => {
    const { manifest, warnings } = validateManifest({
      animTiming: { 'player.draw': QUICK, 'drowner.hurt': [1, 2], 'player.draw@pistol': [1], 'player.draw@sidearm': [2] },
    })
    expect(warnings).toEqual([])
    expect(manifest.animTiming['player.draw']).toEqual(QUICK)
    expect(Object.keys(manifest.animTiming).sort()).toEqual(['drowner.hurt', 'player.draw', 'player.draw@pistol', 'player.draw@sidearm'])
  })

  it('drops bad kinds, loop and sim states, bad variants and bad values, one warning each', () => {
    const { manifest, warnings } = validateManifest({
      animTiming: {
        'dragon.draw': [1], // not a character
        'player.aim': [1], // a loop: timing is for one-shots
        'player.roll': [1], // the sim's window
        'player.dance': [1], // not a state
        'player.draw@banjo': [1], // not a weapon or class
        'player.draw@pistol@x': [1],
        'player.draw.extra': [1],
        'player.fidget': [0],
        'player.hurt': [31],
        'player.attack': [1.5],
        'player.death': [],
        'mutant.draw': Array(MAX_ANIM_FRAMES + 1).fill(1),
        'warden.draw': 'fast',
      },
    })
    expect(manifest.animTiming).toEqual({})
    expect(warnings.length).toBe(13)
  })

  it('a reserved weapon-variant frame key is dropped with a warning that says so', () => {
    const { manifest, warnings } = validateManifest({ sprites: { 'char.player.e-draw@pistol-0': 'x.png' } })
    expect(manifest.sprites).toEqual({})
    expect(warnings[0]).toMatch(/reserved/)
  })

  it('the active theme wins per key; keys it does not set come from the base', () => {
    const theme = (id: string, animTiming: Record<string, number[]>): LoadedTheme => ({
      id,
      dir: `themes/${id}/`,
      manifest: validateManifest({ animTiming }).manifest,
    })
    const chain: ThemeChain = [theme('hires', { 'player.draw': [1, 1] }), theme('base', { 'player.draw': [9], 'drowner.draw': [4] })]
    expect(resolveAnimTimings(chain)).toEqual({ 'player.draw': [1, 1], 'drowner.draw': [4] })
  })
})

describe('the weapon-variant seam: exact weapon, then class, then the generic state', () => {
  it('classes: sidearm, long gun, heavy, one- and two-hand melee, natural', () => {
    expect(['pistol', 'shotgun', 'machinegun', 'wrench', 'sledgehammer', 'fangs', 'nope'].map(weaponClassOf)).toEqual([
      'sidearm',
      'longgun',
      'heavy',
      'melee1h',
      'melee2h',
      'natural',
      undefined,
    ])
    expect(weaponVariants('pistol')).toEqual(['@pistol', '@sidearm', ''])
    expect(weaponVariants(undefined)).toEqual([''])
    expect(weaponVariants('nope')).toEqual([''])
  })

  it('a generic entry is used when no weapon-specific one exists', () => {
    const table: Record<string, string> = { 'player.draw': 'generic' }
    expect(pickVariant('player.draw', 'pistol', (k) => table[k])).toBe('generic')
    expect(pickVariant('player.draw', undefined, (k) => table[k])).toBe('generic')
    expect(pickVariant('player.aim', 'pistol', (k) => table[k])).toBeUndefined()
  })

  it('the class beats the generic, the exact weapon beats the class', () => {
    const table: Record<string, string> = { 'player.draw': 'generic', 'player.draw@sidearm': 'sidearm' }
    expect(pickVariant('player.draw', 'stunGun', (k) => table[k])).toBe('sidearm')
    expect(pickVariant('player.draw', 'shotgun', (k) => table[k])).toBe('generic')
    table['player.draw@pistol'] = 'pistol'
    expect(pickVariant('player.draw', 'pistol', (k) => table[k])).toBe('pistol')
  })

  it('reserved frame keys follow the same order and end on the key packs ship today', () => {
    expect(frameKeyChain('player', 'e', 'draw', 3, 'pistol')).toEqual([
      'char.player.e-draw@pistol-3',
      'char.player.e-draw@sidearm-3',
      'char.player.e-draw-3',
    ])
    expect(frameKeyChain('player', 'e', 'draw', 3)).toEqual(['char.player.e-draw-3'])
  })
})

describe('timed draw at the entity layer (real sim, a pistol player first seen standing)', () => {
  const scene = (): Scene => {
    const w = worldFromRows(walledRoom(30, 14), { seed: 9 })
    const p = tank(w, 12.5, 9.5)
    arm(p, 'pistol')
    return { w, focus: [p], before: () => {}, n: 60, inputs: new Map([[0, { aimX: 1, aimY: 0 }]]) }
  }
  const clips = { player: { draw: QUICK.length, aim: 2, aimwalk: 8 } }
  const expected = QUICK.flatMap((d, k) => Array(d).fill(`draw.${k}`))
  const sum = QUICK.reduce((a, b) => a + b, 0)

  it('plays each frame for its own duration, lasts their sum, then hands into aim', () => {
    const frames = Object.values(trace(scene(), fakeArt(clips, {}, { 'player.draw': QUICK })))[0]
    expect(frames.slice(0, sum).map(shown)).toEqual(expected)
    expect(shown(frames[sum])).toMatch(/^aim\./)
  })

  it('a timing for another weapon (or its class) leaves the pistol on the generic timing', () => {
    const frames = Object.values(
      trace(scene(), fakeArt(clips, {}, { 'player.draw': QUICK, 'player.draw@shotgun': [9], 'player.draw@longgun': [8] })),
    )[0]
    expect(frames.slice(0, sum).map(shown)).toEqual(expected)
  })

  it('a pistol-specific timing wins over the generic one', () => {
    const fast = Array(QUICK.length).fill(1)
    const frames = Object.values(trace(scene(), fakeArt(clips, {}, { 'player.draw': QUICK, 'player.draw@pistol': fast })))[0]
    expect(frames.slice(0, QUICK.length).map(shown)).toEqual(QUICK.map((_, k) => `draw.${k}`))
    expect(shown(frames[QUICK.length])).toMatch(/^aim\./)
  })

  it('without a timing the clip plays at the draw cadence, as before', () => {
    const frames = Object.values(trace(scene(), fakeArt(clips)))[0]
    const n = QUICK.length * DEFAULT_TPF.draw
    expect(frames.slice(0, n).map(shown)).toEqual(Array.from({ length: n }, (_, t) => `draw.${Math.floor(t / DEFAULT_TPF.draw)}`))
  })
})
