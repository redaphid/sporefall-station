// Complex director (indoor event AI, complex floors 3, 5, 7…): vent swarms, bunk ambushes and
// wing lights-out. Every test sets world state exactly, runs the REAL systems
// (complexDirectorSystem directly, or the whole tickWorld pipeline) and asserts
// on the resulting world + events. Adversarial: city floors, no players, dead
// players, game over, swarm cap, floor change, snapshot/replay mid-schedule.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import type { Building, Level } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { populateWorld, spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import type { SimEvent } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import {
  complexDirectorSystem,
  eligibleVents,
  LIGHTS_FIRST_TICKS,
  LIGHTS_GAP_TICKS,
  LIGHTS_OUT_TICKS,
  swarmCap,
  swarmSize,
  VENT_FIRST_TICKS,
  VENT_GAP_TICKS,
  VENT_MAX_DIST,
  VENT_MIN_DIST,
  VENT_RETRY_TICKS,
  wingForPoint,
} from './complexDirector'
import { setupFloor } from './missions'

const SEED = 11
const FLOOR = 3

/** One director step at the world's current tick, collecting its events. */
const step = (w: World): SimEvent[] => {
  w.events.length = 0
  complexDirectorSystem(w)
  return [...w.events]
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)

/** A bare complex floor (no populate) with one player at `at`. */
const bare = (at?: { x: number; y: number }, seed = SEED, floor = FLOOR): { w: World; p: Entity } => {
  const w = createWorld(seed, floor)
  const pos = at ?? w.level.spawn
  const p = spawnPlayer(w, 0, pos.x, pos.y)
  return { w, p }
}

/** Centre of a non-solid tile whose distance to vent `v` is inside [lo, hi]. */
const tileNearVent = (level: Level, v: { x: number; y: number }, lo: number, hi: number): { x: number; y: number } => {
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x < level.w - 1; x++) {
      if (level.solid[y * level.w + x]) continue
      const d = Math.hypot(x - v.x, y - v.y)
      if (d >= lo && d <= hi) return { x: x + 0.5, y: y + 0.5 }
    }
  }
  throw new Error('no tile in band')
}

const quarters = (level: Level): number => level.buildings.findIndex((b) => b.role === 'quarters')

const roomCentre = (b: Building): { x: number; y: number } => ({
  x: b.rooms[0].x + Math.floor(b.rooms[0].w / 2) + 0.5,
  y: b.rooms[0].y + Math.floor(b.rooms[0].h / 2) + 0.5,
})

/** A dormant crew sleeper, as populate.spawnComplexSleepers makes one. */
const sleeper = (w: World, bi: number, x: number, y: number): Entity => {
  const e = spawnNpc(w, 'thug', x, y)
  e.ai!.zone = { building: bi, role: w.level.buildings[bi].role }
  e.ai!.dormant = true
  e.ai!.wakeOn = ['damage', 'noise']
  e.ai!.guard = true
  return e
}

describe('director lifecycle', () => {
  it('never exists on city floors and never touches the sim rng there', () => {
    for (const floor of [1, 2]) {
      const w = createWorld(SEED, floor)
      spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
      const rng0 = w.rng.state()
      w.tick = 5000
      step(w)
      expect(w.director).toBeUndefined()
      expect(w.rng.state()).toBe(rng0)
      expect(serializeWorld(w).director).toBeUndefined()
    }
  })

  it('plans a fresh schedule on the first complex tick, without an rng draw', () => {
    const { w } = bare()
    w.tick = 40
    const rng0 = w.rng.state()
    step(w)
    expect(w.director).toEqual({
      floor: FLOOR,
      nextVentAt: 40 + VENT_FIRST_TICKS,
      nextLightsAt: 40 + LIGHTS_FIRST_TICKS,
      ambushed: [],
      spawned: [],
    })
    expect(w.rng.state()).toBe(rng0)
  })

  it('re-plans when the floor changes under it, and drops itself on a city level', () => {
    const { w } = bare()
    step(w)
    w.director!.ambushed = [1, 2]
    w.director!.floor = FLOOR - 1 // stale: planned for another floor
    step(w)
    expect(w.director!.floor).toBe(FLOOR)
    expect(w.director!.ambushed).toEqual([])
    w.level = createWorld(SEED, 1).level
    step(w)
    expect(w.director).toBeUndefined()
  })

  it('is inert with no living players, and once the run is over', () => {
    const { w, p } = bare()
    step(w)
    w.tick = 100000
    p.dead = true
    const rng0 = w.rng.state()
    expect(step(w)).toEqual([])
    expect(w.rng.state()).toBe(rng0)
    p.dead = false
    w.gameOver = true
    expect(step(w)).toEqual([])
    expect(w.rng.state()).toBe(rng0)
  })
})

