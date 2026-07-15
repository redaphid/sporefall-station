import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { makeEntity } from '../game/entity'
import { createWorld } from '../game/world'
import { inspectCard } from './inspectModel'

const rowMap = (rows: { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(rows.map((r) => [r.label, r.value]))

describe('inspectCard — friendly readout subset', () => {
  it('summarizes an NPC: title, hp, faction, disposition, weapon', () => {
    const w = createWorld(1, 1)
    const cop = spawnNpc(w, 'cop', 5, 5)
    const card = inspectCard(cop)
    expect(card.title).toMatch(/Cop · npc/)
    const rows = rowMap(card.rows)
    expect(rows.HP).toMatch(/^\d+\/\d+$/)
    expect(rows.Faction).toBe('Cop')
    expect(rows.Disposition).toBeDefined()
    expect(rows.Weapon).toBeDefined()
  })

  it('reads a player card (slot, class)', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'soldier', 2, 2)
    const rows = rowMap(inspectCard(p).rows)
    expect(rows.Player).toMatch(/P1/)
  })

  it("surfaces the equipped gun's mods so a kid can SEE the build", () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'soldier', 2, 2)
    p.combat!.weapon = 'shotgun'
    p.playerCtl!.inventory.push({ itemId: 'shotgun', qty: 6, mods: [{ id: 'frost', stacks: 1 }, { id: 'bounce', stacks: 2 }] })
    p.playerCtl!.activeSlot = 0
    const rows = rowMap(inspectCard(p).rows)
    expect(rows.Weapon).toBe('Shotgun')
    expect(rows['❄️ Cryo Rounds']).toBe('×1')
    expect(rows['🪃 Bouncy']).toBe('×2')
  })

  it('a vanilla gun shows no mod rows', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'soldier', 2, 2)
    p.combat!.weapon = 'pistol'
    p.playerCtl!.inventory.push({ itemId: 'pistol', qty: 6 })
    p.playerCtl!.activeSlot = 0
    const rows = inspectCard(p).rows
    expect(rows.some((r) => r.value.startsWith('×'))).toBe(false)
  })

  it('reads a door lock state', () => {
    const door = makeEntity('door', 'door.wood', 3, 3)
    door.door = { open: false, locked: true, lockLevel: 2 }
    door.interact = { verb: 'open', range: 1 }
    const rows = rowMap(inspectCard(door).rows)
    expect(rows.Door).toBe('Locked (L2)')
    expect(rows.Interact).toBe('Open')
  })

  it('reads a pickup item + its effect (weapon damage / consumable heal)', () => {
    const gun = makeEntity('pickup', 'pistol', 1, 1)
    gun.pickup = { itemId: 'pistol', qty: 1 }
    const gunRows = rowMap(inspectCard(gun).rows)
    expect(gunRows.Item).toMatch(/Pistol/)
    expect(gunRows.Damage).toBeDefined()

    const med = makeEntity('pickup', 'medkit', 1, 1)
    med.pickup = { itemId: 'medkit', qty: 2 }
    const medRows = rowMap(inspectCard(med).rows)
    expect(medRows.Item).toMatch(/Medkit ×2/)
    expect(medRows.Heal).toBe('100')
  })

  it('never throws on a bare entity with no components', () => {
    const bare = makeEntity('interactable', 'mystery.thing', 0, 0)
    const card = inspectCard(bare)
    expect(card.title).toBe('Mystery Thing · interactable')
    expect(card.rows).toEqual([])
  })
})
