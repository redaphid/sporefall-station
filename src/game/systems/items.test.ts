import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { WEAPONS } from '../data/items'
import { combatSystem } from './combat'
import { fireAt } from './fire'
import { applyAreaEffect } from './itemEffects'
import { equipSlot, throwActive, useHeld } from './inventory'
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
      e.loadout!.inventory = [{ itemId: 'shotgun', qty: 6 }]
      equipSlot(e, 0)
      combatSystem(w, attack())
      const pellets = w.entities.filter((x) => x.projectile)
      expect(pellets).toHaveLength(WEAPONS.shotgun.pellets!)
      expect(new Set(pellets.map((p) => p.facing)).size).toBeGreaterThan(1)
    })

    it('a freeze ray freezes the target it hits', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'freezeRay', qty: 6 }]
      equipSlot(e, 0)
      const target = dummy(w, 22, 20)
      combatSystem(w, attack())
      for (let t = 0; t < 30 && !hasStatus(target, 'frozen'); t++) projectileSystem(w)
      expect(hasStatus(target, 'frozen')).toBe(true)
    })

    it('a tranquilizer puts the target to sleep', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'tranquilizer', qty: 5 }]
      equipSlot(e, 0)
      const target = dummy(w, 22, 20)
      combatSystem(w, attack())
      for (let t = 0; t < 30 && target.status!.sleep === 0; t++) projectileSystem(w)
      expect(target.status!.sleep).toBeGreaterThan(0)
    })
  })

  describe('melee onHit', () => {
    it('a sledgehammer stuns what it hits', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'sledgehammer', qty: 12 }]
      equipSlot(e, 0)
      const target = dummy(w, 21, 20)
      combatSystem(w, attack())
      expect(target.status!.stun).toBeGreaterThan(0)
    })
  })

  describe('throwables', () => {
    it('throwing a freeze grenade freezes a nearby NPC where it lands', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'freezeGrenade', qty: 1 }]
      e.loadout!.activeSlot = 0
      const victim = dummy(w, 23, 20)
      throwActive(w, e)
      for (let t = 0; t < 60 && !hasStatus(victim, 'frozen'); t++) projectileSystem(w)
      expect(hasStatus(victim, 'frozen')).toBe(true)
      expect(e.loadout!.inventory).toHaveLength(0)
    })

    it('throwing chloroform puts a nearby NPC to sleep', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'chloroform', qty: 1 }]
      e.loadout!.activeSlot = 0
      const victim = dummy(w, 22, 20)
      throwActive(w, e)
      for (let t = 0; t < 60 && victim.status!.sleep === 0; t++) projectileSystem(w)
      expect(victim.status!.sleep).toBeGreaterThan(0)
    })
  })

  describe('consumables (onUse)', () => {
    it('a burger heals the user', () => {
      const e = player(w)
      e.health!.hp = 50
      e.loadout!.inventory = [{ itemId: 'burger', qty: 1 }]
      e.loadout!.activeSlot = 0
      useHeld(w, e)
      expect(e.health!.hp).toBeGreaterThan(50)
      expect(e.loadout!.inventory).toHaveLength(0)
    })

    it('an adrenaline shot applies a self buff status', () => {
      const e = player(w)
      e.loadout!.inventory = [{ itemId: 'adrenaline', qty: 1 }]
      e.loadout!.activeSlot = 0
      useHeld(w, e)
      expect(hasStatus(e, 'hasted')).toBe(true)
    })
  })
})
