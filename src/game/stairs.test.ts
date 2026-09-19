// Stairs in the sim (docs/design/stairs-and-storeys.md §3.2): state set exactly,
// the real tickWorld run, results asserted. Adversarial cases: held input after
// arrival (ping-pong), a downed player, an NPC shoved onto the stair, a body
// already standing on the landing, a save mid-shaft, and a full floor soak that
// no entity ever leaks into the gutter.

import { describe, expect, it } from 'vitest'
import type { Entity } from './entity'
import { generateLevel } from './levelgen/generate'
import { STOREY_SIZE, STOREY_STRIDE, Tile, type Level, type StairLink } from './levelgen/level'
import { spawnPlayer } from './player'
import { populateWorld, spawnNpc } from './populate'
import { deserializeWorld, serializeWorld } from './serialize'
import {
  cameraRect,
  floodLinked,
  groundAnchor,
  linkedNeighbors,
  onViewerStorey,
  sameStorey,
  stairReservedKeys,
  stairStep,
  stairTransit,
  storeyBadge,
  storeyBounds,
  storeyOf,
  storeyZ,
} from './stairs'
import { nextFloor, setupFloor } from './systems/missions'
import { expectWorldEqual, runTicks } from './testkit'
import type { InputCmd } from './types'
import { createWorld, tickWorld, type World } from './world'

const SEED = 1
const FLOOR = 3

const DV = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] } as const

/** The ground StairUp link and its reverse. */
const shaft = (level: Level): { up: StairLink; down: StairLink } => {
  const up = level.stairs!.find((l) => l.from.x < STOREY_STRIDE)!
  const down = level.stairs!.find((l) => l.from.x === up.to.x && l.from.y === up.to.y)!
  return { up, down }
}

/** A bare world (no population) with one player two tiles in front of the
 * ground stair, facing it. */
const stairWorld = (): { w: World; p: Entity; up: StairLink; down: StairLink; toward: Partial<InputCmd>; away: Partial<InputCmd> } => {
  const w = createWorld(SEED, FLOOR)
  expect(w.level.stairs, 'the fixture floor must have a loft').toBeDefined()
  const { up, down } = shaft(w.level)
  const [dx, dy] = DV[up.dir]
  const p = spawnPlayer(w, 0, down.landing.x + dx + 0.5, down.landing.y + dy + 0.5)
  return { w, p, up, down, toward: { moveX: -dx, moveY: -dy }, away: { moveX: dx, moveY: dy } }
}

const run = (w: World, cmd: Partial<InputCmd>, n: number): void => {
  runTicks(w, new Map([[0, cmd]]), n)
}

