// Every item a player can carry or see on the floor has a player-facing name.
// A raw id ("keycard.wing14") on the HUD is the failure this guards.

import { describe, expect, it } from 'vitest'
import { LOOT_ITEM_IDS } from '../populate'
import { CONSUMABLES, THROWABLES, WEAPONS, itemClass, itemName, keycardId, type ItemClass } from './items'

/** Every id of every class. Keyed by ItemClass, so a new class fails the
 * typecheck here until it has ids to name. */
const IDS_BY_CLASS: Record<Exclude<ItemClass, 'unknown'>, readonly string[]> = {
  melee: Object.keys(WEAPONS).filter((id) => WEAPONS[id].kind === 'melee'),
  ranged: Object.keys(WEAPONS).filter((id) => WEAPONS[id].kind === 'ranged'),
  throwable: Object.keys(THROWABLES),
  consumable: Object.keys(CONSUMABLES),
  cash: ['cash'],
  key: ['briefcase', 'keycard', keycardId('wing14', 'essence lab'), keycardId('wing3', 'med-bay'), 'keycard.wing0', 'keycard.wing14', 'keycard.north'],
}

const ALL = Object.entries(IDS_BY_CLASS).flatMap(([c, ids]) => ids.map((id) => [c, id] as const))

describe('itemName', () => {
  it.each(ALL)('%s %s has a readable name, not its id', (c, id) => {
    expect(itemClass(id), 'sample is filed under its real class').toBe(c)
    const name = itemName(id)
    expect(name).not.toBe(id)
    expect(name).not.toMatch(/[._]/)
    expect(name.charAt(0)).toBe(name.charAt(0).toUpperCase())
  })

  it.each(LOOT_ITEM_IDS)('floor loot %s is named', (id) => {
    expect(itemName(id)).not.toBe(id)
  })

  it.each([
    [keycardId('wing14', 'essence lab'), 'Essence lab keycard'],
    [keycardId('wing2', 'reactor core'), 'Reactor core keycard'],
    [keycardId('wing2', 'med-bay'), 'Med-bay keycard'],
    [keycardId('wing2', 'essence lab 2'), 'Essence lab 2 keycard'],
    [keycardId('wing2', ''), 'Wing 2 keycard'],
    ['keycard.wing2.', 'Wing 2 keycard'],
    ['keycard.wing2._', 'Wing 2 keycard'],
    ['keycard', 'Keycard'],
    ['keycard.', 'Keycard'],
    ['keycard.wing0', 'Wing 0 keycard'],
    ['keycard.wing14', 'Wing 14 keycard'],
    ['keycard.north', 'North keycard'],
    ['keycard.east-annex', 'East Annex keycard'],
    ['keycard.wing', 'Wing keycard'],
  ])('keycard %s reads as "%s"', (id, name) => {
    expect(itemName(id)).toBe(name)
  })

  it('names weapons and throwables from their tables', () => {
    expect(itemName('shotgun')).toBe(WEAPONS.shotgun.name)
    expect(itemName('grenade')).toBe(THROWABLES.grenade.name)
    expect(itemName('briefcase')).toBe('Specimen Canister')
  })

  it.each([
    ['medkit', 'Medkit'],
    ['grenade-item', 'Grenade Item'],
    ['keycards', 'Keycards'],
    ['keycardwing14', 'Keycardwing14'],
    ['', ''],
  ])('title-cases the retired or unknown id %o as "%s"', (id, name) => {
    expect(itemClass(id)).toBe('unknown')
    expect(itemName(id)).toBe(name)
  })
})

describe('keycardId', () => {
  it('writes the building name into the id with no spaces, and itemName reads it back', () => {
    const id = keycardId('wing14', 'essence lab')
    expect(id).toBe('keycard.wing14.essence_lab')
    expect(id).not.toMatch(/\s/)
    expect(itemClass(id)).toBe('key')
  })

  it('keeps cards for two wings apart even when their buildings share a name', () => {
    expect(keycardId('wing3', 'essence lab')).not.toBe(keycardId('wing4', 'essence lab'))
  })
})
