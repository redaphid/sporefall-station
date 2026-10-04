// #86 — the alarm hears gunfire, and a raised alarm seals the way out.
//
// Every test loads an exact state through serialize/deserialize, runs the real
// systems (`runTicks` → `tickWorld`) and asserts on the world. The floor is the
// seed-1 floor-1 city with `hostile = false`, so crew and law stay calm and the
// only thing moving the alarm is what the test does. The player stands on the
// open street at y=1.5 aiming +x; witnesses stand behind it, out of the line of
// fire, so no bullet ever lands on one (that would be a crime, a different path).

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import type { InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import {
  ATTACK_SEEN_HEAT,
  HEAT_DECAY_EVERY,
  HEAT_PER_ALARM,
  LOCKDOWN_ALARM,
  LOCKDOWN_TICKS,
  exitSealed,
  hearGunfire,
  lockdownView,
} from './alarm'
import { applyDamage } from './combat'
import { WEAPONS } from '../data/items'
import { HEAR_RANGE } from './goals'
import { nextFloor, setupFloor } from './missions'
import { populateWorld } from '../populate'
import { commitCrime } from './relationships'

const PISTOL = WEAPONS.pistol.cooldownTicks
/** Tick 0 is a decay tick, so the first shot's heat reads one less. */
const ONE_SHOT = PISTOL - 1
const FIRE: Partial<InputCmd> = { attack: true, aimX: 1, aimY: 0 }
const IDLE: Partial<InputCmd> = {}
const fire = (w: World, n: number, slot = 0): World => runTicks(w, new Map([[slot, FIRE]]), n)
const idle = (w: World, n: number): World => runTicks(w, new Map([[0, IDLE]]), n)

/** Round-trip through JSON so every test starts from an exactly-set state. */
const reload = (w: World): World => deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))

/** Calm seed-1 floor 1, one player at (5.5, 1.5), optional witnesses. */
const stage = (witnesses: [archetype: string, x: number, y: number][] = [['civilian', 2.5, 0.5]]): World => {
  const w = createWorld(1, 1, 'normal', false)
  spawnPlayer(w, 0, 5.5, 1.5)
  for (const [a, x, y] of witnesses) spawnNpc(w, a, x, y)
  return reload(w)
}

const player = (w: World, slot = 0): Entity => w.entities.find((e) => e.playerCtl?.playerId === slot)!
const eventsOf = (w: World, type: string, ticks: number, input: Partial<InputCmd> = FIRE): unknown[] => {
  const seen: unknown[] = []
  for (let i = 0; i < ticks; i++) {
    runTicks(w, new Map([[0, input]]), 1)
    for (const e of w.events) if (e.type === type) seen.push(e)
  }
  return seen
}

describe('gunfire is a heard noise', () => {
  it('one stray shot near a witness is heat, never an alarm', () => {
    const w = fire(stage(), 1)
    expect(w.mission.heat).toBe(ONE_SHOT)
    expect(w.alarm).toBe(0)
    expect(w.noises).toHaveLength(1)
    expect(w.noises[0]).toMatchObject({ x: 5.5, y: 1.5 })
  })

  it('a lone shot bleeds off completely, and the field disappears (snapshot-stable)', () => {
    const w = fire(stage(), 1)
    idle(w, PISTOL * HEAT_DECAY_EVERY + HEAT_DECAY_EVERY)
    expect(w.mission.heat).toBeUndefined()
    expect('heat' in serializeWorld(w).mission).toBe(false)
  })

  it('a burst refreshes ONE noise instead of stacking one per shot', () => {
    const w = fire(stage(), 90) // 5 pistol shots from the same spot
    expect(w.noises).toHaveLength(1)
  })

  it('sustained fire raises the alarm one level per HEAT_PER_ALARM, announcing each step', () => {
    const w = stage()
    const raised = eventsOf(w, 'alarmRaised', 30 * 60)
    expect(raised).toEqual([
      { type: 'alarmRaised', level: 1, cause: 'gunfire' },
      { type: 'alarmRaised', level: 2, cause: 'gunfire' },
      { type: 'alarmRaised', level: 3, cause: 'gunfire' },
    ])
    expect(w.alarm).toBe(3)
    expect(w.mission.heat).toBeUndefined() // saturated at the top
  })

  it('pistol fire needs a real fight to raise the alarm: at least 12 s unbroken', () => {
    const w = stage()
    let t = 0
    while (w.alarm === 0 && t < 30 * 120) {
      fire(w, 1)
      t++
    }
    expect(w.alarm).toBe(1)
    expect(t).toBeGreaterThanOrEqual(12 * 30)
    expect(t).toBeLessThanOrEqual(13 * 30)
  })

  it('a shot every 3 s (a careful player) never accumulates', () => {
    const w = stage()
    for (let i = 0; i < 40; i++) {
      fire(w, 1)
      idle(w, 89)
    }
    expect(w.alarm).toBe(0)
    expect(w.mission.heat ?? 0).toBeLessThan(PISTOL)
  })

  it('melee is silent: no noise, no heat', () => {
    const w = stage()
    const p = player(w)
    p.combat!.weapon = 'fists'
    p.loadout!.inventory = []
    fire(w, 60)
    expect(w.noises).toHaveLength(0)
    expect(w.mission.heat).toBeUndefined()
  })

  it('the shot still lures: a calm cop in earshot goes to investigate it', () => {
    const w = stage([['cop', 2.5, 0.5]])
    const cop = w.entities.find((e) => e.archetype === 'cop')!
    fire(w, 1)
    idle(w, 12)
    expect(cop.ai!.goal).toBe('investigate')
  })

  it('hearing draws nothing from the world RNG', () => {
    const w = stage()
    const before = w.rng.state()
    hearGunfire(w, player(w), PISTOL)
    expect(w.rng.state()).toBe(before)
  })
})

