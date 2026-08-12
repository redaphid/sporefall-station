// Item / pickup art resolution.
//
// `artResolution.test.ts` covers PROPS and furniture — it asserts every interior
// archetype reaches a real sprite or a distinct procedural shape. There was no
// equivalent for ITEMS, and that gap is exactly why two impostors shipped:
//
//   * `banana` — in the floor-2+ loot table and in SHOP_STOCK, ~1 per floor —
//     had no `ITEM_ALIAS` entry, so art.ts's chain ended at `sprites.item` →
//     `item.default`, which every shipped theme maps to the SAME FILE as
//     `item.medkit`. A banana peel on the floor looked like a medkit.
//   * `claws` — the boss's weapon — was droppable because `isDroppableWeapon`
//     excluded the literal id 'fists' rather than the `natural` flag, so killing
//     the boss spawned another fake medkit that swapped your weapon on pickup.
//
// The failure mode is silent by construction: the fallback is a REAL texture, so
// nothing throws, nothing warns, and the render suite stays green. Only an
// assertion about MEANING catches it. Hence this file.
import { describe, expect, it } from 'vitest'
import { ITEM_ALIAS } from './art'
import { ITEM_IDS } from './theme'
import { LOOT_ITEM_IDS } from '../game/populate'
import { isDroppableWeapon } from '../game/systems/combat'
import { CONSUMABLES, WEAPONS } from '../game/data/items'
import { NPCS } from '../game/data/npcs'

const DECLARED: readonly string[] = ITEM_IDS

/** Mirror of art.ts `spriteForArchetype`'s pickup branch:
 *   sprites.items[id] ?? sprites.items[ITEM_ALIAS[id]] ?? sprites.item
 * Returns the `item.<key>` this id lands on, or undefined when it falls all the
 * way through to `item.default` — which is the bug this file exists to catch. */
const artKeyFor = (id: string): string | undefined =>
  DECLARED.includes(id) ? id : (ITEM_ALIAS[id] as string | undefined)

/** Every id that can become a `pickup.<id>` entity in a real run: everything the
 * level generator lays down, plus every weapon a corpse can drop. Derived, never
 * restated — a new loot entry or a new weapon is covered the day it is added. */
const REACHABLE: readonly string[] = [
  ...new Set([...LOOT_ITEM_IDS, ...Object.keys(WEAPONS).filter(isDroppableWeapon)]),
]

describe('item / pickup art resolution', () => {
  it('every pickup the game can spawn has real art (never the item.default fallback)', () => {
    for (const id of REACHABLE) {
      expect(
        artKeyFor(id),
        `pickup.${id} resolves to NO item art, so it falls through to item.default — ` +
          `which is the medkit file. Add an ITEM_ALIAS entry or ship item.${id}.`,
      ).toBeDefined()
    }
  })

  it('every ITEM_ALIAS target is itself a declared item key', () => {
    for (const [id, target] of Object.entries(ITEM_ALIAS)) {
      expect(DECLARED, `ITEM_ALIAS[${id}] → item.${target} is not a declared ITEM_ID`).toContain(target)
    }
  })

  // The sharp one. Sharing a sprite is fine and deliberate (four long guns wear
  // the scatter-blaster). Wearing the MEDKIT is different in kind: it is the one
  // sprite that makes a promise about what picking it up does.
  it('nothing wears the medkit sprite unless it actually heals', () => {
    for (const id of REACHABLE) {
      if (artKeyFor(id) !== 'medkit') continue
      expect(
        CONSUMABLES[id]?.heal ?? 0,
        `pickup.${id} wears the medkit sprite but heals nothing — a player grabbing it ` +
          `expects health and gets something else`,
      ).toBeGreaterThan(0)
    }
  })

  it('innate body weapons never drop, so they never need art', () => {
    // Regression pin for the boss. `natural` is the test, not the id: checking
    // for 'fists' expressed the intent but enforced it for one weapon only.
    expect(WEAPONS.fists.natural).toBe(true)
    expect(WEAPONS.claws.natural).toBe(true)
    expect(isDroppableWeapon('fists')).toBe(false)
    expect(isDroppableWeapon('claws')).toBe(false)
    // The boss is the only claws carrier — the drop that produced a fake medkit.
    expect(NPCS.boss.weapon).toBe('claws')
    expect(REACHABLE).not.toContain('claws')
  })

  it('the banana peel is a throwable, not a medkit', () => {
    // The specific bug: guaranteed in the floor-2+ loot table, ~0.97/floor.
    expect(LOOT_ITEM_IDS).toContain('banana')
    expect(artKeyFor('banana')).toBe('grenade-item')
    expect(artKeyFor('banana')).not.toBe('medkit')
  })

  it('a real weapon that CAN drop still resolves (the alias table is not over-tight)', () => {
    for (const id of ['pistol', 'shotgun', 'machinegun', 'sledgehammer', 'stunGun', 'flamethrower']) {
      expect(isDroppableWeapon(id), `${id} should be droppable`).toBe(true)
      expect(artKeyFor(id), `pickup.${id} must have art`).toBeDefined()
    }
  })
})
