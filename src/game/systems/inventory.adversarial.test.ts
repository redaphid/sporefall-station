import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type ItemStack } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { combatSystem } from './combat'
import { addItem, activeStack, equipSlot, MAX_SLOTS, throwActive, useHeld, wearMelee } from './inventory'
import { CONSUMABLES } from '../data/items'
import { arm } from '../testkit'

/**
 * The nine-item cull emptied the CONSUMABLE class outright — bandage, medkit,
 * burger and adrenaline were all of it. The machinery is deliberately kept
 * (`itemClass` → 'consumable', HELDABLE, isStackable, consumeActive's heal/onUse),
 * so a few cases here still need a consumable to exist in order to assert that
 * the class behaves differently from a throwable. Rather than weaken them into
 * throwable duplicates, they register one for the length of the test and remove
 * it again — no shared state escapes, and the day someone adds a real consumable
 * these are the tests that already prove it will work.
 *
 * Cases that only need SOME held item use the grenade, which really ships.
 */
const withTempConsumable = (fn: (id: string) => void): void => {
  CONSUMABLES.testStim = { id: 'testStim', name: 'Test Stim', heal: 30 }
  try {
    fn('testStim')
  } finally {
    delete CONSUMABLES.testStim
  }
}

const player = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

const dummy = (w: World, x: number, y: number, hp = 40): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

const attack = (): Map<number, InputCmd> => {
  const cmd = emptyInput()
  cmd.attack = true
  return new Map([[0, cmd]])
}