describe('who counts as a witness (adversarial)', () => {
  const heatAfterShot = (witnesses: [string, number, number][], mutate?: (w: World) => void): number | undefined => {
    const w = stage(witnesses)
    mutate?.(w)
    return fire(w, 1).mission.heat
  }

  it('an empty floor hears nothing, but the noise is still there to lure', () => {
    const w = fire(stage([]), 1)
    expect(w.mission.heat).toBeUndefined()
    expect(w.noises).toHaveLength(1)
  })

  it('gangs and vermin do not call it in', () => {
    expect(heatAfterShot([['thug', 2.5, 0.5], ['sporeling', 3.5, 0.5]])).toBeUndefined()
  })

  it('HEAR_RANGE is the edge: just inside counts, just outside does not', () => {
    expect(heatAfterShot([['civilian', 5.5 + HEAR_RANGE - 0.5, 0.5]])).toBe(ONE_SHOT)
    expect(heatAfterShot([['civilian', 5.5 - HEAR_RANGE - 0.6, 1.5]])).toBeUndefined()
  })

  it('a sleeping, dormant, or dead witness hears nothing', () => {
    const civ = (w: World): Entity => w.entities.find((e) => e.archetype === 'civilian')!
    expect(heatAfterShot([['civilian', 2.5, 0.5]], (w) => void (civ(w).status = { stun: 0, sleep: 999, hitFlashUntil: 0, cloakUntil: 0 }))).toBeUndefined()
    expect(heatAfterShot([['civilian', 2.5, 0.5]], (w) => void (civ(w).ai!.dormant = true))).toBeUndefined()
    expect(heatAfterShot([['civilian', 2.5, 0.5]], (w) => void (civ(w).dead = true))).toBeUndefined()
  })

  it('a crowd of witnesses is one ear: heat per shot, not per listener', () => {
    const crowd: [string, number, number][] = [0, 1, 2, 3, 4].map((i) => ['civilian', 1.5 + i * 0.5, 0.5])
    expect(heatAfterShot(crowd)).toBe(ONE_SHOT)
  })

  it('a downed player cannot fire, so makes no noise', () => {
    const w = stage()
    player(w).playerCtl!.downed = { until: w.tick + 9999 } as never
    fire(w, 60)
    expect(w.mission.heat).toBeUndefined()
    expect(w.noises).toHaveLength(0)
  })
})

describe('an attack on a player, seen', () => {
  it('a thug landing a hit in view of a civilian adds ATTACK_SEEN_HEAT', () => {
    const w = stage([['civilian', 2.5, 0.5], ['thug', 7.5, 1.5]])
    const thug = w.entities.find((e) => e.archetype === 'thug')!
    player(w).health!.iframes = 0 // past the spawn grace
    expect(applyDamage(w, player(w), 5, thug.pos.x, thug.pos.y, 0, thug.id)).not.toBeNull()
    expect(w.mission.heat).toBe(ATTACK_SEEN_HEAT)
  })

  it('the law beating on you is not news', () => {
    const w = stage([['civilian', 2.5, 0.5], ['cop', 7.5, 1.5]])
    const cop = w.entities.find((e) => e.archetype === 'cop')!
    applyDamage(w, player(w), 5, cop.pos.x, cop.pos.y, 0, cop.id)
    expect(w.mission.heat).toBeUndefined()
  })

  it('nobody in sight → nothing (the only witness is behind a wall)', () => {
    // (4.5, 5.5) is inside the building south of the street, walled off.
    const w = stage([['civilian', 4.5, 5.5], ['thug', 7.5, 1.5]])
    const thug = w.entities.find((e) => e.archetype === 'thug')!
    applyDamage(w, player(w), 5, thug.pos.x, thug.pos.y, 0, thug.id)
    expect(w.mission.heat).toBeUndefined()
  })
})

