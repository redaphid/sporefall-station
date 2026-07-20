// #68 — dormancy + stimulus-trigger. A dormant entity is inert until a matching
// stimulus wakes it (emitting `woke`); the robot/power-cut special case is now
// one data row (`wakeOn: ['power-cut']`). Sets exact state, runs the REAL
// tickWorld/awakeningSystem, asserts what wakes what.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput } from '../types'
import { createWorld, emitNoise, tickWorld, type World } from '../world'
import { arbitrateGoal } from './behaviors'
import { applyDamage } from './combat'

const arena = (hostile = false): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1, 'normal', hostile)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 10; y <= cy + 10; y++)
    for (let x = cx - 10; x <= cx + 10; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}
const dormantPod = (w: World, x: number, y: number, wakeOn: string[]) => {
  const e = spawnNpc(w, 'pod', x, y)
  e.ai!.wakeOn = wakeOn // isolate the trigger under test
  e.health = { hp: 1e6, max: 1e6, iframes: 0 }
  return e
}
const woke = (w: World, id: number): boolean => w.events.some((ev) => ev.type === 'woke' && ev.entityId === id)

describe('#68 dormancy — a noise-triggered pod', () => {
  it('sleeps through a quiet room, then wakes when a noise sounds in range', () => {
    const { w, cx, cy } = arena()
    const pod = dormantPod(w, cx, cy, ['noise'])
    const input = new Map([[0, emptyInput()]])
    // A quiet player standing nearby is no stimulus (proximity trigger is off).
    const p = spawnPlayer(w, 0, cx + 2, cy)
    p.health = { hp: 100, max: 100, iframes: 0 }
    for (let t = 0; t < 20; t++) tickWorld(w, input)
    expect(pod.ai!.dormant).toBe(true) // still asleep
    const startPos = { x: pod.pos.x, y: pod.pos.y }
    expect(pod.pos).toEqual(startPos) // and it never moved (inert)

    emitNoise(w, cx + 4, cy) // a clatter within wake range
    let wokeTick = -1
    for (let t = 0; t < 8 && wokeTick < 0; t++) {
      tickWorld(w, input)
      if (!pod.ai!.dormant && wokeTick < 0) wokeTick = t
    }
    expect(pod.ai!.dormant).toBe(false)
    expect(wokeTick).toBeGreaterThanOrEqual(0)
    expect(wokeTick).toBeLessThanOrEqual(3) // wakes promptly
  })
})

describe('#68 dormancy — the trigger list is selective', () => {
  it('a power-cut unit ignores noise but wakes on the cut', () => {
    const { w, cx, cy } = arena()
    const unit = dormantPod(w, cx, cy, ['power-cut'])
    const input = new Map([[0, emptyInput()]])
    emitNoise(w, cx + 1, cy) // right next to it…
    for (let t = 0; t < 10; t++) tickWorld(w, input)
    expect(unit.ai!.dormant).toBe(true) // …but noise is not on its list

    w.powerCut.wingA = true
    tickWorld(w, input)
    expect(unit.ai!.dormant).toBe(false)
    expect(woke(w, unit.id)).toBe(true)
  })

  it('a body straying too close trips a proximity sleeper', () => {
    const { w, cx, cy } = arena()
    const pod = dormantPod(w, cx, cy, ['proximity'])
    const input = new Map([[0, emptyInput()]])
    const p = spawnPlayer(w, 0, cx + 8, cy) // out of proximity range
    p.health = { hp: 100, max: 100, iframes: 0 }
    for (let t = 0; t < 6; t++) tickWorld(w, input)
    expect(pod.ai!.dormant).toBe(true)
    p.pos.x = cx + 1.5 // creep up on it
    tickWorld(w, input)
    expect(pod.ai!.dormant).toBe(false)
  })

  it('a hit trips a damage sleeper', () => {
    const { w, cx, cy } = arena()
    const pod = dormantPod(w, cx, cy, ['damage'])
    const input = new Map([[0, emptyInput()]])
    tickWorld(w, input)
    expect(pod.ai!.dormant).toBe(true)
    applyDamage(w, pod, 5, cx + 1, cy, 0, 0)
    tickWorld(w, input)
    expect(pod.ai!.dormant).toBe(false)
  })
})

describe('#68 dormancy — a woken pod acts, and the robot rule is now a data row', () => {
  it('once woken the pod is a live threat that hunts its intruder', () => {
    const { w, cx, cy } = arena(true) // hostile station → the pod hunts the player
    const pod = dormantPod(w, cx, cy, ['proximity'])
    const p = spawnPlayer(w, 0, cx + 2, cy) // trips proximity AND is prey
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 20; t++) tickWorld(w, input)
    expect(pod.ai!.dormant).toBe(false)
    expect(pod.ai!.mode).toBe('aggro') // it hatched hostile and closed on the player
    expect(pod.ai!.targetId).toBe(p.id)
  })

  it('the Derelict Unit turns hostile on a power-cut via wakeOn (no archetype branch)', () => {
    // Robots are NOT dormant — they wander a lit station and rouse to hostility
    // on a cut, now driven by the `wakeOn: ['power-cut']` data row.
    const powered = arena()
    const rob1 = spawnNpc(powered.w, 'robot', powered.cx, powered.cy)
    rob1.ai!.sightRange = 12
    const p1 = spawnPlayer(powered.w, 0, powered.cx + 1, powered.cy)
    p1.health = { hp: 100, max: 100, iframes: 0 }
    expect(rob1.ai!.dormant).toBeFalsy() // awake, just neutral
    expect(arbitrateGoal(powered.w, rob1).target).not.toBe(p1.id)

    const dark = arena()
    const rob2 = spawnNpc(dark.w, 'robot', dark.cx, dark.cy)
    rob2.ai!.sightRange = 12
    const p2 = spawnPlayer(dark.w, 0, dark.cx + 1, dark.cy)
    p2.health = { hp: 100, max: 100, iframes: 0 }
    dark.w.powerCut.wingA = true
    expect(arbitrateGoal(dark.w, rob2).target).toBe(p2.id)
  })
})
