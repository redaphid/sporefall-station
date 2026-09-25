// Test helpers for the "load JSON world → act/tick → assert JSON world" pattern.
// Committed fixtures live in `./__fixtures__/*.json`; a test loads one, drives a
// few ticks (or a dispatched action), and asserts the resulting snapshot against
// another fixture. This module is imported only by tests — never by the app.

import { expect } from 'vitest'
import { WEAPONS } from './data/items'
import type { Entity, ItemStack } from './entity'
import { generateCityLevel } from './levelgen/generate'
import { serializeWorld } from './serialize'
import { emptyInput, type InputCmd } from './types'
import { createWorld, tickWorld, type RunMode, type World } from './world'

// The fixture loaders live in the vitest-free `./fixtures.ts` (the app's
// `?world=` boot hook imports them too); re-export so tests keep one import site.
export { loadFixture, loadFixtureJson } from './fixtures'

/** Tick a world `n` times, feeding a fresh, defaulted clone of `inputs` each tick
 * (partial commands are filled from `emptyInput`). Returns the world for chaining. */
export const runTicks = (w: World, inputs: Map<number, Partial<InputCmd>>, n: number): World => {
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([...inputs].map(([slot, cmd]) => [slot, { ...emptyInput(), ...cmd }])))
  }
  return w
}

/**
 * Arm `e` with `weaponId` as its ONE permanent weapon, in exactly the shape the
 * game itself builds (`spawnPlayer` / `populate.npcLoadout`): a single slotted
 * `ItemStack` — the home its weapon-mods live in — plus a matching
 * `combat.weapon`. Returns that stack so a test can hang mods on it.
 *
 * Tests used to arm an entity by dropping a weapon in slot 0 and calling
 * `equipSlot(e, 0)`. Weapons are no longer selectable (`equipSlot` accepts only
 * throwables and consumables), because a weapon is now something an entity is
 * BORN with rather than something it switches to. Held items still go through
 * `equipSlot`. An existing slot for the same weapon is reused, so a test can lay
 * out a mixed inventory first and then arm from it.
 */
export const arm = (e: Entity, weaponId: string): ItemStack => {
  e.combat = { weapon: weaponId, cooldown: e.combat?.cooldown ?? 0 }
  const ld = (e.loadout ??= { inventory: [], activeSlot: -1 })
  const existing = ld.inventory.find((s) => s.itemId === weaponId)
  if (existing) return existing
  const def = WEAPONS[weaponId]
  const stack: ItemStack = { itemId: weaponId, qty: def?.durability ?? 1 }
  ld.inventory.push(stack)
  return stack
}

/** A world on the sunken-streets CITY generator (raw-floor theme) for any floor.
 * Floors 3, 5, 7… build the indoor complex in play; tests of the city set-pieces
 * (bunkers, courtyard compounds, vaults, industrial squads) use this to keep
 * them covered on any floor. Not deserializable (its level checksum is the city
 * one, not seed+floor's). */
export const createCityWorld = (seed: number, floor: number, mode: RunMode = 'normal', hostile = true): World => {
  const w = createWorld(seed, floor, mode, hostile)
  w.level = generateCityLevel(seed, floor)
  return w
}

/** Assert two worlds are in an identical state by comparing their snapshots. */
export const expectWorldEqual = (a: World, b: World): void => {
  expect(serializeWorld(a)).toEqual(serializeWorld(b))
}
