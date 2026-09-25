import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { CONSUMABLES, THROWABLES, WEAPONS } from '../data/items'
import { combatSystem } from './combat'
import { fireAt } from './fire'
import { applyAreaEffect } from './itemEffects'
import { throwActive, useHeld } from './inventory'
import { arm } from '../testkit'
import { projectileSystem } from './projectiles'
import { hasStatus } from './statusFx'

const player = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  e.facing = 0
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

describe('item breadth', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  describe('area effects (declarative onLand)', () => {
    it('fire ignites the landing tile', () => {
      applyAreaEffect(w, 5.5, 5.5, { kind: 'fire' }, 0)
      expect(fireAt(w, 5, 5)).toBe(true)
    })

    it('explode damages actors within the radius', () => {
      const near = dummy(w, 5, 5)
      const far = dummy(w, 12, 12)
      applyAreaEffect(w, 5, 5, { kind: 'explode', radius: 2, damage: 30 }, 0)
      expect(near.health!.hp).toBeLessThan(40)
      expect(far.health!.hp).toBe(40)
    })

    it('status burst applies a status to actors in the radius', () => {
      const near = dummy(w, 5, 5)
      const far = dummy(w, 12, 12)
      applyAreaEffect(w, 5, 5, { kind: 'status', status: 'frozen', ticks: 60, radius: 2 }, 0)
      expect(hasStatus(near, 'frozen')).toBe(true)
      expect(hasStatus(far, 'frozen')).toBe(false)
    })

    it('sleep and slip route to the legacy timers, not fx', () => {
      const a = dummy(w, 5, 5)
      const b = dummy(w, 5, 5)
      applyAreaEffect(w, 5, 5, { kind: 'status', status: 'sleep', ticks: 90, radius: 1 }, 0)
      expect(a.status!.sleep).toBe(90)
      applyAreaEffect(w, 5, 5, { kind: 'status', status: 'slip', ticks: 30, radius: 1 }, 0)
      expect(b.status!.stun).toBe(30)
    })
  })

  describe('ranged weapons', () => {
    it('a shotgun fires its full spread of pellets in one shot, at varied angles', () => {
      const e = player(w)
      arm(e, 'shotgun')
      combatSystem(w, attack())
      const pellets = w.entities.filter((x) => x.projectile)
      expect(pellets).toHaveLength(WEAPONS.shotgun.pellets!)
      expect(new Set(pellets.map((p) => p.facing)).size).toBeGreaterThan(1)
    })

    it('a freeze ray freezes the target it hits', () => {
      const e = player(w)
      arm(e, 'freezeRay')
      const target = dummy(w, 22, 20)
      combatSystem(w, attack())
      for (let t = 0; t < 30 && !hasStatus(target, 'frozen'); t++) projectileSystem(w)
      expect(hasStatus(target, 'frozen')).toBe(true)
    })

    it('a tranquilizer puts the target to sleep', () => {
      const e = player(w)
      arm(e, 'tranquilizer')
      const target = dummy(w, 22, 20)
      combatSystem(w, attack())
      for (let t = 0; t < 30 && target.status!.sleep === 0; t++) projectileSystem(w)
      expect(target.status!.sleep).toBeGreaterThan(0)
    })
  })

  describe('melee onHit', () => {
    it('a sledgehammer stuns what it hits', () => {
      const e = player(w)
      arm(e, 'sledgehammer')
      const target = dummy(w, 21, 20)
      combatSystem(w, attack())
      expect(target.status!.stun).toBeGreaterThan(0)
    })
  })

  // The freeze-grenade and chloroform throws that used to live here went with
  // the item cull. The MECHANIC they covered — throwActive lobs the held item,
  // the projectile lands, its declarative `onLand` fires, the slot empties — is
  // unchanged and is re-covered below through the grenade, the one throwable
  // deliberately kept. The status and sleep area effects themselves are still
  // asserted directly in 'area effects (declarative onLand)' above, so removing
  // the two items cost no coverage of the effects, only of the items.
  describe('throwables', () => {
    it('the grenade is the only throwable left, and it is still here', () => {
      expect(Object.keys(THROWABLES)).toEqual(['grenade'])
    })

    it('throwing a grenade explodes where it lands and empties the slot', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'grenade', qty: 1 }]
      e.loadout!.activeSlot = 0
      const victim = dummy(w, 23, 20)
      throwActive(w, e)
      for (let t = 0; t < 60 && victim.health!.hp === 40; t++) projectileSystem(w)
      expect(victim.health!.hp).toBeLessThan(40)
      expect(e.loadout!.inventory).toHaveLength(0)
    })

    it('a throwable id that no longer exists is inert — no projectile, slot kept', () => {
      // What an old save or a pre-cull peer can still hand us. `throwActive`
      // must refuse it rather than lob an undefined-speed projectile.
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'molotov', qty: 1 }]
      e.loadout!.activeSlot = 0
      expect(() => throwActive(w, e)).not.toThrow()
      expect(throwActive(w, e)).toBe(false)
      expect(w.entities.filter((x) => x.projectile)).toHaveLength(0)
      expect(e.loadout!.inventory).toHaveLength(1)
    })
  })

  // bandage / medkit / burger / adrenaline were the ENTIRE consumable class and
  // all four were culled, so there is no longer an item that heals or buffs. The
  // burger-heals and adrenaline-buffs cases cannot survive as written. What is
  // kept is the pair of properties that actually matter now:
  //   1. the class is empty ON PURPOSE, and an id from before the cull is inert
  //      rather than a crash (old saves, older peers);
  //   2. the consumable PIPELINE still works, so the machinery deliberately left
  //      standing in data/items.ts is not quietly rotting dead code.
  describe('consumables (onUse)', () => {
    it('there are no consumables — the class was culled entire', () => {
      expect(Object.keys(CONSUMABLES)).toEqual([])
    })

    it('a culled consumable id is inert: no heal, no throw, no crash, slot kept', () => {
      const e = player(w)
      e.health!.hp = 50
      e.loadout!.inventory = [{ itemId: 'medkit', qty: 1 }]
      e.loadout!.activeSlot = 0
      expect(() => useHeld(w, e)).not.toThrow()
      expect(useHeld(w, e)).toBe(false)
      expect(e.health!.hp).toBe(50)
      expect(e.loadout!.inventory).toHaveLength(1)
    })

    it('the consumable pipeline still heals and buffs when a consumable exists', () => {
      // Registered for the duration of this test only: it proves heal + onUse in
      // `consumeActive` are still wired, which an empty table cannot show. If a
      // future consumable is added, it inherits working machinery.
      CONSUMABLES.testStim = { id: 'testStim', name: 'Test Stim', heal: 25, onUse: { status: 'hasted', ticks: 300 } }
      try {
        const e = player(w)
        e.health!.hp = 50
        e.loadout!.inventory = [{ itemId: 'testStim', qty: 1 }]
        e.loadout!.activeSlot = 0
        expect(useHeld(w, e)).toBe(true)
        expect(e.health!.hp).toBe(75)
        expect(hasStatus(e, 'hasted')).toBe(true)
        expect(e.loadout!.inventory).toHaveLength(0)
      } finally {
        delete CONSUMABLES.testStim
      }
    })
  })
})
