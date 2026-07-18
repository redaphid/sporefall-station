import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const tickN = (w: World, inputs: Map<number, InputCmd>, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, inputs)
}

describe('new NPC archetypes', () => {
  it('gangster shoots at a visible player from range', () => {
    const w = createWorld(30, 1)
    const player = spawnPlayer(w, 0, 10.5, 1.5)
    spawnNpc(w, 'gangster', 16.5, 1.5) // within 0.8 * pistol range 10
    tickN(w, idle(), 90)
    // Projectiles were fired and some connected
    expect(player.health!.hp).toBeLessThan(player.health!.max)
  })

  it('bouncer ignores bystanders but retaliates when hit', () => {
    const w = createWorld(31, 1)
    const player = spawnPlayer(w, 0, 10.5, 1.5)
    player.combat!.weapon = 'fists'
    const bouncer = spawnNpc(w, 'bouncer', 11.5, 1.5)
    bouncer.ai!.thinkAt = 100000 // stand still so the punch below actually lands
    // Peaceful at first
    tickN(w, idle(), 30)
    expect(bouncer.ai!.mode).not.toBe('aggro')
    // One punch changes that
    player.facing = 0
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    expect(bouncer.ai!.mode).toBe('aggro')
    expect(bouncer.ai!.targetId).toBe(player.id)
  })

  it('NPC hp scales with floor', () => {
    const w1 = createWorld(32, 1)
    const w3 = createWorld(32, 3)
    const a = spawnNpc(w1, 'thug', 10.5, 1.5)
    const b = spawnNpc(w3, 'thug', 10.5, 1.5)
    expect(b.health!.max).toBeGreaterThan(a.health!.max)
  })
})