describe('vent swarm', () => {
  it('bursts from an eligible vent at the scheduled tick, hunting the nearest player', () => {
    const w0 = createWorld(SEED, FLOOR)
    const vent = w0.level.complex!.vents[0]
    const at = tileNearVent(w0.level, vent, 9, 11)
    const { w, p } = bare(at)
    step(w)
    const before = w.entities.length
    w.tick = VENT_FIRST_TICKS - 1
    expect(ofType(step(w), 'ventSwarm')).toEqual([])
    w.tick = VENT_FIRST_TICKS
    const evs = step(w)
    const swarm = ofType(evs, 'ventSwarm')
    expect(swarm).toHaveLength(1)
    expect(swarm[0].count).toBe(swarmSize(FLOOR))
    expect(swarm[0].targetId).toBe(p.id)
    // It came out of a vent that really was in the eligible band.
    const d = Math.hypot(swarm[0].x - p.pos.x, swarm[0].y - p.pos.y)
    expect(d).toBeGreaterThanOrEqual(VENT_MIN_DIST)
    expect(d).toBeLessThanOrEqual(VENT_MAX_DIST)
    expect(w.level.complex!.vents.some((v) => v.x + 0.5 === swarm[0].x && v.y + 0.5 === swarm[0].y)).toBe(true)
    const spawned = w.entities.slice(before)
    expect(spawned).toHaveLength(swarmSize(FLOOR))
    for (const e of spawned) {
      expect(e.archetype).toBe('sporeling')
      expect(e.ai!.mode).toBe('aggro')
      expect(e.ai!.targetId).toBe(p.id)
      expect(Math.hypot(e.pos.x - swarm[0].x, e.pos.y - swarm[0].y)).toBeLessThanOrEqual(0.3 + 1e-9)
      expect(w.level.solid[Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)]).toBe(0)
    }
    // No two swarm bodies stacked on the same point.
    expect(new Set(spawned.map((e) => `${e.pos.x},${e.pos.y}`)).size).toBe(spawned.length)
    expect(w.director!.spawned).toEqual(spawned.map((e) => e.id))
    // The grate is loud: a noise at the vent.
    expect(w.noises.some((n) => n.x === swarm[0].x && n.y === swarm[0].y)).toBe(true)
    // Next swarm is a drawn gap away — never immediately.
    const gap = w.director!.nextVentAt - w.tick
    expect(gap).toBeGreaterThanOrEqual(VENT_GAP_TICKS[0])
    expect(gap).toBeLessThanOrEqual(VENT_GAP_TICKS[1])
    w.tick++
    expect(ofType(step(w), 'ventSwarm')).toEqual([])
  })

  it('stays shut when no vent is in the band (too close OR too far), retrying without a draw', () => {
    const { w, p } = bare()
    step(w)
    w.level.complex = { ...w.level.complex!, vents: [{ x: Math.floor(p.pos.x) + 2, y: Math.floor(p.pos.y) }] }
    w.tick = VENT_FIRST_TICKS
    const rng0 = w.rng.state()
    expect(ofType(step(w), 'ventSwarm')).toEqual([])
    expect(w.rng.state()).toBe(rng0)
    expect(w.director!.nextVentAt).toBe(w.tick + VENT_RETRY_TICKS)
    // Too far is just as ineligible.
    w.level.complex = { ...w.level.complex!, vents: [{ x: Math.floor(p.pos.x) + VENT_MAX_DIST + 5, y: Math.floor(p.pos.y) }] }
    expect(eligibleVents(w, [p])).toEqual([])
    // A floor with no vents at all never spawns.
    w.level.complex = { ...w.level.complex!, vents: [] }
    w.tick = w.director!.nextVentAt
    expect(ofType(step(w), 'ventSwarm')).toEqual([])
  })

  it('measures each vent against the NEAREST player (a far player cannot unlock a vent next to a near one)', () => {
    const { w, p } = bare()
    const vent = { x: Math.floor(p.pos.x) + 2, y: Math.floor(p.pos.y) }
    w.level.complex = { ...w.level.complex!, vents: [vent] }
    const far = spawnPlayer(w, 1, vent.x + 10.5, vent.y + 0.5)
    expect(eligibleVents(w, [p, far])).toEqual([])
    const lone = eligibleVents(w, [far])
    expect(lone).toHaveLength(1)
    expect(lone[0].target).toBe(far)
  })

  it('respects the live-swarm cap, and reopens once the swarm dies', () => {
    const w0 = createWorld(SEED, FLOOR)
    const at = tileNearVent(w0.level, w0.level.complex!.vents[0], 9, 11)
    const { w } = bare(at)
    step(w)
    const cap = swarmCap(FLOOR)
    const fill = cap - swarmSize(FLOOR) + 1 // one too many to fit another swarm
    const blockers = Array.from({ length: fill }, (_, i) => spawnNpc(w, 'sporeling', 2.5 + i, 2.5))
    w.director!.spawned = blockers.map((e) => e.id)
    w.tick = VENT_FIRST_TICKS
    expect(ofType(step(w), 'ventSwarm')).toEqual([])
    for (const b of blockers) b.dead = true
    w.tick = w.director!.nextVentAt
    expect(ofType(step(w), 'ventSwarm')).toHaveLength(1)
    // Dead ids were pruned; only the new swarm is tracked.
    expect(w.director!.spawned).toHaveLength(swarmSize(FLOOR))
  })

  it('swarm size grows with depth but is capped', () => {
    expect(swarmSize(3)).toBe(2)
    expect(swarmSize(7)).toBeGreaterThan(swarmSize(3))
    expect(swarmSize(1000)).toBe(5)
    for (let f = 3; f < 60; f++) expect(swarmSize(f)).toBeLessThanOrEqual(swarmCap(f))
  })
})