describe('stairs: pure queries', () => {
  const level = generateLevel(SEED, FLOOR)
  const { up, down } = shaft(level)

  it('storeys are a function of x alone', () => {
    expect(storeyOf(0)).toBe(0)
    expect(storeyOf(63.9)).toBe(0)
    expect(storeyOf(79.9)).toBe(0) // the gutter belongs to no one, but counts as slot 0's side
    expect(storeyOf(80)).toBe(1)
    expect(storeyOf(-3)).toBe(0)
    expect(storeyZ(level, 100)).toBe(1)
    expect(storeyZ(generateLevel(SEED, 1), 100)).toBe(0)
    expect(sameStorey(10, 60)).toBe(true)
    expect(sameStorey(10, 90)).toBe(false)
    expect(storeyBounds(level, 90)).toEqual({ x0: STOREY_STRIDE, y0: 0, w: STOREY_SIZE, h: 64 })
    expect(storeyBounds(generateLevel(SEED, 1), 10)).toEqual({ x0: 0, y0: 0, w: 64, h: 64 })
    expect(cameraRect(level, 5)).toEqual({ levelW: 64, levelH: 64, levelX0: 0, levelY0: 0 })
    expect(storeyBadge(1)).toBe('▲1')
    expect(storeyBadge(-2)).toBe('▼2')
    expect(storeyBadge(0)).toBe('')
  })

  it('stairTransit: a stair tile leads to the landing centre on the other storey; nothing else moves', () => {
    expect(stairTransit(level, up.from.x + 0.1, up.from.y + 0.9)).toMatchObject({ x: up.landing.x + 0.5, y: up.landing.y + 0.5 })
    expect(stairTransit(level, down.from.x + 0.5, down.from.y + 0.5)).toMatchObject({ x: down.landing.x + 0.5, y: down.landing.y + 0.5 })
    expect(stairTransit(level, down.landing.x + 0.5, down.landing.y + 0.5)).toBeNull()
    expect(stairTransit(generateLevel(SEED, 1), 5, 5)).toBeNull()
  })

  it('stairStep: climbs once, then holds the lock on the stair and landing, and releases it anywhere else', () => {
    const a = stairStep(level, up.from.x + 0.5, up.from.y + 0.5, false)
    expect(a.link).toBe(up)
    expect(a.locked).toBe(true)
    // Locked on the landing, and even back on the (other storey's) stair tile.
    for (const [x, y] of [
      [a.x, a.y],
      [down.from.x + 0.5, down.from.y + 0.5],
    ]) {
      const r = stairStep(level, x, y, true)
      expect(r.locked).toBe(true)
      expect(r.link).toBeUndefined()
      expect({ x: r.x, y: r.y }).toEqual({ x, y })
    }
    // Still locked one tile out (the landing's 3x3); clear two tiles out.
    const [dx, dy] = DV[up.dir]
    expect(stairStep(level, up.landing.x + dx + 0.5, up.landing.y + dy + 0.5, true).locked).toBe(true)
    expect(stairStep(level, up.landing.x + 2 * dx + 0.5, up.landing.y + 2 * dy + 0.5, true).locked).toBe(false)
    // Unlocked on plain deck: nothing happens.
    expect(stairStep(level, up.landing.x + 2 * dx + 0.5, up.landing.y + 2 * dy + 0.5, false)).toMatchObject({ locked: false })
  })

  it('linkedNeighbors / floodLinked take the stairs; without them the loft is sealed', () => {
    const k = up.from.y * level.w + up.from.x
    expect(linkedNeighbors(level, k)).toContain(up.landing.y * level.w + up.landing.x)
    const start = Math.floor(level.spawn.y) * level.w + Math.floor(level.spawn.x)
    const reach = floodLinked(level, start)
    expect(reach[up.landing.y * level.w + up.landing.x]).toBe(1)
    const noStairs = floodLinked(level, start, (key) => key === k)
    expect(noStairs[up.landing.y * level.w + up.landing.x]).toBe(0)
  })

  it('groundAnchor: an upstairs point is called out at the foot of the stairs; ground points are unchanged', () => {
    expect(groundAnchor(level, 100.5, 20.5)).toEqual({ x: down.landing.x + 0.5, y: down.landing.y + 0.5 })
    expect(groundAnchor(level, 10.5, 20.5)).toEqual({ x: 10.5, y: 20.5 })
  })

  it('onViewerStorey re-expresses a point on the viewer storey with its storey offset', () => {
    expect(onViewerStorey(level, 10, { x: 100, y: 7 })).toEqual({ x: 20, y: 7, dz: 1 })
    expect(onViewerStorey(level, 100, { x: 20, y: 7 })).toEqual({ x: 100, y: 7, dz: -1 })
    expect(onViewerStorey(level, 100, { x: 90, y: 7 })).toEqual({ x: 90, y: 7, dz: 0 })
  })

  it('the reserved clearance covers both stairs and both landings with their 3x3', () => {
    const keys = stairReservedKeys(level)
    for (const l of [up, down]) {
      expect(keys.has(l.from.y * level.w + l.from.x)).toBe(true)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) expect(keys.has((l.landing.y + dy) * level.w + l.landing.x + dx)).toBe(true)
    }
    expect(stairReservedKeys(generateLevel(SEED, 1)).size).toBe(0)
  })
})