describe('lockdown: a raised alarm seals the Launch Bay', () => {
  /** Stage the player on the (unlocked) exit tile of a `reach` floor. */
  const onExit = (w: World, slot = 0): void => {
    const p = player(w, slot)
    p.pos.x = w.level.exit.x + 0.5
    p.pos.y = w.level.exit.y + 0.5
    p.prevPos.x = p.pos.x
    p.prevPos.y = p.pos.y
  }

  it('the alarm reaching LOCKDOWN_ALARM latches the lockdown and announces it', () => {
    const w = stage()
    w.alarm = LOCKDOWN_ALARM - 1
    w.mission.heat = HEAT_PER_ALARM - 1
    const seen = eventsOf(reload(w), 'lockdown', 1)
    expect(seen).toEqual([{ type: 'lockdown' }])
  })

  it('a sealed bay holds a player standing on it, then lets them out exactly on time', () => {
    const w = stage()
    w.alarm = LOCKDOWN_ALARM
    idle(w, 1)
    const at = w.mission.lockdownTick!
    expect(at).toBe(w.tick - 1)
    onExit(w)
    const w2 = reload(w)
    // One tick before the cycle ends: still floor 1.
    idle(w2, at + LOCKDOWN_TICKS - w2.tick - 1)
    expect(exitSealed(w2)).toBe(true)
    expect(eventsOf(w2, 'lockdownLifted', 1, IDLE)).toEqual([]) // the last sealed tick
    expect(w2.floor).toBe(1)
    expect(eventsOf(w2, 'lockdownLifted', 1, IDLE)).toEqual([{ type: 'lockdownLifted' }])
    expect(w2.floor).toBe(2) // out on the very tick it lifts
  })

  it('the HUD view counts whole seconds down, and is gone once lifted', () => {
    const w = stage()
    w.alarm = LOCKDOWN_ALARM
    idle(w, 1)
    expect(lockdownView(w)).toEqual({ secondsLeft: LOCKDOWN_TICKS / 30 })
    idle(w, LOCKDOWN_TICKS)
    expect(lockdownView(w)).toBeUndefined()
  })

  it('the crime path counts too: shooting a cop in front of the law can seal the bay', () => {
    const w = stage([['cop', 2.5, 0.5], ['cop', 3.5, 0.5], ['cop', 2.5, 2.5], ['cop', 7.5, 1.5]])
    const victim = w.entities.filter((e) => e.archetype === 'cop')[3]
    commitCrime(w, victim, player(w))
    expect(w.alarm).toBe(3)
    idle(w, 1)
    expect(w.mission.lockdownTick).toBeDefined()
  })

  it('co-op: one noisy teammate seals it for both, and the seal still lifts on its own', () => {
    const w0 = createWorld(1, 1, 'normal', false)
    spawnPlayer(w0, 0, 5.5, 1.5)
    spawnPlayer(w0, 1, 5.5, 2.5)
    spawnNpc(w0, 'civilian', 2.5, 0.5)
    const w = reload(w0)
    w.alarm = LOCKDOWN_ALARM - 1
    w.mission.heat = HEAT_PER_ALARM - PISTOL
    runTicks(w, new Map([[0, IDLE], [1, FIRE]]), 1) // the teammate pulls the trigger
    idle(w, 1)
    expect(w.mission.lockdownTick).toBeDefined()
    onExit(w, 0)
    runTicks(w, new Map([[0, IDLE], [1, FIRE]]), LOCKDOWN_TICKS - 5)
    expect(w.floor).toBe(1)
    runTicks(w, new Map([[0, IDLE], [1, IDLE]]), 10)
    expect(w.floor).toBe(2) // nothing the noisy one does can hold the bay forever
  })

  it('a late joiner mid-lockdown neither resets nor extends it', () => {
    const w = stage()
    w.alarm = LOCKDOWN_ALARM
    idle(w, 1)
    const at = w.mission.lockdownTick
    idle(w, 100)
    spawnPlayer(w, 1, 5.5, 2.5)
    runTicks(w, new Map([[0, IDLE], [1, IDLE]]), 5)
    expect(w.mission.lockdownTick).toBe(at)
  })

  it('a dead party does not break it: the seal is a pure timer', () => {
    const w = stage()
    w.alarm = LOCKDOWN_ALARM
    idle(w, 1)
    player(w).dead = true
    idle(w, LOCKDOWN_TICKS)
    expect(exitSealed(w)).toBe(false)
  })

  it('a new floor starts calm: heat, alarm and lockdown all reset', () => {
    const w = stage()
    w.alarm = LOCKDOWN_ALARM
    w.mission.heat = 7
    idle(w, 1)
    nextFloor(w)
    expect(w.alarm).toBe(0)
    expect(w.mission.heat).toBeUndefined()
    expect(w.mission.lockdownTick).toBeUndefined()
  })

  it('a mid-lockdown, mid-heat snapshot replays byte-identically', () => {
    const w = stage()
    w.alarm = 2
    fire(w, 400)
    const copy = reload(w)
    for (let i = 0; i < 300; i++) {
      tickWorld(w, new Map([[0, { attack: i % 3 === 0, aimX: 1, aimY: 0, moveX: 0, moveY: 0 } as InputCmd]]))
      tickWorld(copy, new Map([[0, { attack: i % 3 === 0, aimX: 1, aimY: 0, moveX: 0, moveY: 0 } as InputCmd]]))
    }
    expectWorldEqual(copy, w)
  })
})

