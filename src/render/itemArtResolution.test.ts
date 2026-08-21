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
//
// `banana` has since been CULLED, so the impostor that prompted this file is
// gone — but the trap it fell into belongs to the FALLBACK CHAIN, not to that
// item, and it is still armed for every id in the loot tables today. The guards
// below are kept and re-aimed at the survivors, plus a pin that the nine culled
// ids stay out of the loot tables.
import { describe, expect, it } from 'vitest'
import { ITEM_ALIAS } from './art'
import { ITEM_IDS } from './theme'
import { LOOT_ITEM_IDS } from '../game/populate'
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
 * level generator lays down, and nothing else. Corpses no longer drop weapons
 * (the player's weapon is permanent), so the loot tables are now the WHOLE
 * reachable set. Derived, never restated — a new loot entry is covered the day
 * it is added. */
const REACHABLE: readonly string[] = [...new Set(LOOT_ITEM_IDS)]

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
    // Regression pin for the boss. `natural` is the flag the HELD-sprite logic
    // reads (weaponArt.hasHeldWeapon), so it still matters even though nothing
    // drops any more.
    expect(WEAPONS.fists.natural).toBe(true)
    expect(WEAPONS.claws.natural).toBe(true)
    // The boss is the only claws carrier — the drop that produced a fake medkit.
    expect(NPCS.boss.weapon).toBe('claws')
    expect(REACHABLE).not.toContain('claws')
  })

  // The banana peel — the impostor this file was written for — has since been
  // CULLED, along with eight other items. The guard above it is unchanged and
  // still does the real work (every REACHABLE id must resolve to real art), but
  // the specific assertion "banana is a throwable, not a medkit" cannot be kept
  // as written: it asserted `LOOT_ITEM_IDS` CONTAINS banana. So it inverts into
  // the pin for the removal itself — if any of the nine ever creeps back into a
  // loot table, that is a content decision being silently reversed, and it lands
  // here as well as in the populate suites.
  const CULLED = ['banana', 'burger', 'chloroform', 'adrenaline', 'molotov', 'freezeGrenade', 'gasGrenade', 'bandage', 'medkit'] as const

  it('no culled item is reachable as loot any more', () => {
    for (const id of CULLED) {
      expect(REACHABLE, `${id} was culled but is back in a loot table`).not.toContain(id)
    }
  })

  it('the culled items keep NO art alias — an alias for a dead id promises art nothing can ask for', () => {
    for (const id of CULLED) expect(ITEM_ALIAS, `ITEM_ALIAS still aliases culled '${id}'`).not.toHaveProperty(id)
  })

  it('the grenade — deliberately KEPT — still resolves to the spore-grenade art, not the medkit', () => {
    // The survivor of the throwable cull, and the one id that used to share its
    // alias target with banana. Removing banana must not have disturbed it.
    expect(LOOT_ITEM_IDS).toContain('grenade')
    expect(artKeyFor('grenade')).toBe('grenade-item')
    expect(artKeyFor('grenade')).not.toBe('medkit')
  })

  it('NO weapon is reachable as a pickup — the player carries one permanent weapon', () => {
    // The one-weapon rule, pinned at the art layer: if a weapon ever creeps back
    // into a loot table it shows up here as well as in the sim suites. Enemies
    // still CARRY these (NPC_ARSENAL) — they are just never lying on the floor.
    for (const id of Object.keys(WEAPONS)) {
      expect(REACHABLE, `${id} is a weapon and must not be lootable`).not.toContain(id)
    }
  })
})
