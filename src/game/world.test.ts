import { describe, expect, it } from 'vitest'
import { spawnPlayer } from './player'
import { populateWorld } from './populate'
import { spawnNpc } from './populate'
import { emptyInput, type InputCmd } from './types'
import { addEntity, createWorld, tickWorld } from './world'
import { makeEntity } from './entity'

const tickN = (w: ReturnType<typeof createWorld>, inputs: Map<number, InputCmd>, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, inputs)
}

describe('sim integration', () => {
  it('player melee attack damages and kills an adjacent thug', () => {
    const w = createWorld(5, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    player.combat!.weapon = 'fists' // pin melee — soldier starts with a pistol
    const thug = spawnNpc(w, 'thug', 11.5, 1.5)
    player.facing = 0 // facing +x, toward the thug

    const attack = { ...emptyInput(), attack: true }
    const inputs = new Map([[0, attack]])
    tickWorld(w, inputs)
    expect(thug.health!.hp).toBeLessThan(thug.health!.max)

    // Keep swinging until it dies (cooldowns apply); generous budget.
    tickN(w, inputs, 300)
    expect(w.byId.get(thug.id)).toBeUndefined() // dead and swept
  })

  it('thug aggros a visible player and closes distance', () => {
    const w = createWorld(6, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    const thug = spawnNpc(w, 'thug', 15.5, 1.5) // 5 tiles away on open road, within sight 7
    const idle = new Map([[0, emptyInput()]])
    const d0 = Math.hypot(thug.pos.x - player.pos.x, thug.pos.y - player.pos.y)
    tickN(w, idle, 60)
    const d1 = Math.hypot(thug.pos.x - player.pos.x, thug.pos.y - player.pos.y)
    expect(d1).toBeLessThan(d0 - 1)
    // And eventually lands hits
    tickN(w, idle, 120)
    expect(player.health!.hp).toBeLessThan(player.health!.max)
  })

  it('civilian flees when damaged', () => {
    const w = createWorld(7, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    player.combat!.weapon = 'fists'
    const civ = spawnNpc(w, 'civilian', 11.5, 1.5)
    player.facing = 0
    const attack = new Map([[0, { ...emptyInput(), attack: true }]])
    tickWorld(w, attack)
    expect(civ.ai!.mode).toBe('flee')
    const idle = new Map([[0, emptyInput()]])
    tickN(w, idle, 60)
    const dist = Math.hypot(civ.pos.x - player.pos.x, civ.pos.y - player.pos.y)
    expect(dist).toBeGreaterThan(2)
  })

  it('hurt player heals by walking over a bandage', () => {
    const w = createWorld(8, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    player.health!.hp = 40
    const drop = makeEntity('pickup', 'pickup.bandage', 11.5, 1.5, 0.3)
    drop.pickup = { itemId: 'bandage', qty: 1 }
    addEntity(w, drop)

    const right = new Map([[0, { ...emptyInput(), moveX: 1 }]])
    tickN(w, right, 20)
    expect(player.health!.hp).toBe(70)
    expect(w.byId.get(drop.id)).toBeUndefined()
  })

  it('populated world simulates 300 ticks without errors and stays deterministic-ish in count', () => {
    const w = createWorld(42, 1)
    populateWorld(w)
    spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
    const before = w.entities.length
    expect(before).toBeGreaterThan(10)
    const idle = new Map([[0, emptyInput()]])
    tickN(w, idle, 300)
    expect(w.tick).toBe(300)
    expect(w.entities.length).toBeGreaterThan(5)
  })
})
