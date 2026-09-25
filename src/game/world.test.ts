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
    const player = spawnPlayer(w, 0, 10.5, 1.5)
    player.combat!.weapon = 'fists' // pin melee — the player starts with a pistol
    const thug = spawnNpc(w, 'thug', 11.5, 1.5)
    player.facing = 0 // facing +x, toward the thug

    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    expect(thug.health!.hp).toBeLessThan(thug.health!.max)

    // A wounded thug now flees (goal arbitration) — chase it down while swinging.
    for (let i = 0; i < 300 && w.byId.get(thug.id); i++) {
      const cur = w.byId.get(thug.id)!
      const dx = cur.pos.x - player.pos.x
      const dy = cur.pos.y - player.pos.y
      const chase = { ...emptyInput(), attack: true, moveX: Math.sign(dx), moveY: Math.sign(dy) }
      tickWorld(w, new Map([[0, chase]]))
    }
    expect(w.byId.get(thug.id)).toBeUndefined() // dead and swept
  })

  it('thug aggros a visible player and closes distance', () => {
    const w = createWorld(6, 1)
    const player = spawnPlayer(w, 0, 10.5, 1.5)
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
    const player = spawnPlayer(w, 0, 10.5, 1.5)
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

  // Was 'hurt player heals by walking over a bandage'. The item cull removed
  // every healing item, so nothing on the floor heals any more — but what this
  // covered end to end was the SIM INTEGRATION (move → interaction → the pickup
  // leaves the world and lands in the loadout), not the heal specifically. It is
  // re-pointed at the grenade so that chain stays under test through tickWorld.
  it('player picks up a floor item by walking over it', () => {
    const w = createWorld(8, 1)
    const player = spawnPlayer(w, 0, 10.5, 1.5)
    const drop = makeEntity('pickup', 'pickup.grenade', 11.5, 1.5, 0.3)
    drop.pickup = { itemId: 'grenade', qty: 1 }
    addEntity(w, drop)

    const right = new Map([[0, { ...emptyInput(), moveX: 1 }]])
    tickN(w, right, 20)
    expect(player.loadout!.inventory.some((s) => s.itemId === 'grenade')).toBe(true)
    expect(w.byId.get(drop.id)).toBeUndefined()
  })

  it('populated world simulates 300 ticks without errors and stays deterministic-ish in count', () => {
    const w = createWorld(42, 1)
    populateWorld(w)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    const before = w.entities.length
    expect(before).toBeGreaterThan(10)
    const idle = new Map([[0, emptyInput()]])
    tickN(w, idle, 300)
    expect(w.tick).toBe(300)
    expect(w.entities.length).toBeGreaterThan(5)
  })
})
