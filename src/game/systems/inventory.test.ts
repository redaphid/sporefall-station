import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { combatSystem } from './combat'
import { addItem, equipSlot, MAX_SLOTS, throwActive } from './inventory'

const player = (w: World): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', 20, 20))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

const attack = (): Map<number, InputCmd> => {
  const cmd = emptyInput()
  cmd.attack = true
  return new Map([[0, cmd]])
}

describe('inventory', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('stacks stackable items into one slot but gives weapons their own slot', () => {
    const slots: { itemId: string; qty: number }[] = []
    addItem(slots, 'molotov', 1)
    addItem(slots, 'molotov', 2)
    addItem(slots, 'pistol', 8)
    expect(slots).toHaveLength(2)
    expect(slots.find((s) => s.itemId === 'molotov')!.qty).toBe(3)
  })

  it('refuses new slots past the cap', () => {
    const slots: { itemId: string; qty: number }[] = []
    for (let i = 0; i < MAX_SLOTS; i++) expect(addItem(slots, `w${i}`, 1)).toBe(true)
    expect(addItem(slots, 'overflow', 1)).toBe(false)
  })

  it('a weapon slot can NEVER be equipped — the weapon is permanent', () => {
    const e = player(w)
    e.loadout!.inventory = [
      { itemId: 'bat', qty: 12 },
      { itemId: 'pistol', qty: 1 },
    ]
    expect(equipSlot(e, 0)).toBe(false)
    expect(equipSlot(e, 1)).toBe(false)
    expect(e.loadout!.activeSlot).toBe(-1)
    expect(e.combat!.weapon).toBe('fists') // untouched by the hotbar
  })

  it('firing a ranged weapon never decrements it — there is no ammo', () => {
    const e = player(w)
    e.combat!.weapon = 'pistol'
    e.loadout!.inventory = [{ itemId: 'pistol', qty: 1 }]
    const shots = () => w.entities.filter((x) => x.projectile).length

    for (let i = 0; i < 20; i++) {
      e.combat!.cooldown = 0
      combatSystem(w, attack())
    }
    expect(shots()).toBe(20)
    expect(e.loadout!.inventory[0].qty).toBe(1) // never drew down
  })

  it('a melee weapon breaks when its durability runs out', () => {
    const e = player(w)
    e.combat!.weapon = 'knife'
    e.loadout!.inventory = [{ itemId: 'knife', qty: 2 }]
    combatSystem(w, attack())
    e.combat!.cooldown = 0
    combatSystem(w, attack())
    expect(e.loadout!.inventory).toHaveLength(0)
    expect(e.combat!.weapon).toBe('fists')
  })

  it('throwing spawns a projectile and removes it from the inventory', () => {
    const e = player(w)
    e.loadout!.inventory = [{ itemId: 'molotov', qty: 1 }]
    e.loadout!.activeSlot = 0
    expect(throwActive(w, e)).toBe(true)
    expect(w.entities.some((x) => x.projectile)).toBe(true)
    expect(e.loadout!.inventory).toHaveLength(0)
  })
})