describe('bunk ambush', () => {
  it('all sleepers in the room rise at once when a player steps in — once — and other rooms stay asleep', () => {
    const { w, p } = bare()
    const bi = quarters(w.level)
    expect(bi).toBeGreaterThanOrEqual(0)
    const other = w.level.buildings.findIndex((b, i) => i !== bi && b.role === 'quarters')
    const b = w.level.buildings[bi]
    const c = roomCentre(b)
    const s1 = sleeper(w, bi, b.rooms[0].x + 0.5, b.rooms[0].y + 0.5)
    const s2 = sleeper(w, bi, b.rooms[0].x + b.rooms[0].w - 0.5, b.rooms[0].y + b.rooms[0].h - 0.5)
    const s3 = other >= 0 ? sleeper(w, other, roomCentre(w.level.buildings[other]).x, roomCentre(w.level.buildings[other]).y) : undefined
    // Outside: nothing.
    expect(ofType(step(w), 'ambush')).toEqual([])
    expect(s1.ai!.dormant).toBe(true)
    // In the doorway ring but not the room: still nothing.
    const door = b.doors[0]
    p.pos = { x: door.x + 0.5, y: door.y + 0.5 }
    expect(ofType(step(w), 'ambush')).toEqual([])
    // Inside.
    p.pos = { ...c }
    const evs = step(w)
    expect(ofType(evs, 'ambush')).toEqual([{ type: 'ambush', building: bi, count: 2, x: b.rooms[0].x + b.rooms[0].w / 2, y: b.rooms[0].y + b.rooms[0].h / 2 }])
    for (const s of [s1, s2]) {
      expect(s.ai!.dormant).toBe(false)
      expect(s.ai!.mode).toBe('aggro')
      expect(s.ai!.targetId).toBe(p.id)
      expect(ofType(evs, 'woke').some((e) => e.entityId === s.id && e.by === 'ambush')).toBe(true)
    }
    if (s3) expect(s3.ai!.dormant).toBe(true)
    // Leave and come back: sprung rooms never re-fire.
    s1.ai!.dormant = true
    expect(ofType(step(w), 'ambush')).toEqual([])
    expect(s1.ai!.dormant).toBe(true)
  })

  it('an empty bunk room is marked sprung silently; dead sleepers never rise', () => {
    const { w, p } = bare()
    const bi = quarters(w.level)
    const b = w.level.buildings[bi]
    const corpse = sleeper(w, bi, b.rooms[0].x + 0.5, b.rooms[0].y + 0.5)
    corpse.dead = true
    p.pos = roomCentre(b)
    expect(ofType(step(w), 'ambush')).toEqual([])
    expect(ofType(w.events, 'woke')).toEqual([])
    expect(w.director!.ambushed).toContain(bi)
  })

  it('only crew quarters ambush — a sleeper zoned to any other module waits for its own triggers', () => {
    const { w, p } = bare()
    const bi = w.level.buildings.findIndex((b) => b.role !== 'quarters')
    const b = w.level.buildings[bi]
    const s = sleeper(w, bi, b.rooms[0].x + 0.5, b.rooms[0].y + 0.5)
    p.pos = roomCentre(b)
    step(w)
    expect(s.ai!.dormant).toBe(true)
  })
})

