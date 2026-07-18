import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { CLASSES } from './classes'

const special = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), special: true }]])
const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const tickN = (w: World, inputs: Map<number, InputCmd>, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, inputs)
}

describe('classes', () => {
  it('soldier is the ONLY playable class', () => {
    expect(Object.keys(CLASSES)).toEqual(['soldier'])
  })

  it('soldier defines coherent stats', () => {
    const cls = CLASSES.soldier
    expect(cls.id).toBe('soldier')
    expect(cls.hp).toBeGreaterThan(0)
    expect(cls.speed).toBeGreaterThan(0)
    expect(cls.abilityCooldownTicks).toBeGreaterThan(0)
    expect(cls.startWeapon).toBe('pistol')
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

  it('removed class ids (thief/doctor/hacker) fall back to soldier at spawn', () => {
    for (const legacy of ['thief', 'doctor', 'hacker', 'nonsense']) {
      const w = createWorld(21, 1)
      const p = spawnPlayer(w, 0, legacy, 10.5, 1.5)
      expect(p.playerCtl!.classId).toBe('soldier')
      expect(p.health!.max).toBe(CLASSES.soldier.hp)
      expect(p.combat!.weapon).toBe('pistol')
    }
  })
})
