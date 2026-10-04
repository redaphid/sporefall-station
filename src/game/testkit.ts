// Test helpers for the "load JSON world → act/tick → assert JSON world" pattern.
// Committed fixtures live in `./__fixtures__/*.json`; a test loads one, drives a
// few ticks (or a dispatched action), and asserts the resulting snapshot against
// another fixture. This module is imported only by tests — never by the app.

import { expect } from 'vitest'
import { WEAPONS } from './data/items'
import type { Entity, ItemStack } from './entity'
import { generateCityLevel } from './levelgen/generate'
import { levelFromJson, type LevelJson } from './levelgen/levelText'
import { spawnPlayer } from './player'
import { populateWorld } from './populate'
import { playerSpawnPoint } from './spawnPlacement'
import { LANDING_STAGE } from './stages/landing'
import { setupFloor } from './systems/missions'
import { serializeWorld } from './serialize'
import { emptyInput, type InputCmd } from './types'
import { tickWorld, worldFromState, type RunMode, type World, type WorldInit } from './world'

// The fixture loaders live in the vitest-free `./fixtures.ts` (the app's
// `?world=` boot hook imports them too); re-export so tests keep one import site.
import { loadFixtureJson } from './fixtures'
export { loadFixture, loadFixtureJson } from './fixtures'

/** Tick a world `n` times, feeding a fresh, defaulted clone of `inputs` each tick
 * (partial commands are filled from `emptyInput`). Returns the world for chaining.
 * Fails the test if any tick leaves an hp that is not a whole number: the
 * snapshot codec can only carry whole hp, so a fraction splits host from client. */
export const runTicks = (w: World, inputs: Map<number, Partial<InputCmd>>, n: number): World => {
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([...inputs].map(([slot, cmd]) => [slot, { ...emptyInput(), ...cmd }])))
    for (const e of w.entities) {
      if (e.health && !Number.isInteger(e.health.hp)) {
        expect.fail(`tick ${w.tick}: ${e.archetype}#${e.id} hp ${e.health.hp} is not whole`)
      }
    }
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
 * Every floor from 3 builds the indoor complex in play; tests of the city set-pieces
 * (bunkers, courtyard compounds, vaults, industrial squads) use this to keep
 * them covered on any floor. To the engine this level is authored (it is not
 * what seed+floor generates), so a snapshot carries it whole. */
export const createCityWorld = (seed: number, floor: number, mode: RunMode = 'normal', hostile = true): World =>
  worldFromState({ level: generateCityLevel(seed, floor), seed, floor, mode, hostile })

/** An authored world from ASCII level rows (levelText glyphs, `@` marks the
 * spawn). The map is the test's own state, so no generator change can move it. */
export const worldFromRows = (rows: readonly string[], init: Omit<WorldInit, 'level'> = {}): World =>
  worldFromState({ ...init, level: levelFromJson({ rows: [...rows] }) })

/** Rows for a `w` x `h` room: a wall ring around open floor, spawn at tile (2, 2). */
export const walledRoom = (w: number, h: number): string[] =>
  Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) =>
      x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : x === 2 && y === 2 ? '@' : '.',
    ).join(''),
  )

/** A bare world on the frozen level `__fixtures__/frozen-<seed>-<floor>.json`:
 * the map that seed+floor built before the districts were reworked, carried
 * whole as authored state. For tests written against one specific layout;
 * the seed still rolls every die. */
export const frozenWorld = (seed: number, floor: number, mode: RunMode = 'normal', hostile = true): World => {
  const j = loadFixtureJson(`frozen-${seed}-${floor}`)
  if (!j.level) throw new Error(`frozen-${seed}-${floor} carries no level`)
  return worldFromState({ level: levelFromJson(j.level), seed, floor, mode, hostile })
}

/** A world on an authored stage (stages/, the landing stage by default),
 * populated, its floor set up and player 0 at its spawn, the way HostSession
 * builds a run. Seed only rolls the dice. */
export const stageWorld = (seed: number, mode: RunMode = 'normal', stage: LevelJson = LANDING_STAGE): World => {
  const w = worldFromState({ level: levelFromJson(stage), seed, floor: 1, mode })
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  return w
}

/** Assert two worlds are in an identical state by comparing their snapshots. */
export const expectWorldEqual = (a: World, b: World): void => {
  expect(serializeWorld(a)).toEqual(serializeWorld(b))
}
