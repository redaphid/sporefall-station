import { describe, expect, it } from 'vitest'
import { hasHeldWeapon, isMeleeWeapon } from './weaponArt'

describe('hasHeldWeapon', () => {
  it('bare fists hold nothing', () => {
    expect(hasHeldWeapon('fists')).toBe(false)
  })

  it('no natural armament draws a held sprite — claws, fangs, mandibles, horns', () => {
    for (const id of ['claws', 'fangs', 'mandibles', 'horns']) expect(hasHeldWeapon(id), id).toBe(false)
  })

  it('every carried weapon (and an unknown id) may hold art; the pack decides whether any is drawn', () => {
    expect(hasHeldWeapon('sledgehammer')).toBe(true)
    expect(hasHeldWeapon('pistol')).toBe(true)
    expect(hasHeldWeapon('spork-of-doom')).toBe(true)
  })
})

describe('isMeleeWeapon', () => {
  it('classifies registered weapons by kind', () => {
    expect(isMeleeWeapon('sledgehammer')).toBe(true)
    expect(isMeleeWeapon('wrench')).toBe(true)
    expect(isMeleeWeapon('pistol')).toBe(false)
    expect(isMeleeWeapon('shotgun')).toBe(false)
  })

  it('treats an unknown id as melee', () => {
    expect(isMeleeWeapon('spork-of-doom')).toBe(true)
  })
})
