import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type Faction } from '../entity'
import { addEntity, createWorld, emitNoise, type World } from '../world'
import { arbitrateGoal } from './behaviors'
import { WANDER, BATTLE, PURSUE, FLEE, INVESTIGATE } from './goalCodes'

const ARCH: Record<Faction, string> = { warden: 'warden', feral: 'acolyte', neutral: 'lockkeeper', civ: 'civilian' }

const npc = (w: World, faction: Faction, x: number, y: number, hp = 40, max = 40): Entity => {
  const e = addEntity(w, makeEntity('npc', ARCH[faction], x, y))
  e.health = { hp, max, iframes: 0 }
  e.combat = { weapon: 'bat', cooldown: 0 }
  e.ai = { mode: 'idle', faction, home: { x, y }, thinkAt: 0, sightRange: 8 }
  return e
}

const player = (w: World, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, misdeedUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

describe('goal arbitration', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a healthy hostile NPC chooses to battle a visible target', () => {
    const p = player(w, 20, 20)
    const mutant = npc(w, 'feral', 22, 20, 40, 40)
    const goal = arbitrateGoal(w, mutant)
    expect(goal.code).toBe(BATTLE)
    expect(goal.target).toBe(p.id)
  })

  it('a badly wounded hostile NPC flees instead of fighting', () => {
    const p = player(w, 20, 20)
    const mutant = npc(w, 'feral', 22, 20, 5, 40)
    const goal = arbitrateGoal(w, mutant)
    expect(goal.code).toBe(FLEE)
    expect(goal.target).toBe(p.id)
  })

  it('crosses from battle to flee around a third of max health', () => {
    player(w, 20, 20)
    const healthy = npc(w, 'feral', 22, 20, 20, 40) // > max/3 -> fight
    const hurt = npc(w, 'feral', 22, 20, 8, 40) // < max/3 -> flee
    expect(arbitrateGoal(w, healthy).code).toBe(BATTLE)
    expect(arbitrateGoal(w, hurt).code).toBe(FLEE)
  })

  it('picks the more-hated of two hostile targets', () => {
    const p1 = player(w, 21, 20)
    const p2 = player(w, 19, 20)
    const mutant = npc(w, 'feral', 20, 20, 40, 40)
    mutant.ai!.rel = {
      [p1.id]: { hate: 5, code: 'Hostile' },
      [p2.id]: { hate: 40, code: 'Hostile' },
    }
    expect(arbitrateGoal(w, mutant).target).toBe(p2.id)
  })

  it('an idle NPC with no threat investigates a nearby noise', () => {
    npc(w, 'neutral', 20, 20)
    emitNoise(w, 25, 20)
    const lockkeeper = w.entities.find((e) => e.ai)!
    const goal = arbitrateGoal(w, lockkeeper)
    expect(goal.code).toBe(INVESTIGATE)
    expect(goal.at).toEqual({ x: 25, y: 20 })
  })

  it('wanders when nothing threatens and nothing is heard', () => {
    const lockkeeper = npc(w, 'neutral', 20, 20)
    expect(arbitrateGoal(w, lockkeeper).code).toBe(WANDER)
  })

  it('pursues a remembered target that has moved out of sight', () => {
    const p = player(w, 32, 20) // 12 tiles away: beyond sightRange 8, within leash
    const mutant = npc(w, 'feral', 20, 20, 40, 40)
    mutant.ai!.targetId = p.id
    mutant.ai!.lastKnownTargetPos = { x: 24, y: 20 }
    expect(arbitrateGoal(w, mutant).code).toBe(PURSUE)
  })
})
