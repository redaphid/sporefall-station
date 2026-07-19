// Adversarial unit tests for the window.backseat inspection surface glue:
// filters (name/component/predicate, hostile predicates), the events ring
// buffer across per-tick wipes (dupes, eviction, caps), read-only enforcement
// in production mode, client (no-world) fallbacks, and help() completeness —
// a method added without documentation fails here.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { deserializeWorld } from '../game/serialize'
import type { SimEvent } from '../game/types'
import { addEntity, createWorld, type World } from '../game/world'
import { createInspect, EVENT_CAP, EVENT_TICK_WINDOW, installInspect, type InspectDeps } from './inspect'
import type { RenderView } from './session'

const buildWorld = (): World => {
  const w = createWorld(123, 1)
  spawnPlayer(w, 0, 5, 5)
  const npc = addEntity(w, makeEntity('npc', 'thug', 8, 5))
  npc.health = { hp: 2, max: 5, iframes: 0 }
  npc.ai = { mode: 'idle', faction: 'gang', home: { x: 8, y: 5 }, thinkAt: 0, sightRange: 6 }
  const guard = addEntity(w, makeEntity('npc', 'guard', 9, 6))
  guard.health = { hp: 5, max: 5, iframes: 0 }
  const door = addEntity(w, makeEntity('door', 'door', 10, 5))
  door.door = { open: false, locked: false, lockLevel: 0 }
  return w
}

const viewOf = (w: World, events: readonly SimEvent[] = []): RenderView => ({
  entities: w.entities,
  events,
  tick: w.tick,
  level: w.level,
  floor: w.floor,
  missionText: w.mission.description,
  missionComplete: w.mission.complete,
  gameOver: w.gameOver,
  self: w.entities.find((e) => e.playerCtl),
})

const hostDeps = (w: World, over: Partial<InspectDeps> = {}): InspectDeps => ({
  getWorld: () => w,
  getView: () => viewOf(w),
  sessionInfo: () => ({ mode: 'solo', paused: false }),
  devWrites: true,
  version: 'test-build',
  ...over,
})

describe('backseat.entities filters', () => {
  const w = buildWorld()
  const { ns } = createInspect(hostDeps(w))

  it('no filter returns every entity as a detached clone', () => {
    const all = ns.entities()
    expect(all).toHaveLength(w.entities.length)
    ;(all[0] as { pos: { x: number } }).pos.x = 999
    expect(w.entities[0].pos.x).not.toBe(999) // clone — the sim is untouched
  })

  it('filters by kind, archetype, and component presence', () => {
    expect(ns.entities('npc')).toHaveLength(2)
    expect(ns.entities('guard')).toHaveLength(1)
    expect(ns.entities('door')).toHaveLength(1) // kind AND component both match
    expect(ns.entities('playerCtl')).toHaveLength(1) // component presence
    expect(ns.entities('nonexistent-thing')).toHaveLength(0)
  })

  it('compiles a predicate string and accepts a function', () => {
    expect(ns.entities('e => e.health && e.health.hp < 3')).toHaveLength(1)
    expect(ns.entities((e: Entity) => e.pos.x > 7)).toHaveLength(3)
  })

  it('rejects a malformed predicate string loudly', () => {
    expect(() => ns.entities('e => (((')).toThrow(/bad predicate/)
    expect(() => ns.entities('"not a fn" => 1 => 2')).toThrow(/bad predicate/)
  })
})

describe('backseat entity/player/mission reads', () => {
  const w = buildWorld()
  const { ns } = createInspect(hostDeps(w))

  it('entity(id) returns a clone; a missing id returns undefined', () => {
    const npc = w.entities.find((e) => e.archetype === 'thug')!
    const got = ns.entity(npc.id)!
    expect(got.id).toBe(npc.id)
    ;(got as { health: { hp: number } }).health.hp = 0
    expect(npc.health!.hp).toBe(2)
    expect(ns.entity(99999)).toBeUndefined()
  })

  it('player() is the local player; player(n) looks up by slot', () => {
    expect((ns.player() as { playerCtl: { playerId: number } }).playerCtl.playerId).toBe(0)
    expect((ns.player(0) as { playerCtl: { playerId: number } }).playerCtl.playerId).toBe(0)
    expect(ns.player(3)).toBeUndefined()
  })

  it('mission() is a clone of world.mission', () => {
    const m = ns.mission()
    expect(m.description).toBe(w.mission.description)
    m.description = 'tampered'
    expect(w.mission.description).not.toBe('tampered')
  })

  it('session()/tick()/version() report the basics', () => {
    expect(ns.session()).toMatchObject({ mode: 'solo', paused: false, seed: 123, floor: 1, tick: w.tick })
    expect(ns.tick()).toBe(w.tick)
    expect(ns.version()).toBe('test-build')
  })

  it('schema() reflects live components without a hardcoded list', () => {
    const s = ns.schema()
    expect(s.entityCount).toBe(w.entities.length)
    expect(s.kinds.npc).toBe(2)
    expect(Object.keys(s.fields)).toEqual(expect.arrayContaining(['pos', 'health', 'door', 'playerCtl']))
  })

  it('serialize() round-trips through deserializeWorld', () => {
    const restored = deserializeWorld(JSON.parse(ns.serialize()))
    expect(restored.seed).toBe(w.seed)
    expect(restored.entities).toHaveLength(w.entities.length)
  })
})

