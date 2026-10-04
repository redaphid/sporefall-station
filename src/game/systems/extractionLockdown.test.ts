// #85 extraction x #86 lockdown: a loud run's lockdown seals the way out, which
// on an extraction floor is the entry. The seal cycle restarts at the grab (the
// extraction's "objective"), and the carrier cannot leave until it lifts.

import { describe, expect, it } from 'vitest'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, type World } from '../world'
import { runTicks } from '../testkit'
import type { Entity } from '../entity'
import { setupFloor } from './missions'
import { exitSealed, lockdownView, LOCKDOWN_TICKS } from './alarm'

const boot = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return w
}
const extractionSeed = (() => {
  for (let seed = 1; seed < 200; seed++) {
    const w = createWorld(seed, 2)
    populateWorld(w)
    setupFloor(w)
    if (w.mission.template === 'extraction') return seed
  }
  throw new Error('no extraction seed')
})()
const idle = (): Map<number, Partial<InputCmd>> => new Map([[0, emptyInput()]])
const player = (w: World): Entity => w.entities.find((e) => e.playerCtl)!
const place = (e: Entity, x: number, y: number): void => {
  e.pos.x = e.prevPos.x = x
  e.pos.y = e.prevPos.y = y
  e.vel.x = e.vel.y = 0
}
const grab = (w: World): void => {
  const it = w.byId.get(w.mission.targetEntityId!)!
  place(player(w), it.pos.x, it.pos.y)
  runTicks(w, idle(), 1)
}
const standOnWayOut = (w: World): void => {
  const at = w.mission.extractPoint!
  const p = player(w)
  place(p, at.x + 0.5, at.y + 0.5)
  p.health!.iframes = 10 ** 6
}

describe('extraction under a lockdown', () => {
  it('a loud run: the grab restarts the seal, the way out holds until it lifts, then the floor advances', () => {
    const w = boot(extractionSeed, 2)
    w.alarm = 3
    w.mission.lockdownTick = w.tick
    runTicks(w, idle(), 100)
    grab(w)
    const grabTick = w.tick - 1
    expect(w.mission.lockdownTick).toBe(grabTick)
    expect(lockdownView(w)?.secondsLeft).toBe(Math.ceil(LOCKDOWN_TICKS / 30))
    standOnWayOut(w)
    runTicks(w, idle(), LOCKDOWN_TICKS - 20)
    expect(exitSealed(w)).toBe(true)
    expect(w.floor).toBe(2)
    expect(w.mission.complete).toBe(false)
    standOnWayOut(w)
    runTicks(w, idle(), 40)
    expect(w.floor).toBe(3)
  })

  it('before the grab, a latched lockdown shows no countdown (the cycle waits on the grab)', () => {
    const w = boot(extractionSeed, 2)
    w.alarm = 3
    w.mission.lockdownTick = w.tick
    runTicks(w, idle(), 5)
    expect(lockdownView(w)).toEqual({})
  })

  it('a quiet run: no lockdown, so the way out works the moment the carrier reaches it', () => {
    const w = boot(extractionSeed, 2)
    grab(w)
    expect(w.mission.lockdownTick).toBeUndefined()
    standOnWayOut(w)
    runTicks(w, idle(), 3)
    expect(w.floor).toBe(3)
  })
})
