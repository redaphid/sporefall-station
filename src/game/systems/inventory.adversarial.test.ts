import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type ItemStack } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { combatSystem } from './combat'
import { addItem, activeStack, equipSlot, MAX_SLOTS, spendAmmo, throwActive, useHeld, wearMelee } from './inventory'

const player = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId: 0, classId: 'soldier', abilityCooldown: 0, inventory: [], cash: 0, crimeUntilTick: 0, activeSlot: -1 }
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
      e.playerCtl!.inventory = [{ itemId: 'bat', qty: 12 }]
      expect(equipSlot(e, 99)).toBe(false)
      expect(e.playerCtl!.activeSlot).toBe(-1)
      expect(e.combat!.weapon).toBe('fists')
    })

    it('refuses a negative slot index', () => {
      const e = player(w)
      e.playerCtl!.inventory = [{ itemId: 'bat', qty: 12 }]
      expect(equipSlot(e, -5)).toBe(false)
      expect(e.playerCtl!.activeSlot).toBe(-1)
    })

    it('refuses to equip a non-usable class (cash/key/ammo)', () => {
      const e = player(w)
      e.playerCtl!.inventory = [
        { itemId: 'cash', qty: 10 },
        { itemId: 'briefcase', qty: 1 },
        { itemId: 'ammo', qty: 30 },
      ]
      expect(equipSlot(e, 0)).toBe(false)
      expect(equipSlot(e, 1)).toBe(false)
      expect(equipSlot(e, 2)).toBe(false)
      expect(e.playerCtl!.activeSlot).toBe(-1)
    })

    it('equipping a consumable holds it without changing the swung weapon', () => {
      const e = player(w)
      e.playerCtl!.inventory = [
        { itemId: 'bat', qty: 12 },
        { itemId: 'bandage', qty: 2 },
      ]
      equipSlot(e, 0)
      expect(e.combat!.weapon).toBe('bat')
      expect(equipSlot(e, 1)).toBe(true)
      expect(e.playerCtl!.activeSlot).toBe(1)
      // A consumable is "held" for Use; the bat stays in hand for swinging.
      expect(e.combat!.weapon).toBe('bat')
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
      e.playerCtl!.inventory = [{ itemId: 'bat', qty: 12 }]
      equipSlot(e, 0)
      expect(throwActive(w, e)).toBe(false)
    })

    it('throwing the last throwable empties the slot; a second throw returns false', () => {
      const e = player(w)
      e.playerCtl!.inventory = [{ itemId: 'molotov', qty: 1 }]
      e.playerCtl!.activeSlot = 0
      expect(throwActive(w, e)).toBe(true)
      expect(e.playerCtl!.inventory).toHaveLength(0)
      expect(throwActive(w, e)).toBe(false)
    })

    it('useHeld with nothing held returns false', () => {
      const e = player(w)
      expect(useHeld(w, e)).toBe(false)
    })
  })

  describe('ammo bookkeeping', () => {
    it('spendAmmo on an unslotted (class-starter) gun is unlimited', () => {
      const e = player(w)
      e.combat!.weapon = 'pistol' // starter gun, no slot in inventory
      expect(spendAmmo(e)).toBe(true)
      expect(spendAmmo(e)).toBe(true)
    })

    it('an empty slotted gun clicks (spendAmmo false) but stays in the slot', () => {
      const e = player(w)
      e.playerCtl!.inventory = [{ itemId: 'pistol', qty: 0 }]
      equipSlot(e, 0)
      expect(spendAmmo(e)).toBe(false)
      expect(e.playerCtl!.inventory).toHaveLength(1) // dead weight, not gone
    })
  })

  describe('durability -> 0 removal and activeSlot bookkeeping', () => {
    it('wearMelee with no active slot (bare fists) is a no-op', () => {
      const e = player(w)
      expect(() => wearMelee(e)).not.toThrow()
      expect(e.playerCtl!.inventory).toHaveLength(0)
    })

    it('breaking the equipped weapon drops the player to fists and clears activeSlot', () => {
      const e = player(w)
      e.playerCtl!.inventory = [{ itemId: 'knife', qty: 1 }]
      equipSlot(e, 0)
      wearMelee(e)
      expect(e.playerCtl!.inventory).toHaveLength(0)
      expect(e.combat!.weapon).toBe('fists')
      expect(e.playerCtl!.activeSlot).toBe(-1)
      expect(activeStack(e)).toBeUndefined()
    })

    it('removing a slot below the active slot shifts activeSlot down and keeps the weapon', () => {
      const e = player(w)
      e.playerCtl!.inventory = [
        { itemId: 'molotov', qty: 1 },
        { itemId: 'bat', qty: 12 },
      ]
      equipSlot(e, 1) // bat active at index 1
      expect(e.combat!.weapon).toBe('bat')
      // Throw the molotov in the lower slot; the array shrinks under the active slot.
      e.playerCtl!.activeSlot = 1
      throwActive(w, e) // throws slot 0 (only throwable), removeSlot(0)
      expect(e.playerCtl!.inventory).toHaveLength(1)
      expect(e.playerCtl!.inventory[0].itemId).toBe('bat')
      expect(e.playerCtl!.activeSlot).toBe(0)
      expect(e.combat!.weapon).toBe('bat')
    })
  })

  describe('pickup / addItem edge cases', () => {
    it('refuses a fresh slot past the cap but still stacks into an existing stackable', () => {
      const slots: ItemStack[] = []
      for (let i = 0; i < MAX_SLOTS - 1; i++) addItem(slots, `weapon${i}`, 1)
      addItem(slots, 'bandage', 1) // fills the last slot
      expect(slots).toHaveLength(MAX_SLOTS)
      expect(addItem(slots, 'freezeRay', 1)).toBe(false) // full, new slot refused
      expect(addItem(slots, 'bandage', 5)).toBe(true) // stacks into existing
      expect(slots.find((s) => s.itemId === 'bandage')!.qty).toBe(6)
    })

    it('does not crash on a huge quantity and preserves it', () => {
      const slots: ItemStack[] = []
      expect(addItem(slots, 'bandage', 1_000_000)).toBe(true)
      addItem(slots, 'bandage', 1_000_000)
      expect(slots[0].qty).toBe(2_000_000)
    })

    it('does not crash on a negative quantity', () => {
      const slots: ItemStack[] = []
      expect(() => addItem(slots, 'bandage', -5)).not.toThrow()
      expect(slots[0].qty).toBe(-5)
    })
  })

  // --- Regression guards for the equipped-weapon vs held-item divergence bug ---
  // A consumable/throwable can be "held" (activeSlot) while a real weapon stays in
  // hand (combat.weapon points at a different slot). Durability/ammo spend and the
  // break-to-fists reset must follow the WEAPON's slot, not the held slot.
  describe('held item vs swung weapon must not cross wires', () => {
    it('swinging the bat wears the bat, not the held consumable', () => {
      const e = player(w)
      e.playerCtl!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'bandage', qty: 1 },
      ]
      equipSlot(e, 0) // weapon = bat
      equipSlot(e, 1) // hold the bandage; weapon still bat
      wearMelee(e)
      expect(e.playerCtl!.inventory.find((s) => s.itemId === 'bat')!.qty).toBe(4)
      expect(e.playerCtl!.inventory.find((s) => s.itemId === 'bandage')!.qty).toBe(1)
    })

    it('firing the pistol spends the pistol mag, not the held throwable', () => {
      const e = player(w)
      e.playerCtl!.inventory = [
        { itemId: 'pistol', qty: 8 },
        { itemId: 'molotov', qty: 3 },
      ]
      equipSlot(e, 0) // weapon = pistol
      equipSlot(e, 1) // hold the molotov; weapon still pistol
      expect(spendAmmo(e)).toBe(true)
      expect(e.playerCtl!.inventory.find((s) => s.itemId === 'pistol')!.qty).toBe(7)
      expect(e.playerCtl!.inventory.find((s) => s.itemId === 'molotov')!.qty).toBe(3)
    })

    it('throwing the held throwable keeps the real weapon in hand (not reset to fists)', () => {
      const e = player(w)
      e.playerCtl!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'molotov', qty: 1 },
      ]
      equipSlot(e, 0) // weapon = bat
      equipSlot(e, 1) // hold the molotov
      throwActive(w, e) // spends the molotov, empties slot 1
      expect(e.combat!.weapon).toBe('bat')
      expect(e.playerCtl!.inventory.some((s) => s.itemId === 'bat')).toBe(true)
    })

    it('through combatSystem: attacking while holding bandages wears the bat', () => {
      const e = player(w)
      dummy(w, 21, 20) // someone to hit so the swing lands
      e.playerCtl!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'bandage', qty: 1 },
      ]
      equipSlot(e, 0)
      equipSlot(e, 1) // hold bandages, bat still swung
      combatSystem(w, attack())
      expect(e.playerCtl!.inventory.find((s) => s.itemId === 'bat')!.qty).toBe(4)
      expect(e.playerCtl!.inventory.some((s) => s.itemId === 'bandage')).toBe(true)
    })
  })
})
