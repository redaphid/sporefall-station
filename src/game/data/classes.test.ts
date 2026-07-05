import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { makeEntity } from '../entity'
import { addEntity } from '../world'
import { CLASSES } from './classes'

const special = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), special: true }]])
const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const tickN = (w: World, inputs: Map<number, InputCmd>, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, inputs)
}

describe('classes', () => {
  it('all classes define coherent stats', () => {
    for (const cls of Object.values(CLASSES)) {
      expect(cls.hp).toBeGreaterThan(0)
      expect(cls.speed).toBeGreaterThan(0)
      expect(cls.abilityCooldownTicks).toBeGreaterThan(0)
    }
  })

  it('soldier grenade explodes and damages a group', () => {
    const w = createWorld(20, 1)
    const p = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    p.facing = 0
    const a = spawnNpc(w, 'thug', 14.5, 1.5)
    const b = spawnNpc(w, 'thug', 15.2, 1.5)
    tickWorld(w, special())
    expect(p.playerCtl!.abilityCooldown).toBeGreaterThan(0)
    tickN(w, idle(), 40) // fuse burns, boom
    expect(a.health!.hp).toBeLessThan(a.health!.max)
    expect(b.health!.hp).toBeLessThan(b.health!.max)
  })

  it('thief cloak halves NPC sight and lands triple backstabs', () => {
    const w = createWorld(21, 1)
    const p = spawnPlayer(w, 0, 'thief', 10.5, 1.5)
    const thug = spawnNpc(w, 'thug', 15.5, 1.5) // dist 5 < sight 7, but > 3.5 cloaked
    thug.facing = 0 // facing away from the thief
    thug.ai!.thinkAt = 3 // don't let it spot the thief before the cloak activates
    tickWorld(w, special())
    expect(p.status!.cloakUntil).toBeGreaterThan(w.tick)
    // Cloaked at distance 5: thug should NOT aggro
    tickN(w, idle(), 12)
    expect(thug.ai!.mode).not.toBe('aggro')
    // Sneak up behind and knife: expect a 3x backstab (knife 12 → 36)
    p.pos.x = thug.pos.x - 1
    p.pos.y = thug.pos.y
    p.facing = 0
    const before = thug.health!.hp
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    expect(before - thug.health!.hp).toBe(36)
  })

  it('doctor chloroform puts an adjacent NPC to sleep without a crime flag', () => {
    const w = createWorld(22, 1)
    const p = spawnPlayer(w, 0, 'doctor', 10.5, 1.5)
    const civ = spawnNpc(w, 'civilian', 11.3, 1.5)
    tickWorld(w, special())
    expect(civ.status!.sleep).toBeGreaterThan(0)
    expect(p.playerCtl!.crimeUntilTick).toBe(0)
    // Sleeper doesn't move
    const x0 = civ.pos.x
    tickN(w, idle(), 30)
    expect(civ.pos.x).toBeCloseTo(x0, 1)
  })

  it('hacker short-out unlocks a locked door through line of sight', () => {
    const w = createWorld(23, 1)
    spawnPlayer(w, 0, 'hacker', 10.5, 1.5)
    const door = makeEntity('door', 'door', 13.5, 1.5, 0.5)
    door.door = { open: false, locked: true, lockLevel: 2 }
    door.interact = { verb: 'open', range: 1.3 }
    addEntity(w, door)
    tickWorld(w, special())
    expect(door.door.locked).toBe(false)
    expect(door.door.open).toBe(true)
  })

  it('thief pops lockLevel-1 locks instantly via interact', () => {
    const w = createWorld(24, 1)
    spawnPlayer(w, 0, 'thief', 10.5, 1.5)
    const door = makeEntity('door', 'door', 11.5, 1.5, 0.5)
    door.door = { open: false, locked: true, lockLevel: 1 }
    door.interact = { verb: 'open', range: 1.3 }
    addEntity(w, door)
    tickWorld(w, new Map([[0, { ...emptyInput(), interact: true }]]))
    expect(door.door.locked).toBe(false)
    expect(door.door.open).toBe(true)
  })
})