describe('lights out', () => {
  it('blacks out the wing the lead player stands in, stirs its dormant things, then restores power', () => {
    const { w, p } = bare()
    step(w)
    const wings = w.level.complex!.wings
    const wi = wings.findIndex((wg) => wg.buildings.length >= 2)
    const inWing = w.level.buildings[wings[wi].buildings[0]]
    const outWing = w.level.buildings[wings[(wi + 1) % wings.length].buildings[0]]
    p.pos = roomCentre(inWing)
    const near = spawnNpc(w, 'lurker', roomCentre(w.level.buildings[wings[wi].buildings[1]]).x, roomCentre(w.level.buildings[wings[wi].buildings[1]]).y)
    near.ai!.dormant = true
    const far = spawnNpc(w, 'lurker', roomCentre(outWing).x, roomCentre(outWing).y)
    far.ai!.dormant = true
    w.director!.nextVentAt = Number.MAX_SAFE_INTEGER // isolate lights
    w.tick = LIGHTS_FIRST_TICKS - 1
    expect(ofType(step(w), 'lightsOut')).toEqual([])
    w.tick = LIGHTS_FIRST_TICKS
    const evs = step(w)
    const out = ofType(evs, 'lightsOut')
    const r = wings[wi].rect
    expect(out).toEqual([{ type: 'lightsOut', wing: wi, until: w.tick + LIGHTS_OUT_TICKS, x: r.x, y: r.y, w: r.w, h: r.h }])
    expect(near.ai!.dormant).toBe(false)
    expect(ofType(evs, 'woke')).toEqual([{ type: 'woke', entityId: near.id, by: 'lightsOut' }])
    expect(far.ai!.dormant).toBe(true)
    expect(w.director!.dark).toEqual({ wing: wi, until: w.tick + LIGHTS_OUT_TICKS })
    // While dark: no second blackout, no lightsOn yet.
    w.tick += LIGHTS_OUT_TICKS - 1
    const mid = step(w)
    expect(ofType(mid, 'lightsOut')).toEqual([])
    expect(ofType(mid, 'lightsOn')).toEqual([])
    w.tick += 1
    expect(ofType(step(w), 'lightsOn')).toEqual([{ type: 'lightsOn', wing: wi }])
    expect(w.director!.dark).toBeUndefined()
    const gap = w.director!.nextLightsAt - (LIGHTS_FIRST_TICKS + LIGHTS_OUT_TICKS)
    expect(gap).toBeGreaterThanOrEqual(LIGHTS_GAP_TICKS[0])
    expect(gap).toBeLessThanOrEqual(LIGHTS_GAP_TICKS[1])
  })

  it('wingForPoint: inside a wing wins; a corridor maps to a nearby wing; far outside maps to none', () => {
    const level = createWorld(SEED, FLOOR).level
    const wings = level.complex!.wings
    for (let i = 0; i < wings.length; i++) {
      const r = wings[i].rect
      // Neighbouring wings share their dividing wall, so a corner tile may
      // belong to the earlier one — but always to a wing CONTAINING it; the
      // wing's centre is unambiguously its own.
      for (const [x, y] of [
        [r.x + 0.5, r.y + 0.5],
        [r.x + r.w - 0.5, r.y + r.h - 0.5],
      ]) {
        const got = wingForPoint(level, x, y)
        expect(got).toBeGreaterThanOrEqual(0)
        const g = wings[got].rect
        expect(x >= g.x && y >= g.y && x < g.x + g.w && y < g.y + g.h).toBe(true)
      }
      expect(wingForPoint(level, r.x + r.w / 2, r.y + r.h / 2)).toBe(i)
    }
    const c = level.complex!.corridors[0].rect
    const wi = wingForPoint(level, c.x + c.w / 2, c.y + c.h / 2)
    expect(wi).toBeGreaterThanOrEqual(0)
    expect(wingForPoint(level, -500, -500)).toBe(-1)
    // A city level has no wings at all.
    expect(wingForPoint(createWorld(SEED, 1).level, 10, 10)).toBe(-1)
  })
})