describe('balance guard on real floors (the full table: scripts/test/alarm-sweep.mts)', () => {
  it('seeds 1..20, floor 1: one stray shot from the spawn never raises the alarm or locks the floor', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const w0 = createWorld(seed, 1)
      populateWorld(w0)
      setupFloor(w0)
      spawnPlayer(w0, 0, w0.level.spawn.x, w0.level.spawn.y)
      const w = reload(w0)
      const p = player(w)
      for (let t = 0; t < 300; t++) {
        p.health!.iframes = Math.max(p.health!.iframes, 2) // measure noise, not survival
        runTicks(w, new Map([[0, t === 0 ? FIRE : IDLE]]), 1)
      }
      expect(w.alarm, `seed ${seed}`).toBe(0)
      expect(w.mission.heat, `seed ${seed}`).toBeUndefined()
      expect(w.mission.lockdownTick, `seed ${seed}`).toBeUndefined()
    }
  })
})

describe('the heist finale maxes the alarm without a lockdown', () => {
  const heist = (): World => {
    for (let seed = 1; seed <= 200; seed++) {
      const w = createWorld(seed, 1)
      populateWorld(w)
      setupFloor(w)
      if (w.mission.template !== 'steal' || w.mission.objectiveDoorId === undefined) continue
      spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
      return reload(w)
    }
    throw new Error('no steal floor')
  }

  it('picking the objective gate (alarm → 3) is the heist working, not noise: no lockdown', () => {
    const w = heist()
    const gate = w.byId.get(w.mission.objectiveDoorId!)!
    gate.door!.locked = false
    gate.door!.open = true
    idle(w, 2)
    expect(w.alarm).toBe(3)
    expect(w.mission.lockdownTick).toBeUndefined()
  })

  it('taking the prize (station alert) raises no lockdown on a quiet run', () => {
    const w = heist()
    player(w).loadout!.inventory.push({ itemId: 'briefcase', qty: 1 })
    idle(w, 2)
    expect(w.mission.complete).toBe(true)
    expect(w.mission.lockdownTick).toBeUndefined()
    expect(exitSealed(w)).toBe(false)
  })

  it('a LOUD run: the seal cycle restarts when the prize is taken', () => {
    const w = heist()
    w.alarm = LOCKDOWN_ALARM
    idle(w, 1)
    const latched = w.mission.lockdownTick!
    idle(w, LOCKDOWN_TICKS + 50) // long past the first cycle
    expect(exitSealed(w)).toBe(false)
    expect(lockdownView(w)).toEqual({}) // still shown: it waits on the objective
    player(w).loadout!.inventory.push({ itemId: 'briefcase', qty: 1 })
    idle(w, 1)
    expect(w.mission.complete).toBe(true)
    expect(w.mission.lockdownTick).toBeGreaterThan(latched)
    expect(exitSealed(w)).toBe(true)
    expect(lockdownView(w)!.secondsLeft).toBe(LOCKDOWN_TICKS / 30)
  })
})
