import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { applyDamage } from './combat'
import { fireAt } from './fire'
import { destroyObject, spawnObject, useObject } from './objects'

const player = (w: World, x = 10, y = 10): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

const npc = (w: World, x: number, y: number, hp = 40): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  return e
}

describe('interactive objects', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('spawns an object with the hp from its data', () => {
    const crate = spawnObject(w, 'crate', 20, 20)
    expect(crate.health!.hp).toBeGreaterThan(0)
    expect(crate.kind).toBe('interactable')
  })

  it('a crate takes weapon damage and, destroyed, drops a pickup', () => {
    const c = spawnObject(w, 'crate', 22, 22)
    applyDamage(w, c, 999, 0, 0, 0, 1)
    expect(c.dead).toBe(true)
    expect(w.entities.some((e) => e.pickup && !e.dead)).toBe(true)
  })

  it('an exploding barrel emits an explosion, damages nearby entities and ignites fire', () => {
    const barrel = spawnObject(w, 'barrel', 20, 20)
    const bystander = npc(w, 21, 20)
    applyDamage(w, barrel, 999, 0, 0, 0, 1)
    expect(barrel.dead).toBe(true)
    expect(w.events.some((e) => e.type === 'explosion')).toBe(true)
    expect(bystander.health!.hp).toBeLessThan(40)
    expect(fireAt(w, 20, 20)).toBe(true)
  })

  it('barrels chain-explode: destroying one detonates an adjacent barrel', () => {
    const a = spawnObject(w, 'barrel', 20, 20)
    const b = spawnObject(w, 'barrel', 21, 20)
    applyDamage(w, a, 999, 0, 0, 0, 1)
    expect(a.dead).toBe(true)
    expect(b.dead).toBe(true)
    expect(w.events.filter((e) => e.type === 'explosion').length).toBeGreaterThanOrEqual(2)
  })

  it('a barrel shrugs off damage below its threshold', () => {
    const barrel = spawnObject(w, 'barrel', 20, 20)
    applyDamage(w, barrel, 2, 0, 0, 0, 1)
    expect(barrel.dead).toBeFalsy()
    expect(w.events.some((e) => e.type === 'explosion')).toBe(false)
  })

  it('a supply terminal dispenses a medkit once when used', () => {
    const p = player(w)
    const atm = spawnObject(w, 'atm', 11, 10)
    expect(useObject(w, p, atm)).toBe(true)
    expect(w.entities.some((e) => e.pickup?.itemId === 'medkit')).toBe(true)
    // Second use is empty.
    expect(useObject(w, p, atm)).toBe(false)
  })

  it('a vending machine dispenses an item pickup when used', () => {
    const p = player(w)
    const vending = spawnObject(w, 'vending', 11, 10)
    expect(useObject(w, p, vending)).toBe(true)
    expect(w.entities.some((e) => e.pickup && !e.dead)).toBe(true)
  })

  it('destroyObject marks the object dead before its own blast so it never re-hits itself', () => {
    const barrel = spawnObject(w, 'barrel', 20, 20)
    destroyObject(w, barrel, 1)
    expect(barrel.dead).toBe(true)
    // exactly one explosion for a lone barrel
    expect(w.events.filter((e) => e.type === 'explosion').length).toBe(1)
  })
})
