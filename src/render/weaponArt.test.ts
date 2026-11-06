import { describe, expect, it } from 'vitest'
import { CANVAS_REACH, HELD_LENGTH, hasHeldWeapon, heldScale, isMeleeWeapon, WEAPON_ANCHOR, WEAPON_CANVAS, weaponShape } from './weaponArt'
import { CHAR_PX } from './art'
import { WEAPONS } from '../game/data/items'

describe('weaponShape — each weapon maps to its intended silhouette', () => {
  it('names the distinctive melee silhouettes', () => {
    expect(weaponShape('cageRam')).toBe('hammer')
    expect(weaponShape('pressureLance')).toBe('club')
    expect(weaponShape('siphonSpike')).toBe('blade')
  })

  it('maps the pistol to the gun silhouette', () => {
    expect(weaponShape('decanter')).toBe('gun')
  })

  it('draws every registered ranged weapon as a gun', () => {
    for (const [id, def] of Object.entries(WEAPONS)) {
      if (def.kind === 'ranged') expect(weaponShape(id)).toBe('gun')
    }
  })

  it('falls back to a generic rod for an unknown id — NEVER invisible', () => {
    expect(weaponShape('spork-of-doom')).toBe('rod')
    expect(weaponShape('')).toBe('rod')
  })

  it('resolves a shape for every registered weapon (total, no gaps)', () => {
    for (const id of Object.keys(WEAPONS)) {
      expect(['hammer', 'club', 'blade', 'gun', 'rod']).toContain(weaponShape(id))
    }
  })
})

describe('hasHeldWeapon', () => {
  it('bare fists hold nothing', () => {
    expect(hasHeldWeapon('fists')).toBe(false)
  })

  it('no natural armament draws a held sprite — claws, fangs, mandibles, horns', () => {
    for (const id of ['claws', 'fangs', 'mandibles', 'horns']) expect(hasHeldWeapon(id), id).toBe(false)
  })

  it('every real weapon — and even an unknown id — shows a held sprite', () => {
    expect(hasHeldWeapon('cageRam')).toBe(true)
    expect(hasHeldWeapon('decanter')).toBe(true)
    expect(hasHeldWeapon('spork-of-doom')).toBe(true)
  })
})

describe('isMeleeWeapon', () => {
  it('classifies registered weapons by kind', () => {
    expect(isMeleeWeapon('cageRam')).toBe(true)
    expect(isMeleeWeapon('pressureLance')).toBe(true)
    expect(isMeleeWeapon('decanter')).toBe(false)
    expect(isMeleeWeapon('scatterFunnel')).toBe(false)
  })

  it('treats an unknown id as melee so the fallback rod swings', () => {
    expect(isMeleeWeapon('spork-of-doom')).toBe(true)
  })
})

describe('WEAPON_ANCHOR', () => {
  it('anchors at the grip (left) vertically centred', () => {
    expect(WEAPON_ANCHOR.x).toBeGreaterThan(0)
    expect(WEAPON_ANCHOR.x).toBeLessThan(0.5)
    expect(WEAPON_ANCHOR.y).toBe(0.5)
  })
})

describe('held size — the canvas is drawing room, HELD_LENGTH is the hand', () => {
  it('maps the authored grip-to-tip run onto each shape\'s held length', () => {
    expect(CANVAS_REACH).toBe(WEAPON_CANVAS.w - WEAPON_CANVAS.grip)
    for (const id of ['decanter', 'siphonSpike', 'pressureLance', 'cageRam', 'spork-of-doom']) {
      expect(heldScale(id) * CANVAS_REACH, id).toBeCloseTo(HELD_LENGTH[weaponShape(id)], 9)
    }
  })

  it('shrinks every shape (the canvas was never hand-sized) and keeps each under half a character', () => {
    for (const [shape, len] of Object.entries(HELD_LENGTH)) {
      expect(len, shape).toBeLessThan(CANVAS_REACH)
      expect(len, shape).toBeLessThan(CHAR_PX / 2)
      expect(len, shape).toBeGreaterThan(0)
    }
  })

  it('orders the silhouettes by what they are: knife < pistol < wrench < sledgehammer', () => {
    expect(HELD_LENGTH.blade).toBeLessThan(HELD_LENGTH.gun)
    expect(HELD_LENGTH.gun).toBeLessThan(HELD_LENGTH.club)
    expect(HELD_LENGTH.club).toBeLessThan(HELD_LENGTH.hammer)
  })
})
