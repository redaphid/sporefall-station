// The pack contract for held-weapon art: the key grammar the loader looks up,
// the `weapons` grip/muzzle section the validator keeps or drops, and the
// measured fist table the renderer pins grips to.
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WEAPONS } from '../game/data/items'
import { MAX_ANIM_FRAMES } from './animState'
import { HAND_ANCHORS } from './handAnchors'
import { HELD_WEAPON_IDS, resolveWeaponPoints, SPRITE_KEYS, validateManifest, WEAPON_VIEWS, type LoadedTheme } from './theme'

describe('weapon sprite keys', () => {
  it('every carried weapon gets weapon.<id>.<view>-<idle|attack>-<n> keys; natural armament none', () => {
    for (const id of Object.keys(WEAPONS)) {
      const has = SPRITE_KEYS.has(`weapon.${id}.e-idle-0`)
      expect(has, id).toBe(WEAPONS[id].natural !== true)
    }
    for (const v of WEAPON_VIEWS)
      for (const s of ['idle', 'attack'])
        for (let n = 0; n < MAX_ANIM_FRAMES; n++) expect(SPRITE_KEYS.has(`weapon.decanter.${v}-${s}-${n}`)).toBe(true)
    expect(SPRITE_KEYS.has(`weapon.decanter.e-idle-${MAX_ANIM_FRAMES}`)).toBe(false)
    expect(SPRITE_KEYS.has('weapon.decanter.sw-idle-0')).toBe(false) // the west half is mirrored, never drawn
    expect(SPRITE_KEYS.has('weapon.fangs.e-idle-0')).toBe(false)
  })

  it('a manifest mapping a weapon frame keeps it', () => {
    const { manifest, warnings } = validateManifest({ sprites: { 'weapon.pressureLance.se-attack-2': 'weapons/wrench-se-attack-2.png' } })
    expect(manifest.sprites['weapon.pressureLance.se-attack-2']).toEqual(['weapons/wrench-se-attack-2.png'])
    expect(warnings).toEqual([])
  })
})

describe('the weapons grip/muzzle section', () => {
  it('keeps whole-pixel grip and muzzle per id and view; muzzle defaults to the grip', () => {
    const { manifest, warnings } = validateManifest({
      weapons: { decanter: { e: { grip: [3, 6], muzzle: [14, 2] }, s: { grip: [4, 7] } } },
    })
    expect(warnings).toEqual([])
    expect(manifest.weapons.decanter.e).toEqual({ grip: [3, 6], muzzle: [14, 2] })
    expect(manifest.weapons.decanter.s).toEqual({ grip: [4, 7], muzzle: [4, 7] })
  })

  it.each([
    ['unknown weapon', { 'spork-of-doom': { e: { grip: [1, 1] } } }],
    ['natural weapon', { fangs: { e: { grip: [1, 1] } } }],
    ['prototype key', JSON.parse('{"__proto__": {"e": {"grip": [1, 1]}}}')],
    ['unknown view', { decanter: { sw: { grip: [1, 1] } } }],
    ['fractional grip', { decanter: { e: { grip: [1.5, 1] } } }],
    ['negative grip', { decanter: { e: { grip: [-1, 1] } } }],
    ['missing grip', { decanter: { e: { muzzle: [1, 1] } } }],
    ['bad muzzle', { decanter: { e: { grip: [1, 1], muzzle: 'tip' } } }],
    ['not an object', [1, 2]],
  ])('drops a %s with a warning, never throws', (_name, weapons) => {
    const { manifest, warnings } = validateManifest({ weapons })
    expect(warnings.length).toBeGreaterThan(0)
    expect(manifest.weapons.decanter?.e).toBeUndefined()
    expect(Object.keys(manifest.weapons.decanter ?? {})).toEqual([])
  })

  it('the first theme in the chain that pins a view wins', () => {
    const theme = (id: string, weapons: unknown): LoadedTheme => ({ id, dir: `themes/${id}/`, manifest: validateManifest({ weapons }).manifest })
    const chain = [theme('a', { decanter: { e: { grip: [1, 2] } } }), theme('b', { decanter: { e: { grip: [9, 9] }, s: { grip: [5, 5] } } })]
    expect(resolveWeaponPoints('decanter', 'e', chain)?.grip).toEqual([1, 2])
    expect(resolveWeaponPoints('decanter', 's', chain)?.grip).toEqual([5, 5])
    expect(resolveWeaponPoints('decanter', 'n', chain)).toBeUndefined()
  })

  it('every carried weapon id is a held-art id', () => {
    expect([...HELD_WEAPON_IDS].sort()).toEqual(Object.keys(WEAPONS).filter((id) => !WEAPONS[id].natural).sort())
  })
})

describe('HAND_ANCHORS: the measured fist table', () => {
  const entries = Object.entries(HAND_ANCHORS)
  it('measures the armed bodies in both packs', () => {
    for (const kind of ['vine-ranger', 'drowned-diver', 'bellwether', 'blast-diver', 'frog-settler'])
      for (const pack of ['swampspace-hires', 'swampspace'])
        for (const d of ['s', 'se', 'e', 'ne', 'n']) expect(HAND_ANCHORS[`${pack}/chars/${kind}-${d}-idle.png`], `${pack} ${kind} ${d}`).toBeDefined()
  })

  it.each(entries.slice(0, 400))('%s: a real frame, box inside it, grip inside the box', (path, [x0, y0, x1, y1, gx, gy]) => {
    expect(existsSync(join(__dirname, '../../public/themes', path))).toBe(true)
    const size = path.startsWith('swampspace-hires/') ? 96 : 48
    for (const v of [x0, y0, x1, y1, gx, gy]) expect(Number.isInteger(v)).toBe(true)
    expect(x0).toBeGreaterThanOrEqual(0)
    expect(y0).toBeGreaterThanOrEqual(0)
    expect(x1).toBeLessThanOrEqual(size)
    expect(y1).toBeLessThanOrEqual(size)
    expect(x1).toBeGreaterThan(x0)
    expect(y1).toBeGreaterThan(y0)
    expect(gx).toBeGreaterThanOrEqual(x0)
    expect(gx).toBeLessThan(x1)
    expect(gy).toBeGreaterThanOrEqual(y0)
    expect(gy).toBeLessThan(y1)
  })

  it('the base pack fist is the hi-res one halved (same drawing at half size)', () => {
    for (const [path, a] of entries) {
      if (!path.startsWith('swampspace-hires/')) continue
      const b = HAND_ANCHORS[path.replace('swampspace-hires/', 'swampspace/')]
      if (!b) continue
      expect(Math.abs(b[4] - a[4] / 2), path).toBeLessThanOrEqual(1)
      expect(Math.abs(b[5] - a[5] / 2), path).toBeLessThanOrEqual(1)
    }
  })
})
