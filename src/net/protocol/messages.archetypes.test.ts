import { describe, expect, it } from 'vitest'
import { CONSUMABLES, THROWABLES, WEAPONS } from '../../game/data/items'
import { MODS } from '../../game/data/mods'
import { NPCS } from '../../game/data/npcs'
import { OBJECTS } from '../../game/data/objects'
import { PROTOCOL_VERSION } from '../types'
import { ARCHETYPES, kindOf, KEYCARD_ARCHETYPE, normalizeArchetype, WIRE_MODS } from './messages'

/**
 * The wire archetype registry must COVER the game registries.
 *
 * `encodeSnapshot` writes `archetypeIndex.get(e.archetype) ?? 0`, and index 0 is
 * 'player' — so anything spawnable but unregistered silently arrives on the
 * remote phone as a second Ranger. That shipped twice: once for enemies (fixed
 * in 23e7e43) and once for everything else (world objects, weapon mods, item
 * pickups, thrown items, the wing keycard, the generator).
 *
 * The existing archetype test could not catch either, because it iterates
 * ARCHETYPES to validate ARCHETYPES — a tautology. This diffs the wire list
 * against the SOURCES OF TRUTH instead, which is the pattern
 * messages.mods.test.ts already uses for WIRE_MODS.
 *
 * When you add an item / mod / object / NPC, APPEND its archetype to
 * ARCHETYPES. Never reorder: the index is the wire format, and two phones on
 * different bundles must agree on it.
 */

const registered = new Set<string>(ARCHETYPES)
const ITEMS = { ...WEAPONS, ...THROWABLES, ...CONSUMABLES }

const expectRegistered = (archetype: string, why: string): void => {
  expect(registered.has(archetype), `'${archetype}' is spawnable (${why}) but missing from ARCHETYPES — it will decode as 'player' on the other phone`).toBe(true)
}

describe('ARCHETYPES covers everything the game can spawn', () => {
  it('registers a pickup archetype for every item', () => {
    for (const id of Object.keys(ITEMS)) expectRegistered(`pickup.${id}`, 'populate.ts spawnItem / combat.ts weapon drop')
  })

  it('registers a pickup archetype for every weapon mod', () => {
    for (const id of Object.keys(MODS)) expectRegistered(`mod.${id}`, 'populate.ts:646')
  })

  it('registers every world object', () => {
    for (const id of Object.keys(OBJECTS)) expectRegistered(id, 'systems/objects.ts:26')
  })

  it('registers every NPC', () => {
    for (const id of Object.keys(NPCS)) expectRegistered(id, 'populate.ts:716')
  })

  it('registers every THROWN item — the projectile carries the BARE item id', () => {
    // systems/inventory.ts:205 — makeEntity('projectile', stack.itemId, …).
    // 'pickup.molotov' being registered does NOT cover the molotov in flight.
    for (const id of Object.keys(THROWABLES)) expectRegistered(id, 'systems/inventory.ts:205, thrown in flight')
  })

  it('registers the fixed archetypes', () => {
    for (const a of ['player', 'projectile', 'grenade', 'door', 'fire', 'spore']) {
      expectRegistered(a, 'hardcoded spawn site')
    }
  })

  it('registers the wing keycard, which gates an objective', () => {
    // systems/missions.ts:253 spawns `pickup.keycard.<wing>`; the wing suffix is
    // dynamic, so the family normalises to one registered archetype.
    expectRegistered(KEYCARD_ARCHETYPE, 'systems/missions.ts:253')
    expect(normalizeArchetype('pickup.keycard.wing0')).toBe(KEYCARD_ARCHETYPE)
    expect(normalizeArchetype('pickup.keycard.wing7')).toBe(KEYCARD_ARCHETYPE)
    expect(registered.has(normalizeArchetype('pickup.keycard.wing3'))).toBe(true)
  })

  it('has no duplicates and fits the u8 index space', () => {
    expect(new Set(ARCHETYPES).size).toBe(ARCHETYPES.length)
    expect(ARCHETYPES.length).toBeLessThanOrEqual(256)
  })

  /**
   * THIS TEST IS SUPPOSED TO FAIL WHEN YOU GROW A WIRE TABLE. That is its job.
   *
   * Both lists below are append-only indices on the wire, and growing either one
   * changes what the bytes mean without changing anything a peer can detect:
   *
   *   ARCHETYPES — `decodeSnapshot` reads `ARCHETYPES[r.u8()] ?? 'player'`, so an
   *   older peer maps every unknown index onto the player and draws each new
   *   object as another Ranger.
   *
   *   WIRE_MODS — a 5-bit index read as `WIRE_MODS[(packed >> 3) & 0x1f]` behind
   *   an `if (id)`, so an older peer silently DROPS a mod it does not know. Less
   *   lurid than phantom Rangers and just as invisible: the same gun reads as
   *   differently modded on the two phones.
   *
   * In both cases the peers still report the same PROTOCOL_VERSION, the handshake
   * gate waves them through, and nothing anywhere errors.
   *
   * That already happened once: 59 archetypes were appended while the version
   * stayed at 1, and the only thing between a player and a screen full of phantom
   * Rangers was remembering to reinstall on both phones. This test exists because
   * "remember to bump the version" is a convention, and conventions evaporate.
   *
   * When this fails: bump PROTOCOL_VERSION in net/types.ts, add a line to its
   * changelog, then update the number here — in that order. Do NOT simply edit
   * the number to make it green; that reinstates the exact silent mismatch this
   * exists to prevent.
   *
   * (Capacity is a separate concern and is already covered elsewhere: ARCHETYPES
   * must fit u8 above, and WIRE_MODS must fit 5 bits in messages.mods.test.ts.
   * Those catch overflow. This catches divergence.)
   */
  it('pins the wire tables to PROTOCOL_VERSION, so growing one cannot ship silently', () => {
    expect({
      version: PROTOCOL_VERSION,
      archetypes: ARCHETYPES.length,
      mods: WIRE_MODS.length,
    }).toEqual({
      version: 3,
      archetypes: 88,
      mods: 18,
    })
  })
})

describe('kindOf agrees with the kind the host actually spawns', () => {
  // A registered archetype whose kind is wrong is only half-fixed: the two
  // screens agree on the name and disagree on what sort of thing it is.
  it('maps world objects to interactable, not npc', () => {
    for (const id of Object.keys(OBJECTS)) {
      expect(kindOf(id), `world object '${id}'`).toBe('interactable')
    }
  })

  it('maps NPCs to npc', () => {
    for (const id of Object.keys(NPCS)) expect(kindOf(id), `npc '${id}'`).toBe('npc')
  })

  it('maps item and mod pickups to pickup', () => {
    for (const id of Object.keys(ITEMS)) expect(kindOf(`pickup.${id}`), `pickup.${id}`).toBe('pickup')
    for (const id of Object.keys(MODS)) expect(kindOf(`mod.${id}`), `mod.${id}`).toBe('pickup')
    expect(kindOf(KEYCARD_ARCHETYPE)).toBe('pickup')
  })

  it('maps a thrown item in flight to projectile', () => {
    for (const id of Object.keys(THROWABLES)) expect(kindOf(id), `thrown '${id}'`).toBe('projectile')
  })

  it('maps fire and spore to fire', () => {
    expect(kindOf('fire')).toBe('fire')
    expect(kindOf('spore')).toBe('fire')
  })

  it('still maps the basics', () => {
    expect(kindOf('player')).toBe('player')
    expect(kindOf('door')).toBe('door')
    expect(kindOf('projectile')).toBe('projectile')
  })
})