describe('stairs: stairSystem in the real tick', () => {
  it('walking into the stair climbs to the loft landing, with a storeyChange event, on the tick it steps on', () => {
    const { w, p, up, toward } = stairWorld()
    let climbedAt = -1
    for (let t = 0; t < 60 && climbedAt < 0; t++) {
      tickWorld(w, new Map([[0, { ...emptyCmd(), ...toward }]]))
      const ev = w.events.find((e) => e.type === 'storeyChange')
      if (ev) {
        climbedAt = t
        expect(ev).toMatchObject({ entityId: p.id, z: 1 })
      }
    }
    expect(climbedAt).toBeGreaterThan(0)
    expect(storeyOf(p.pos.x)).toBe(1)
    expect({ x: p.pos.x, y: p.pos.y }).toEqual({ x: up.landing.x + 0.5, y: up.landing.y + 0.5 })
    expect(p.prevPos).toEqual(p.pos) // no interpolation smear across the atlas
    expect(p.vel).toEqual({ x: 0, y: 0 })
    expect(p.stairLock).toBe(true)
  })

  it('holding forward after arriving does NOT bounce back down (the lock)', () => {
    const { w, p, toward } = stairWorld()
    run(w, toward, 40)
    expect(storeyOf(p.pos.x)).toBe(1)
    run(w, toward, 120) // still pushing into the upper stair
    expect(storeyOf(p.pos.x)).toBe(1)
  })

  it('stepping off and walking back in descends to the ground landing', () => {
    const { w, p, down, toward, away } = stairWorld()
    run(w, toward, 40)
    expect(storeyOf(p.pos.x)).toBe(1)
    run(w, away, 20)
    expect(p.stairLock).toBeUndefined()
    for (let t = 0; t < 60 && storeyOf(p.pos.x) === 1; t++) run(w, toward, 1)
    expect(storeyOf(p.pos.x)).toBe(0)
    expect({ x: p.pos.x, y: p.pos.y }).toEqual({ x: down.landing.x + 0.5, y: down.landing.y + 0.5 })
  })

  it('a downed player on the stair tile stays put', () => {
    const { w, p, up } = stairWorld()
    p.pos = { x: up.from.x + 0.5, y: up.from.y + 0.5 }
    p.playerCtl!.downed = { bleedTicks: 1000, reviveProgress: 0 }
    run(w, {}, 5)
    expect(storeyOf(p.pos.x)).toBe(0)
  })

  it('an NPC on the stair tile never transits (Phase 1: only players take the stairs)', () => {
    const { w, up } = stairWorld()
    const npc = spawnNpc(w, 'thug', up.from.x + 0.5, up.from.y + 0.5)
    npc.ai = undefined
    run(w, {}, 10)
    expect(storeyOf(npc.pos.x)).toBe(0)
  })

  it('a body already on the landing: the climber arrives on the nearest free tile of the loft, never a stair', () => {
    const { w, p, up, toward } = stairWorld()
    const squatter = spawnPlayer(w, 1, up.landing.x + 0.5, up.landing.y + 0.5)
    for (let t = 0; t < 60 && storeyOf(p.pos.x) === 0; t++) runTicks(w, new Map([[0, toward], [1, {}]]), 1)
    expect(storeyOf(p.pos.x)).toBe(1)
    // Where it ARRIVED (the tick of the climb): beside the squatter, not on it.
    expect(p.pos).not.toEqual({ x: up.landing.x + 0.5, y: up.landing.y + 0.5 })
    expect(Math.hypot(p.pos.x - squatter.pos.x, p.pos.y - squatter.pos.y)).toBeGreaterThan(0.5)
    const t = w.level.tiles[Math.floor(p.pos.y) * w.level.w + Math.floor(p.pos.x)]
    expect(t === Tile.StairDown || t === Tile.StairUp).toBe(false)
  })

  it('a save taken mid-shaft (locked on the landing) replays byte-identically', () => {
    const { w, toward, away } = stairWorld()
    run(w, toward, 40)
    const copy = deserializeWorld(serializeWorld(w))
    for (const cmd of [toward, away, toward]) {
      run(w, cmd, 30)
      run(copy, cmd, 30)
    }
    expectWorldEqual(w, copy)
  })

  it('a new floor clears the lock and lands everyone on the ground spawn', () => {
    const { w, p, toward } = stairWorld()
    run(w, toward, 40)
    expect(p.stairLock).toBe(true)
    nextFloor(w)
    expect(p.stairLock).toBeUndefined()
    expect(storeyOf(p.pos.x)).toBe(0)
    expect(p.pos).toEqual(w.level.spawn)
  })
})

describe('stairs: the atlas never leaks (R2)', () => {
  it('a populated floor runs 30 s with a player upstairs: no entity enters the gutter, nothing hostile reaches the loft', () => {
    const w = createWorld(SEED, FLOOR)
    populateWorld(w)
    setupFloor(w)
    const { up } = shaft(w.level)
    const p = spawnPlayer(w, 0, up.landing.x + 0.5, up.landing.y + 0.5)
    const q = spawnPlayer(w, 1, w.level.spawn.x, w.level.spawn.y)
    for (let t = 0; t < 900; t++) {
      tickWorld(w, new Map([[0, { ...emptyCmd(), moveX: Math.sin(t / 20), moveY: Math.cos(t / 30) }], [1, emptyCmd()]]))
      for (const e of w.entities) {
        const x = Math.floor(e.pos.x)
        expect(x >= STOREY_SIZE && x < STOREY_STRIDE, `tick ${t}: ${e.archetype} in the gutter at ${e.pos.x}`).toBe(false)
        if (storeyOf(e.pos.x) === 1 && e.kind === 'npc') throw new Error(`tick ${t}: ${e.archetype} upstairs`)
      }
    }
    expect(storeyOf(p.pos.x)).toBe(1)
    expect(q.dead).toBeFalsy()
  })
})

const emptyCmd = (): InputCmd => ({
  seq: 0,
  moveX: 0,
  moveY: 0,
  attack: false,
  interact: false,
  special: false,
  aimX: 1,
  aimY: 0,
  hotbar: -1,
  throwItem: false,
  roll: false,
})