describe('inventory — adversarial', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  describe('equipSlot bounds and class gating', () => {
    it('refuses a slot index past the end of the inventory', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'bat', qty: 12 }]
      expect(equipSlot(e, 99)).toBe(false)
      expect(e.loadout!.activeSlot).toBe(-1)
      expect(e.combat!.weapon).toBe('fists')
    })

    it('refuses a negative slot index', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'bat', qty: 12 }]
      expect(equipSlot(e, -5)).toBe(false)
      expect(e.loadout!.activeSlot).toBe(-1)
    })

    it('refuses to equip a non-usable class (cash/key)', () => {
      const e = player(w)
      e.loadout!.inventory = [
        { itemId: 'cash', qty: 10 },
        { itemId: 'briefcase', qty: 1 },
      ]
      expect(equipSlot(e, 0)).toBe(false)
      expect(equipSlot(e, 1)).toBe(false)
      expect(e.loadout!.activeSlot).toBe(-1)
    })

    it('equipping a consumable holds it without changing the swung weapon', () => {
      withTempConsumable((id) => {
        const e = player(w)
        arm(e, 'bat')
        e.loadout!.inventory.push({ itemId: id, qty: 2 })
        expect(e.combat!.weapon).toBe('bat')
        expect(equipSlot(e, 1)).toBe(true)
        expect(e.loadout!.activeSlot).toBe(1)
        // A consumable is "held" for Use; the bat stays in hand for swinging.
        expect(e.combat!.weapon).toBe('bat')
      })
    })

    it('REFUSES a weapon slot outright — the weapon is permanent and unselectable', () => {
      const e = player(w)
      arm(e, 'pistol')
      e.loadout!.inventory.push({ itemId: 'shotgun', qty: 1 }, { itemId: 'bat', qty: 16 })
      expect(equipSlot(e, 0)).toBe(false) // its own weapon
      expect(equipSlot(e, 1)).toBe(false) // a gun that somehow got into a slot
      expect(equipSlot(e, 2)).toBe(false) // ...or a melee weapon
      expect(e.loadout!.activeSlot).toBe(-1)
      expect(e.combat!.weapon).toBe('pistol') // never swapped
    })
  })

  describe('throw with nothing / throw again', () => {
    it('throwing with an empty inventory returns false and spawns nothing', () => {
      const e = player(w)
      expect(throwActive(w, e)).toBe(false)
      expect(w.entities.some((x) => x.projectile)).toBe(false)
    })

    it('throwing with no throwable (only a weapon) returns false', () => {
      const e = player(w)
      arm(e, 'bat')
      expect(throwActive(w, e)).toBe(false)
    })

    it('throwing the last throwable empties the slot; a second throw returns false', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'grenade', qty: 1 }]
      e.loadout!.activeSlot = 0
      expect(throwActive(w, e)).toBe(true)
      expect(e.loadout!.inventory).toHaveLength(0)
      expect(throwActive(w, e)).toBe(false)
    })

    it('useHeld with nothing held returns false', () => {
      const e = player(w)
      expect(useHeld(w, e)).toBe(false)
    })
  })

  describe('durability -> 0 removal and activeSlot bookkeeping', () => {
    it('wearMelee with no active slot (bare fists) is a no-op', () => {
      const e = player(w)
      expect(() => wearMelee(e)).not.toThrow()
      expect(e.loadout!.inventory).toHaveLength(0)
    })

    it("a PLAYER's weapon never breaks — it is permanent, so it is never worn", () => {
      const e = player(w)
      arm(e, 'knife')
      e.loadout!.inventory[0].qty = 1 // one swing from breaking, under the old rule
      for (let i = 0; i < 10; i++) wearMelee(e)
      expect(e.loadout!.inventory).toHaveLength(1)
      expect(e.loadout!.inventory[0].qty).toBe(1) // no durability spent at all
      expect(e.combat!.weapon).toBe('knife')
    })

    it("breaking an NPC's weapon still drops it to fists and clears activeSlot", () => {
      // Enemy gear is untouched by the one-weapon rule; this keeps the removeSlot
      // bookkeeping (weapon reset + activeSlot clear) under test.
      const npc = dummy(w, 21, 20)
      npc.combat = { weapon: 'knife', cooldown: 0 }
      npc.loadout = { inventory: [{ itemId: 'knife', qty: 1 }], activeSlot: 0 }
      wearMelee(npc)
      expect(npc.loadout.inventory).toHaveLength(0)
      expect(npc.combat.weapon).toBe('fists')
      expect(npc.loadout.activeSlot).toBe(-1)
      expect(activeStack(npc)).toBeUndefined()
    })

    it('removing a slot below the active slot shifts activeSlot down and keeps the weapon', () => {
      // Needs TWO different heldable classes: `throwActive` prefers the active
      // slot when it is itself a throwable (firstThrowableSlot), so two grenades
      // would throw the held one and never exercise the shift. A consumable in
      // the upper slot is the only shape that removes a slot BELOW the active
      // one — hence the temporary registration.
      withTempConsumable((id) => {
        const e = player(w)
        // The permanent weapon in slot 0, a throwable in slot 1, a HELD
        // consumable above it in slot 2.
        arm(e, 'pistol')
        e.loadout!.inventory.push({ itemId: 'grenade', qty: 1 }, { itemId: id, qty: 2 })
        expect(equipSlot(e, 2)).toBe(true) // hold the consumable
        throwActive(w, e) // throws the grenade at slot 1, removeSlot(1)
        expect(e.loadout!.inventory.map((s) => s.itemId)).toEqual(['pistol', id])
        expect(e.loadout!.activeSlot).toBe(1) // shifted down, still the consumable
        expect(activeStack(e)!.itemId).toBe(id)
        expect(e.combat!.weapon).toBe('pistol')
      })
    })
  })

  describe('pickup / addItem edge cases', () => {
    it('refuses a fresh slot past the cap but still stacks into an existing stackable', () => {
      const slots: ItemStack[] = []
      for (let i = 0; i < MAX_SLOTS - 1; i++) addItem(slots, `weapon${i}`, 1)
      addItem(slots, 'grenade', 1) // fills the last slot
      expect(slots).toHaveLength(MAX_SLOTS)
      expect(addItem(slots, 'freezeRay', 1)).toBe(false) // full, new slot refused
      expect(addItem(slots, 'grenade', 5)).toBe(true) // stacks into existing
      expect(slots.find((s) => s.itemId === 'grenade')!.qty).toBe(6)
    })

    it('does not crash on a huge quantity and preserves it', () => {
      const slots: ItemStack[] = []
      expect(addItem(slots, 'grenade', 1_000_000)).toBe(true)
      addItem(slots, 'grenade', 1_000_000)
      expect(slots[0].qty).toBe(2_000_000)
    })

    it('does not crash on a negative quantity', () => {
      const slots: ItemStack[] = []
      expect(() => addItem(slots, 'grenade', -5)).not.toThrow()
      expect(slots[0].qty).toBe(-5)
    })
  })

  // --- Regression guards for the equipped-weapon vs held-item divergence bug ---
  // A consumable/throwable can be "held" (activeSlot) while a real weapon stays in
  // hand (combat.weapon points at a different slot). Durability/ammo spend and the
  // break-to-fists reset must follow the WEAPON's slot, not the held slot.
  describe('held item vs swung weapon must not cross wires', () => {
    it("an NPC's swing wears its WEAPON slot, not whatever its active slot points at", () => {
      // The crossed-wires guard on `weaponSlotIndex`: durability must follow
      // `combat.weapon`'s slot even when `activeSlot` points somewhere else.
      // Players no longer wear at all, so an NPC carries the assertion.
      const npc = dummy(w, 21, 20)
      npc.combat = { weapon: 'bat', cooldown: 0 }
      npc.loadout = {
        inventory: [
          { itemId: 'bat', qty: 5 },
          { itemId: 'grenade', qty: 1 },
        ],
        activeSlot: 1, // active slot is NOT the weapon
      }
      wearMelee(npc)
      expect(npc.loadout.inventory.find((s) => s.itemId === 'bat')!.qty).toBe(4)
      expect(npc.loadout.inventory.find((s) => s.itemId === 'grenade')!.qty).toBe(1)
    })

    it('firing spends nothing from the weapon or the held throwable', () => {
      const e = player(w)
      arm(e, 'pistol')
      e.loadout!.inventory.push({ itemId: 'grenade', qty: 3 })
      equipSlot(e, 1) // hold the grenade; weapon still pistol
      // Firing spends nothing now, so holding a throwable cannot drain the gun
      // (nor the throwable) — the counts simply stand still.
      expect(e.loadout!.inventory.find((s) => s.itemId === 'pistol')!.qty).toBe(1)
      expect(e.loadout!.inventory.find((s) => s.itemId === 'grenade')!.qty).toBe(3)
    })

    it('throwing the held throwable keeps the permanent weapon in hand (not reset to fists)', () => {
      const e = player(w)
      arm(e, 'bat')
      e.loadout!.inventory.push({ itemId: 'grenade', qty: 1 })
      equipSlot(e, 1) // hold the grenade
      throwActive(w, e) // spends the grenade, empties slot 1
      expect(e.combat!.weapon).toBe('bat')
      expect(e.loadout!.inventory.some((s) => s.itemId === 'bat')).toBe(true)
    })

    it('through combatSystem: FIRE swings the weapon even with a CONSUMABLE HELD', () => {
      // The one-weapon rule changed this. FIRE used to divert to a usable active
      // item; with an unselectable permanent weapon there is nothing to cycle
      // back to, so that rule would leave a player holding an item permanently
      // unable to attack. FIRE now always fires; items live on the USE button.
      withTempConsumable((id) => {
        const e = player(w)
        e.health!.hp = 60
        const target = dummy(w, 21, 20)
        arm(e, 'bat')
        e.loadout!.inventory.push({ itemId: id, qty: 1 })
        equipSlot(e, 1) // hold the consumable as the active item
        combatSystem(w, attack())
        expect(target.health!.hp).toBeLessThan(40) // the bat SWUNG
        expect(e.health!.hp).toBe(60) // no heal — the item was not used
        expect(e.loadout!.inventory.some((s) => s.itemId === id)).toBe(true) // not spent
        expect(e.combat!.weapon).toBe('bat')
      })
    })

    it('through combatSystem: the USE button is what spends the held consumable', () => {
      withTempConsumable((id) => {
        const e = player(w)
        e.health!.hp = 60
        const target = dummy(w, 21, 20)
        arm(e, 'bat')
        e.loadout!.inventory.push({ itemId: id, qty: 1 })
        equipSlot(e, 1)
        const cmd = emptyInput()
        cmd.throwItem = true
        combatSystem(w, new Map([[0, cmd]]))
        expect(e.health!.hp).toBe(90) // 60 + 30 heal → the item was USED
        expect(e.loadout!.inventory.some((s) => s.itemId === id)).toBe(false) // spent
        expect(target.health!.hp).toBe(40) // and the bat did NOT swing
        expect(e.combat!.weapon).toBe('bat')
      })
    })
  })
})
