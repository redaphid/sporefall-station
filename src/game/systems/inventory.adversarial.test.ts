import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type ItemStack } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { combatSystem } from './combat'
import { addItem, activeStack, equipSlot, MAX_SLOTS, throwActive, useHeld, wearMelee } from './inventory'

/** The swung weapon is no longer chosen from the hotbar (one permanent weapon),
 * so tests that need a specific weapon in hand set `combat.weapon` directly —
 * which is exactly what `spawnPlayer` and `npcLoadout` do in production. */
const wield = (e: Entity, weapon: string): void => {
  e.combat!.weapon = weapon
}

const player = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, crimeUntilTick: 0 }
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

    it('refuses to equip a non-usable class (key) — and WEAPONS are not usable', () => {
      const e = player(w)
      e.loadout!.inventory = [
        { itemId: 'briefcase', qty: 1 },
        { itemId: 'bat', qty: 12 },
        { itemId: 'pistol', qty: 1 },
      ]
      expect(equipSlot(e, 0)).toBe(false)
      // The player carries ONE permanent weapon; a weapon slot is never a
      // hotbar selection, so equipping one is refused outright.
      expect(equipSlot(e, 1)).toBe(false)
      expect(equipSlot(e, 2)).toBe(false)
      expect(e.loadout!.activeSlot).toBe(-1)
    })

    it('equipping a consumable holds it without changing the swung weapon', () => {
      const e = player(w)
      wield(e, 'bat')
      e.loadout!.inventory = [
        { itemId: 'bat', qty: 12 },
        { itemId: 'medkit', qty: 2 },
      ]
      expect(equipSlot(e, 1)).toBe(true)
      expect(e.loadout!.activeSlot).toBe(1)
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
      wield(e, 'bat')
      e.loadout!.inventory = [{ itemId: 'bat', qty: 12 }]
      expect(throwActive(w, e)).toBe(false)
    })

    it('throwing the last throwable empties the slot; a second throw returns false', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'molotov', qty: 1 }]
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

    it('breaking the equipped weapon drops the player to fists and clears activeSlot', () => {
      const e = player(w)
      wield(e, 'knife')
      e.loadout!.inventory = [{ itemId: 'knife', qty: 1 }]
      wearMelee(e)
      expect(e.loadout!.inventory).toHaveLength(0)
      expect(e.combat!.weapon).toBe('fists')
      expect(e.loadout!.activeSlot).toBe(-1)
      expect(activeStack(e)).toBeUndefined()
    })

    it('removing a slot below the active slot shifts activeSlot down and keeps the weapon', () => {
      const e = player(w)
      e.loadout!.inventory = [
        { itemId: 'molotov', qty: 1 },
        { itemId: 'bat', qty: 12 },
      ]
      wield(e, 'bat') // the bat is the swung weapon, in slot 1
      // Throw the molotov in the lower slot; the array shrinks under the active slot.
      e.loadout!.activeSlot = 1
      throwActive(w, e) // throws slot 0 (only throwable), removeSlot(0)
      expect(e.loadout!.inventory).toHaveLength(1)
      expect(e.loadout!.inventory[0].itemId).toBe('bat')
      expect(e.loadout!.activeSlot).toBe(0)
      expect(e.combat!.weapon).toBe('bat')
    })
  })

  describe('pickup / addItem edge cases', () => {
    it('refuses a fresh slot past the cap but still stacks into an existing stackable', () => {
      const slots: ItemStack[] = []
      for (let i = 0; i < MAX_SLOTS - 1; i++) addItem(slots, `weapon${i}`, 1)
      addItem(slots, 'medkit', 1) // fills the last slot
      expect(slots).toHaveLength(MAX_SLOTS)
      expect(addItem(slots, 'freezeRay', 1)).toBe(false) // full, new slot refused
      expect(addItem(slots, 'medkit', 5)).toBe(true) // stacks into existing
      expect(slots.find((s) => s.itemId === 'medkit')!.qty).toBe(6)
    })

    it('does not crash on a huge quantity and preserves it', () => {
      const slots: ItemStack[] = []
      expect(addItem(slots, 'medkit', 1_000_000)).toBe(true)
      addItem(slots, 'medkit', 1_000_000)
      expect(slots[0].qty).toBe(2_000_000)
    })

    it('does not crash on a negative quantity', () => {
      const slots: ItemStack[] = []
      expect(() => addItem(slots, 'medkit', -5)).not.toThrow()
      expect(slots[0].qty).toBe(-5)
    })
  })

  // --- Regression guards for the equipped-weapon vs held-item divergence bug ---
  // A consumable/throwable can be "held" (activeSlot) while a real weapon stays in
  // hand (combat.weapon points at a different slot). Durability spend and the
  // break-to-fists reset must follow the WEAPON's slot, not the held slot.
  describe('held item vs swung weapon must not cross wires', () => {
    it('swinging the bat wears the bat, not the held consumable', () => {
      const e = player(w)
      wield(e, 'bat')
      e.loadout!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'medkit', qty: 1 },
      ]
      equipSlot(e, 1) // hold the medkit; weapon still bat
      wearMelee(e)
      expect(e.loadout!.inventory.find((s) => s.itemId === 'bat')!.qty).toBe(4)
      expect(e.loadout!.inventory.find((s) => s.itemId === 'medkit')!.qty).toBe(1)
    })

    it('firing the pistol spends NOTHING — no ammo, and never the held throwable', () => {
      const e = player(w)
      wield(e, 'pistol')
      e.loadout!.inventory = [
        { itemId: 'pistol', qty: 1 },
        { itemId: 'molotov', qty: 3 },
      ]
      equipSlot(e, 1) // hold the molotov; weapon still pistol
      for (let i = 0; i < 50; i++) {
        e.combat!.cooldown = 0
        combatSystem(w, attack())
      }
      expect(e.loadout!.inventory.find((s) => s.itemId === 'pistol')!.qty).toBe(1)
      expect(e.loadout!.inventory.find((s) => s.itemId === 'molotov')!.qty).toBe(3)
    })

    it('throwing the held throwable keeps the real weapon in hand (not reset to fists)', () => {
      const e = player(w)
      wield(e, 'bat')
      e.loadout!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'molotov', qty: 1 },
      ]
      equipSlot(e, 1) // hold the molotov
      throwActive(w, e) // spends the molotov, empties slot 1
      expect(e.combat!.weapon).toBe('bat')
      expect(e.loadout!.inventory.some((s) => s.itemId === 'bat')).toBe(true)
    })

    it('through combatSystem: FIRE swings the weapon even with a consumable HELD', () => {
      // FIRE is no longer overloaded onto the held item. With one permanent
      // weapon there is nothing to arbitrate: FIRE always swings/shoots, and
      // the held medkit is left strictly to the USE button. (Without this a
      // player holding a grenade could never shoot again.)
      const e = player(w)
      e.health!.hp = 60
      const target = dummy(w, 21, 20)
      wield(e, 'bat')
      e.loadout!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'medkit', qty: 1 },
      ]
      equipSlot(e, 1) // hold the medkit as the active item
      combatSystem(w, attack())
      expect(target.health!.hp).toBeLessThan(40) // the bat SWUNG
      expect(e.health!.hp).toBe(60) // no heal — FIRE did not touch the medkit
      expect(e.loadout!.inventory.find((s) => s.itemId === 'bat')!.qty).toBe(4) // worn by the swing
      expect(e.combat!.weapon).toBe('bat')
      expect(e.loadout!.inventory.some((s) => s.itemId === 'medkit')).toBe(true) // unspent
    })

    it('through combatSystem: USE consumes the held item and leaves the weapon alone', () => {
      const e = player(w)
      e.health!.hp = 60
      wield(e, 'bat')
      e.loadout!.inventory = [
        { itemId: 'bat', qty: 5 },
        { itemId: 'medkit', qty: 1 },
      ]
      equipSlot(e, 1)
      const cmd = emptyInput()
      cmd.throwItem = true
      combatSystem(w, new Map([[0, cmd]]))
      expect(e.health!.hp).toBe(100) // 60 + 100 heal, clamped to max
      expect(e.loadout!.inventory.find((s) => s.itemId === 'bat')!.qty).toBe(5) // bat untouched
      expect(e.combat!.weapon).toBe('bat') // still in hand, not reset to fists
      expect(e.loadout!.inventory.some((s) => s.itemId === 'medkit')).toBe(false) // spent
    })
  })
})
