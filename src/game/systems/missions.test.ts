import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { populateWorld, spawnNpc } from '../populate'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { missionSystem, setupFloor } from './missions'

const makeRun = (seed: number): { w: World; playerId: number } => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
  return { w, playerId: 0 }
}

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

describe('roguelite loop', () => {
  it('generates a mission with a target and locked doors on the target building', () => {
    const { w } = makeRun(11)
    expect(w.mission.template).toMatch(/steal|assassinate/)
    expect(w.mission.complete).toBe(false)
    expect(w.mission.exitUnlocked).toBe(false)
    expect(w.mission.targetBuilding).toBeGreaterThanOrEqual(0)
    const doors = w.entities.filter((e) => e.door)
    expect(doors.length).toBeGreaterThan(4)
    const locked = doors.filter((e) => e.door!.locked)
    expect(locked.length).toBeGreaterThanOrEqual(1)
  })

  it('steal mission completes when a player holds the briefcase, unlocking the exit', () => {
    for (let seed = 1; seed < 30; seed++) {
      const { w } = makeRun(seed)
      if (w.mission.template !== 'steal') continue
      const player = w.entities.find((e) => e.playerCtl)!
      player.playerCtl!.inventory.push({ itemId: 'briefcase', qty: 1 })
      missionSystem(w)
      expect(w.mission.complete).toBe(true)
      expect(w.mission.exitUnlocked).toBe(true)
      return
    }
    throw new Error('no steal mission found in 30 seeds')
  })

  it('assassinate mission completes when the boss dies', () => {
    for (let seed = 1; seed < 30; seed++) {
      const { w } = makeRun(seed)
      if (w.mission.template !== 'assassinate') continue
      const boss = w.byId.get(w.mission.targetEntityId!)!
      boss.dead = true
      missionSystem(w)
      expect(w.mission.complete).toBe(true)
      return
    }
    throw new Error('no assassinate mission found in 30 seeds')
  })

  it('standing on the unlocked exit advances the floor, keeping players and healing them', () => {
    const { w } = makeRun(12)
    const player = w.entities.find((e) => e.playerCtl)!
    player.health!.hp = 10
    w.mission.complete = true
    w.mission.exitUnlocked = true
    player.pos.x = w.level.exit.x + 0.5
    player.pos.y = w.level.exit.y + 0.5
    const npcCountBefore = w.entities.filter((e) => e.ai).length
    tickWorld(w, idle())
    expect(w.floor).toBe(2)
    expect(w.entities).toContain(player)
    expect(player.health!.hp).toBeGreaterThanOrEqual(50)
    expect(player.pos.x).toBeCloseTo(w.level.spawn.x)
    expect(w.entities.filter((e) => e.ai).length).toBeGreaterThan(0)
    expect(npcCountBefore).toBeGreaterThan(0)
    expect(w.mission.description.length).toBeGreaterThan(0)
  })

  it('attacking a civilian in front of a cop raises the alarm and the cop aggros', () => {
    const w = createWorld(13, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    player.combat!.weapon = 'fists'
    const civ = spawnNpc(w, 'civilian', 11.5, 1.5)
    const cop = spawnNpc(w, 'cop', 13.5, 1.5) // sees the crime
    player.facing = 0
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    expect(player.playerCtl!.crimeUntilTick).toBeGreaterThan(w.tick)
    expect(w.alarm).toBeGreaterThanOrEqual(1)
    expect(civ.ai!.mode).toBe('flee')
    // Cop should aggro within a couple of think cycles
    for (let i = 0; i < 30 && cop.ai!.mode !== 'aggro'; i++) tickWorld(w, idle())
    expect(cop.ai!.mode).toBe('aggro')
  })

  it('fully set-up worlds (mission + doors + boss) survive 300 ticks across seeds', () => {
    // Regression: the assassinate boss archetype must exist in NPCS — a
    // missing def crashed the AI system only in fully-set-up worlds.
    for (let seed = 1; seed <= 12; seed++) {
      const { w } = makeRun(seed)
      const inputs = idle()
      for (let i = 0; i < 300; i++) tickWorld(w, inputs)
      expect(w.tick).toBe(300)
    }
  })

  it('solo out-of-lives player going down triggers run over (a real death, not a grace-down)', () => {
    const w = createWorld(14, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    player.health!.hp = 1
    w.revivesLeft = 0 // comeback economy already spent this run
    const thug = spawnNpc(w, 'thug', 11.2, 1.5)
    thug.combat!.cooldown = 0
    for (let i = 0; i < 120 && !w.gameOver; i++) tickWorld(w, idle())
    expect(w.gameOver).toBe(true)
    expect(player.dead).toBe(true)
  })

  it('solo player WITH lives left goes down but the run continues (self-revive, no game-over)', () => {
    const w = createWorld(14, 1)
    const player = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    player.health!.hp = 1
    const thug = spawnNpc(w, 'thug', 11.2, 1.5)
    thug.combat!.cooldown = 0
    for (let i = 0; i < 120 && !player.playerCtl!.downed; i++) tickWorld(w, idle())
    expect(player.playerCtl!.downed).toBeDefined()
    expect(w.gameOver).toBe(false) // lone downed player is recovering, not lost
  })

  it('teammate proximity revives a downed player', () => {
    const w = createWorld(15, 1)
    const downed = spawnPlayer(w, 0, 'soldier', 10.5, 1.5)
    spawnPlayer(w, 1, 'soldier', 10.9, 1.5)
    downed.health!.hp = 0
    downed.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    const inputs = new Map([
      [0, emptyInput()],
      [1, emptyInput()],
    ])
    for (let i = 0; i < 120 && downed.playerCtl!.downed; i++) tickWorld(w, inputs)
    expect(downed.playerCtl!.downed).toBeUndefined()
    expect(downed.health!.hp).toBeGreaterThan(0)
  })
})
