import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { populateWorld } from '../populate'
import { createWorld, type World } from '../world'
import { missionSystem, nextFloor, setupFloor } from './missions'

const makeRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
  return w
}

const firstOf = (seed: number, template: 'steal' | 'assassinate', limit = 60): World => {
  for (let s = seed; s < seed + limit; s++) {
    const w = makeRun(s)
    if (w.mission.template === template) return w
  }
  throw new Error(`no ${template} mission found across ${limit} seeds from ${seed}`)
}

const onExit = (w: World, playerId: number): void => {
  const p = w.entities.find((e) => e.playerCtl?.playerId === playerId)!
  p.pos.x = w.level.exit.x + 0.5
  p.pos.y = w.level.exit.y + 0.5
}

describe('mission completion edges', () => {
  it('steal completes the moment any player holds the briefcase, unlocking the exit', () => {
    const w = firstOf(1, 'steal')
    const p = w.entities.find((e) => e.playerCtl)!
    expect(w.mission.exitUnlocked).toBe(false)
    p.playerCtl!.inventory.push({ itemId: 'briefcase', qty: 1 })
    missionSystem(w)
    expect(w.mission.complete).toBe(true)
    expect(w.mission.exitUnlocked).toBe(true)
    expect(w.events.some((e) => e.type === 'missionComplete')).toBe(true)
  })

  it('assassinate completes when the target dies by ANY cause (dead flag), not only a player kill', () => {
    const w = firstOf(1, 'assassinate')
    const boss = w.byId.get(w.mission.targetEntityId!)!
    boss.dead = true // e.g. burned to death, caught in a barrel blast
    missionSystem(w)
    expect(w.mission.complete).toBe(true)
    expect(w.mission.exitUnlocked).toBe(true)
  })

  it('assassinate also completes if the target entity vanishes entirely (swept from byId)', () => {
    const w = firstOf(1, 'assassinate')
    w.byId.delete(w.mission.targetEntityId!) // no longer resolvable
    missionSystem(w)
    expect(w.mission.complete).toBe(true)
  })

  it('completing is idempotent — a second pass does not re-emit missionComplete', () => {
    const w = firstOf(1, 'steal')
    const p = w.entities.find((e) => e.playerCtl)!
    p.playerCtl!.inventory.push({ itemId: 'briefcase', qty: 1 })
    missionSystem(w)
    w.events.length = 0
    missionSystem(w)
    expect(w.events.some((e) => e.type === 'missionComplete')).toBe(false)
  })
})

describe('exit gating', () => {
  it('standing on the exit does nothing while it is still locked', () => {
    const w = firstOf(1, 'steal')
    onExit(w, 0)
    missionSystem(w)
    expect(w.floor).toBe(1)
    expect(w.events.some((e) => e.type === 'floorChange')).toBe(false)
  })

  it('an unlocked exit advances the floor when a live player stands on it', () => {
    const w = makeRun(12)
    w.mission.complete = true
    w.mission.exitUnlocked = true
    onExit(w, 0)
    missionSystem(w)
    expect(w.floor).toBe(2)
  })

  it('a DOWNED player parked on the exit cannot advance the floor', () => {
    const w = makeRun(12)
    w.mission.exitUnlocked = true
    const p = w.entities.find((e) => e.playerCtl)!
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    onExit(w, 0)
    missionSystem(w)
    expect(w.floor).toBe(1)
  })

  it('with two players, either one on the exit is enough to descend', () => {
    const w = makeRun(12)
    spawnPlayer(w, 1, 'soldier', w.level.spawn.x, w.level.spawn.y)
    w.mission.exitUnlocked = true
    onExit(w, 1) // the second player reaches it
    missionSystem(w)
    expect(w.floor).toBe(2)
  })
})

describe('nextFloor carry-over', () => {
  it('carries players to floor 2 spawn, heals to at least half, and repopulates', () => {
    const w = makeRun(12)
    const p = w.entities.find((e) => e.playerCtl)!
    p.health!.hp = 5
    nextFloor(w)
    expect(w.floor).toBe(2)
    expect(w.entities).toContain(p)
    expect(p.health!.hp).toBeGreaterThanOrEqual(Math.floor(p.health!.max / 2))
    expect(p.pos.x).toBeCloseTo(w.level.spawn.x)
    expect(p.pos.y).toBeCloseTo(w.level.spawn.y)
    expect(w.entities.filter((e) => e.ai).length).toBeGreaterThan(0)
  })

  it('a high-hp player is NOT nerfed to half — the heal is a floor, not a set', () => {
    const w = makeRun(12)
    const p = w.entities.find((e) => e.playerCtl)!
    p.health!.hp = p.health!.max
    nextFloor(w)
    expect(p.health!.hp).toBe(p.health!.max)
  })

  it('the briefcase (key item) does not survive the floor transition, other items do', () => {
    const w = makeRun(12)
    const p = w.entities.find((e) => e.playerCtl)!
    p.playerCtl!.inventory.push({ itemId: 'briefcase', qty: 1 })
    p.playerCtl!.inventory.push({ itemId: 'bat', qty: 16 })
    nextFloor(w)
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'briefcase')).toBe(false)
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'bat')).toBe(true)
  })

  it('descending CLEARS a downed state and its channel/crime bookkeeping (a downed teammate is carried alive)', () => {
    const w = makeRun(12)
    const p = w.entities.find((e) => e.playerCtl)!
    p.playerCtl!.downed = { bleedTicks: 100, reviveProgress: 0 }
    p.playerCtl!.channel = { kind: 'lockpick', targetId: 999, ticksLeft: 10 }
    p.playerCtl!.crimeUntilTick = w.tick + 500
    p.dead = false
    nextFloor(w)
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(p.playerCtl!.crimeUntilTick).toBe(0)
    expect(p.health!.hp).toBeGreaterThan(0) // downed (hp 0) → healed to half
  })

  it('a fresh mission is generated for the new floor (not the completed one)', () => {
    const w = makeRun(12)
    w.mission.complete = true
    w.mission.exitUnlocked = true
    nextFloor(w)
    expect(w.mission.template).toMatch(/steal|assassinate|reach/)
    // A steal/assassinate mission on the new floor starts incomplete again.
    if (w.mission.template !== 'reach') expect(w.mission.complete).toBe(false)
  })
})

describe('run-over vs the mission system guard', () => {
  it('once gameOver is set, missionSystem is a complete no-op (mission progress frozen)', () => {
    const w = firstOf(1, 'steal')
    w.gameOver = true
    const p = w.entities.find((e) => e.playerCtl)!
    p.playerCtl!.inventory.push({ itemId: 'briefcase', qty: 1 })
    missionSystem(w)
    expect(w.mission.complete).toBe(false) // never processed under the guard
  })
})