describe('events ring buffer across per-tick wipes', () => {
  it('buffers events the next tick would wipe, tagged with their tick', () => {
    const w = buildWorld()
    const inspect = createInspect(hostDeps(w))
    w.tick = 1
    w.events.push({ type: 'noise', x: 1, y: 2 })
    inspect.afterTick()
    w.events.length = 0 // the wipe tickWorld() performs
    w.tick = 2
    w.events.push({ type: 'death', x: 3, y: 4, entityId: 7 })
    inspect.afterTick()
    expect(inspect.ns.events()).toEqual([
      { type: 'noise', x: 1, y: 2, tick: 1 },
      { type: 'death', x: 3, y: 4, entityId: 7, tick: 2 },
    ])
    expect(inspect.ns.events(2)).toEqual([{ type: 'death', x: 3, y: 4, entityId: 7, tick: 2 }])
    expect(inspect.ns.events(3)).toEqual([])
  })

  it('ignores duplicate afterTick calls on the same tick (paused loop)', () => {
    const w = buildWorld()
    const inspect = createInspect(hostDeps(w))
    w.tick = 5
    w.events.push({ type: 'noise', x: 0, y: 0 })
    inspect.afterTick()
    inspect.afterTick()
    inspect.afterTick()
    expect(inspect.ns.events()).toHaveLength(1)
  })

  it('evicts events older than the tick window and enforces the hard cap', () => {
    const w = buildWorld()
    const inspect = createInspect(hostDeps(w))
    for (let t = 1; t <= EVENT_TICK_WINDOW + 100; t++) {
      w.tick = t
      w.events.length = 0
      w.events.push({ type: 'noise', x: t, y: 0 })
      inspect.afterTick()
    }
    const evs = inspect.ns.events()
    expect(evs[0].tick).toBeGreaterThanOrEqual(w.tick - EVENT_TICK_WINDOW)
    expect(evs.at(-1)!.tick).toBe(w.tick)
    expect(evs.length).toBeLessThanOrEqual(EVENT_CAP)

    // Hard cap: a single-tick storm of > EVENT_CAP events cannot grow unbounded.
    w.tick += 1
    w.events.length = 0
    for (let i = 0; i < EVENT_CAP + 500; i++) w.events.push({ type: 'noise', x: i, y: 1 })
    inspect.afterTick()
    expect(inspect.ns.events()).toHaveLength(EVENT_CAP)
  })

  it('returned events are clones — tampering does not corrupt the buffer', () => {
    const w = buildWorld()
    const inspect = createInspect(hostDeps(w))
    w.tick = 1
    w.events.push({ type: 'noise', x: 1, y: 1 })
    inspect.afterTick()
    const got = inspect.ns.events() as { x: number }[]
    got[0].x = 999
    expect((inspect.ns.events()[0] as { x: number }).x).toBe(1)
  })
})