describe('integration: the real tick pipeline', () => {
  const populated = (): World => {
    const w = createWorld(SEED, 5)
    populateWorld(w)
    setupFloor(w)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    return w
  }

  it('a populated complex floor stages events over a long run, deterministically', () => {
    const a = populated()
    const b = populated()
    const seenA: SimEvent[] = []
    for (let i = 0; i < LIGHTS_FIRST_TICKS + 30; i++) {
      tickWorld(a, new Map())
      seenA.push(...a.events.filter((e) => e.type === 'lightsOut' || e.type === 'ventSwarm' || e.type === 'ambush'))
    }
    runTicks(b, new Map(), LIGHTS_FIRST_TICKS + 30)
    expectWorldEqual(a, b)
    expect(a.director).toBeDefined()
    // The spawn corridor is a real place: at least a lights-out or swarm fired.
    expect(seenA.length).toBeGreaterThan(0)
  })

  it('a mid-schedule snapshot replays byte-identically (director state serializes)', () => {
    const a = populated()
    runTicks(a, new Map(), VENT_FIRST_TICKS + 10)
    expect(a.director).toBeDefined()
    const json = serializeWorld(a)
    expect(json.director).toEqual(a.director)
    const b = deserializeWorld(JSON.parse(JSON.stringify(json)))
    expect(b.director).toEqual(a.director)
    expect(b.director).not.toBe(a.director) // owns its data
    runTicks(a, new Map(), 900)
    runTicks(b, new Map(), 900)
    expectWorldEqual(a, b)
  })

  it('city-floor snapshots carry no director key at all', () => {
    const w = createWorld(SEED, 2)
    populateWorld(w)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    runTicks(w, new Map(), 60)
    expect('director' in serializeWorld(w)).toBe(false)
  })
})

describe('wingForPoint over every corridor tile (adversarial sweep)', () => {
  it('every corridor tile of every complex floor maps to some wing, so lights-out can always find the lead', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const floor of [3, 5, 7, 9]) {
        const level = createWorld(seed, floor).level
        for (const c of level.complex!.corridors) {
          for (let y = c.rect.y; y < c.rect.y + c.rect.h; y++) {
            for (let x = c.rect.x; x < c.rect.x + c.rect.w; x++) {
              expect(wingForPoint(level, x + 0.5, y + 0.5), `seed ${seed} floor ${floor} at ${x},${y}`).toBeGreaterThanOrEqual(0)
            }
          }
        }
      }
    }
  })
})
