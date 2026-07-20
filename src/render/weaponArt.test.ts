import { describe, expect, it } from 'vitest'
import { hasHeldWeapon, isMeleeWeapon, WEAPON_ANCHOR, weaponShape } from './weaponArt'
import { WEAPONS } from '../game/data/items'

describe('weaponShape — each weapon maps to its intended silhouette', () => {
  it('names the distinctive melee silhouettes', () => {
    expect(weaponShape('sledgehammer')).toBe('hammer')
    expect(weaponShape('bat')).toBe('club')
    expect(weaponShape('knife')).toBe('blade')
  })

  it('maps the pistol to the gun silhouette', () => {
    expect(weaponShape('pistol')).toBe('gun')
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

  it('every real weapon — and even an unknown id — shows a held sprite', () => {
    expect(hasHeldWeapon('sledgehammer')).toBe(true)
    expect(hasHeldWeapon('pistol')).toBe(true)
    expect(hasHeldWeapon('spork-of-doom')).toBe(true)
  })
})

describe('isMeleeWeapon', () => {
  it('classifies registered weapons by kind', () => {
    expect(isMeleeWeapon('sledgehammer')).toBe(true)
    expect(isMeleeWeapon('bat')).toBe(true)
    expect(isMeleeWeapon('pistol')).toBe(false)
    expect(isMeleeWeapon('shotgun')).toBe(false)
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