describe('write gating', () => {
  it('production builds: verb() refuses with an explanation and mutates nothing', () => {
    const w = buildWorld()
    const { ns } = createInspect(hostDeps(w, { devWrites: false }))
    const player = w.entities.find((e) => e.playerCtl)!
    const before = { ...player.pos }
    const reply = ns.verb(`teleport ${player.id} 20 20`)
    expect(reply).toContain('?debug')
    expect(reply).toContain('dev-only')
    expect(player.pos).toEqual(before)
    // Even a read verb goes through the same gate — the read METHODS are the
    // production surface; verb() is all-or-nothing for legibility.
    expect(ns.verb('state')).toContain('?debug')
  })

  it('dev builds: verb() drives the real dispatcher', () => {
    const w = buildWorld()
    const { ns } = createInspect(hostDeps(w))
    const player = w.entities.find((e) => e.playerCtl)!
    const reply = JSON.parse(ns.verb('teleport', `${player.id} 20 20`))
    expect(reply.pos).toEqual({ x: 20, y: 20 })
    expect(player.pos).toEqual({ x: 20, y: 20 })
    expect(() => ns.verb('nonsense-verb')).toThrow(/unknown verb/)
  })

  it('the events verb answers from the surface ring buffer', () => {
    const w = buildWorld()
    const inspect = createInspect(hostDeps(w))
    w.tick = 1
    w.events.push({ type: 'noise', x: 1, y: 1 })
    inspect.afterTick()
    w.events.length = 0 // wiped — only the ring buffer remembers
    expect(JSON.parse(inspect.ns.verb('events'))).toHaveLength(1)
  })

  it('the namespace itself is frozen — its methods cannot be swapped out', () => {
    const { ns } = createInspect(hostDeps(buildWorld()))
    expect(Object.isFrozen(ns)).toBe(true)
    expect(() => {
      ;(ns as unknown as Record<string, unknown>).verb = () => 'pwned'
    }).toThrow()
  })
})

describe('client (join) sessions — no authoritative world', () => {
  const clientDeps = (view: () => RenderView): InspectDeps =>
    ({
      getWorld: () => undefined,
      getView: view,
      sessionInfo: () => ({ mode: 'join', paused: false }),
      devWrites: true, // even with dev writes, no world → verbs unavailable
      version: 'test-build',
    })

  it('reads fall back to the latest predicted view', () => {
    const w = buildWorld()
    w.tick = 42
    const inspect = createInspect(clientDeps(() => viewOf(w)))
    inspect.frame(viewOf(w))
    expect(inspect.ns.tick()).toBe(42)
    expect(inspect.ns.session()).toMatchObject({ mode: 'join', tick: 42, predicted: true })
    expect(inspect.ns.entities('npc')).toHaveLength(2)
    expect(inspect.ns.entity(w.entities[0].id)?.id).toBe(w.entities[0].id)
    expect(inspect.ns.mission()).toMatchObject({ description: w.mission.description })
    expect(inspect.ns.schema().kinds.npc).toBe(2)
    const world = inspect.ns.world as { predicted?: boolean; tick: number }
    expect(world.predicted).toBe(true)
    expect(world.tick).toBe(42)
  })

  it('harvests events from frames (clients drain them in renderView)', () => {
    const w = buildWorld()
    w.tick = 7
    const inspect = createInspect(clientDeps(() => viewOf(w)))
    inspect.frame(viewOf(w, [{ type: 'noise', x: 1, y: 1 }]))
    inspect.frame(viewOf(w, [])) // a later frame with no events adds nothing
    inspect.frame(viewOf(w, [{ type: 'noise', x: 2, y: 2 }])) // same tick, new batch
    expect(inspect.ns.events()).toHaveLength(2)
  })

  it('serialize() and verb() explain themselves instead of half-working', () => {
    const w = buildWorld()
    const inspect = createInspect(clientDeps(() => viewOf(w)))
    expect(inspect.ns.serialize()).toContain('host')
    expect(inspect.ns.verb('teleport 1 0 0')).toContain('host')
  })
})

describe('help() completeness', () => {
  const { ns } = createInspect(hostDeps(buildWorld()))

  it('documents every member of the namespace (fails on an undocumented addition)', () => {
    const help = ns.help()
    for (const key of Object.keys(ns)) {
      expect(help, `member "${key}" is missing from help()`).toMatch(new RegExp(`backseat\\.${key}\\b`))
    }
  })

  it('mentions no member that does not exist', () => {
    const documented = [...ns.help().matchAll(/^ {2}backseat\.([A-Za-z]+)/gm)].map((m) => m[1])
    expect(documented.length).toBeGreaterThan(0)
    for (const name of documented) {
      expect(name in ns, `help() documents "${name}" which is not on the namespace`).toBe(true)
    }
  })
})

describe('installInspect', () => {
  it('defines a live world getter and the frozen namespace on the target', () => {
    const w = buildWorld()
    const inspect = createInspect(hostDeps(w))
    const target: Record<string, unknown> = {}
    installInspect(inspect, target)
    expect(target.world).toBe(w) // the LIVE reference, not a copy
    expect(target.backseat).toBe(inspect.ns)
  })
})
