import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { combatSystem } from './combat'
import { addItem, equipSlot, MAX_SLOTS, throwActive, wearMelee } from './inventory'
import { arm } from '../testkit'

const player = (w: World): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', 20, 20))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: 'fists', cooldown: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
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
    addItem(slots, 'grenade', 1)
    addItem(slots, 'grenade', 2)
    addItem(slots, 'pistol', 8)
    expect(slots).toHaveLength(2)
    expect(slots.find((s) => s.itemId === 'grenade')!.qty).toBe(3)
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
    expect(e.loadout!.activeSlot).toBe(-1) // still nothing HELD
    expect(e.combat!.weapon).toBe('fists') // and the swung weapon never changed
  })

  it('equipping a throwable holds it without touching the swung weapon', () => {
    const e = player(w)
    arm(e, 'bat')
    e.loadout!.inventory.push({ itemId: 'grenade', qty: 2 })
    expect(equipSlot(e, 1)).toBe(true)
    expect(e.loadout!.activeSlot).toBe(1)
    expect(e.combat!.weapon).toBe('bat')
  })

  it("a PLAYER's melee weapon never wears out — it is the only one they get", () => {
    const e = player(w)
    arm(e, 'knife')
    const stack = e.loadout!.inventory[0]
    stack.qty = 2
    for (let i = 0; i < 5; i++) {
      e.combat!.cooldown = 0
      combatSystem(w, attack())
    }
    expect(e.loadout!.inventory).toHaveLength(1)
    expect(e.combat!.weapon).toBe('knife')
    expect(stack.qty).toBe(2) // untouched: no durability is spent
  })

  it("an NPC's melee weapon still breaks when its durability runs out", () => {
    // Enemy gear is unchanged — only the PLAYER's weapon is permanent.
    const npc = addEntity(w, makeEntity('npc', 'thug', 20, 20))
    npc.combat = { weapon: 'knife', cooldown: 0 }
    npc.loadout = { inventory: [{ itemId: 'knife', qty: 2 }], activeSlot: 0 }
    wearMelee(npc)
    expect(npc.loadout.inventory[0].qty).toBe(1)
    wearMelee(npc)
    expect(npc.loadout.inventory).toHaveLength(0)
    expect(npc.combat.weapon).toBe('fists')
  })

  it('throwing spawns a projectile and removes it from the inventory', () => {
    const e = player(w)
    e.loadout!.inventory = [{ itemId: 'grenade', qty: 1 }]
    e.loadout!.activeSlot = 0
    expect(throwActive(w, e)).toBe(true)
    expect(w.entities.some((x) => x.projectile)).toBe(true)
    expect(e.loadout!.inventory).toHaveLength(0)
  })
})
