// Steering-over-the-router integration — adversarial TDD. Every test sets
// exact world state (createWorld + carved geometry + spawns, or a serialized
// world round-tripped through deserializeWorld), runs the REAL systems via
// tickWorld, and asserts on entity state over time: NPCs route around walls,
// open closed doors on contact (never phase), respect locked doors, fail
// gracefully on unroutable goals, pause-and-scan on arrival, and stay
// byte-deterministic mid-route.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { Tile, isSolidTile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type SimEvent } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'

const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
}

const wall = (w: World, x: number, y: number): void => {
  w.level.tiles[y * w.level.w + x] = Tile.Wall
  w.level.solid[y * w.level.w + x] = 1
}

const doorAt = (w: World, x: number, y: number, locked = false): Entity => {
  const e = makeEntity('door', 'door', x + 0.5, y + 0.5, 0.5)
  e.door = { open: false, locked, lockLevel: locked ? 1 : 0 }
  e.interact = { verb: 'open', range: 1.3 }
  return addEntity(w, e)
}

const run = (w: World, n: number): SimEvent[] => {
  const seen: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, { ...emptyInput() }]]))
    seen.push(...w.events)
  }
  return seen
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

const arena = (seed = 7, hostile = true): World => {
  const w = createWorld(seed, 1, 'normal', hostile)
  carve(w, 4, 4, 40, 30)
  return w
}

/** An arena with NOTHING outside it: the whole level is filled solid first, so
 * a test's walls genuinely seal — no sneaking around through the natural map. */
const sealedArena = (seed = 7, hostile = true): World => {
  const w = createWorld(seed, 1, 'normal', hostile)
  w.level.tiles.fill(Tile.Wall)
  w.level.solid.fill(1)
  carve(w, 4, 4, 40, 30)
  return w
}

/** A hostile melee chaser with a standing grudge on the player. */
const chaser = (w: World, player: Entity, x: number, y: number): Entity => {
  const npc = spawnNpc(w, 'thug', x, y)
  npc.combat!.weapon = 'bat'
  npc.ai!.sightRange = 20
  npc.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
  return npc
}

describe('routing around walls', () => {
  it('a chaser behind a U-pocket walks around it to reach the player (no wall-grinding)', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 10.5, 17.5)
    player.health!.max = 100000
    player.health!.hp = 100000
    // A U open to the east, wrapped around the chaser's straight line west.
    for (let y = 13; y <= 21; y++) wall(w, 16, y) // west face of the U
    for (let x = 16; x <= 22; x++) {
      wall(w, x, 13)
      wall(w, x, 21)
    }
    const npc = chaser(w, player, 19.5, 17.5) // inside the U, sees nothing west
    npc.ai!.lastKnownTargetPos = { x: player.pos.x, y: player.pos.y }
    npc.ai!.mode = 'aggro'
    npc.ai!.targetId = player.id

    run(w, 450)

    // It escaped the pocket eastward and came around to the player.
    expect(dist(npc.pos, player.pos)).toBeLessThan(2.5)
    // And it never ended up inside a solid tile along the way (belt+braces —
    // collision already forbids it; the router must never fight collision).
    expect(isSolidTile(w.level, Math.floor(npc.pos.x), Math.floor(npc.pos.y))).toBe(false)
  })

  it('the cached route serializes: a mid-route snapshot restores and continues byte-identically', () => {
    // Natural level (no carving) so the checksum allows a round-trip: stage the
    // chase around the real spawn geometry.
    const build = (): World => {
      const w = createWorld(99, 2, 'normal', true)
      const sp = w.level.spawn
      const player = spawnPlayer(w, 0, sp.x, sp.y)
      const npc = spawnNpc(w, 'thug', sp.x + 6, sp.y + 4)
      npc.combat!.weapon = 'bat'
      npc.ai!.sightRange = 30
      npc.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
      npc.ai!.mode = 'aggro'
      npc.ai!.targetId = player.id
      npc.ai!.lastKnownTargetPos = { x: sp.x, y: sp.y }
      return w
    }
    const w = build()
    run(w, 60) // mid-chase; likely mid-route through real buildings
    const snap = serializeWorld(w)
    const restored = deserializeWorld(JSON.parse(JSON.stringify(snap)))
    expect(serializeWorld(restored)).toEqual(snap)
    run(w, 120)
    run(restored, 120)
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })

  it('two identical maze worlds evolve byte-identically for 300 ticks', () => {
    const build = (): World => {
      const w = arena(4242)
      const player = spawnPlayer(w, 0, 8.5, 20.5)
      player.health!.max = 100000
      player.health!.hp = 100000
      for (let y = 8; y <= 26; y++) wall(w, 20, y)
      for (let x = 12; x <= 20; x++) wall(w, x, 12)
      const a = chaser(w, player, 24.5, 20.5)
      a.ai!.mode = 'aggro'
      a.ai!.targetId = player.id
      a.ai!.lastKnownTargetPos = { x: 8.5, y: 20.5 }
      spawnNpc(w, 'civilian', 30.5, 8.5)
      return w
    }
    const a = build()
    const b = build()
    run(a, 300)
    run(b, 300)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})

describe('doors on the route', () => {
  /** Two rooms split by a wall with one doorway at (16,17) holding a door. */
  const doorWorld = (locked: boolean): { w: World; player: Entity; npc: Entity; door: Entity } => {
    const w = sealedArena()
    for (let y = 4; y <= 30; y++) if (y !== 17) wall(w, 16, y)
    const door = doorAt(w, 16, 17, locked)
    const player = spawnPlayer(w, 0, 10.5, 17.5)
    player.health!.max = 100000
    player.health!.hp = 100000
    const npc = chaser(w, player, 22.5, 17.5)
    npc.ai!.mode = 'aggro'
    npc.ai!.targetId = player.id
    npc.ai!.lastKnownTargetPos = { x: player.pos.x, y: player.pos.y }
    return { w, player, npc, door }
  }

  it('opens a closed unlocked door on contact and walks through — never phases', () => {
    const { w, player, npc, door } = doorWorld(false)
    const events = run(w, 300)
    expect(door.door!.open).toBe(true)
    // The open was the NPC's doing, evented like any door toggle.
    expect(events.some((ev) => ev.type === 'doorToggle' && ev.entityId === door.id && ev.open)).toBe(true)
    expect(dist(npc.pos, player.pos)).toBeLessThan(2.5) // and it got there
  })

  it('a locked door stays shut: the NPC does NOT phase, teleport, or oscillate', () => {
    const { w, player, npc, door } = doorWorld(true)
    run(w, 200)
    expect(door.door!.open).toBe(false)
    expect(door.door!.locked).toBe(true)
    expect(npc.pos.x).toBeGreaterThan(16.5) // still on its own side of the wall
    // It gave the unroutable memory up (no permanent grind at the door) and
    // fell back to ambient life on its own side; never NaN, never through.
    expect(npc.ai!.lastKnownTargetPos).toBeUndefined()
    expect(['wander', 'idle']).toContain(npc.ai!.mode)
    run(w, 60)
    expect(npc.pos.x).toBeGreaterThan(16.5)
    expect(Number.isFinite(npc.pos.x)).toBe(true)
    void player
  })
})

describe('unroutable goals fail gracefully', () => {
  it('a remembered position inside a sealed room: trail declared cold fast, no stall-grind', () => {
    const w = sealedArena()
    // Sealed 3×3 room — no doorway at all — with the PLAYER inside it, so the
    // memory is live (pursueMemory keeps proposing) but provably unroutable.
    for (let x = 8; x <= 12; x++) {
      wall(w, x, 14)
      wall(w, x, 18)
    }
    for (let y = 14; y <= 18; y++) {
      wall(w, 8, y)
      wall(w, 12, y)
    }
    carve(w, 9, 15, 11, 17)
    const player = spawnPlayer(w, 0, 10.5, 16.5)
    const npc = chaser(w, player, 24.5, 16.5)
    npc.ai!.mode = 'aggro'
    npc.ai!.targetId = player.id
    npc.ai!.lastKnownTargetPos = { x: 10.5, y: 16.5 } // inside the sealed room
    run(w, 90)
    // The router proved it unreachable and the trail went cold WELL before the
    // 45-tick stall timer would have had to fire repeatedly against the wall.
    expect(npc.ai!.lastKnownTargetPos).toBeUndefined()
    expect(Number.isFinite(npc.pos.x)).toBe(true)
    // It moved on to something sensible and SETTLES — no oscillation loop.
    run(w, 120)
    const before = { x: npc.pos.x, y: npc.pos.y }
    run(w, 60)
    expect(dist(npc.pos, before)).toBeLessThan(3) // ambling at most, not ping-ponging
    expect(['wander', 'idle']).toContain(npc.ai!.mode)
  })

  it('a wander waypoint in a sealed cell is dropped instead of ground against', () => {
    const w = arena(7, false)
    for (const [dx, dy] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ])
      wall(w, 30 + dx, 20 + dy)
    const npc = spawnNpc(w, 'civilian', 10.5, 20.5)
    npc.ai!.mode = 'wander'
    npc.ai!.waypoint = { x: 30.5, y: 20.5 } // sealed
    // Best-effort walks it to the cell's rim (deliberate: it went and looked),
    // then the unroutable goal is DROPPED — never a permanent wall-grind.
    run(w, 400)
    expect(npc.ai!.waypoint).not.toEqual({ x: 30.5, y: 20.5 }) // dropped it
    expect(Number.isFinite(npc.pos.x)).toBe(true)
  })
})

describe('deliberateness: arrive, pause, scan', () => {
  it('arriving at a wander destination sets a scan window: planted body, sweeping facing', () => {
    const w = arena(7, false)
    const npc = spawnNpc(w, 'civilian', 10.5, 20.5)
    npc.ai!.mode = 'wander'
    npc.ai!.waypoint = { x: 15.5, y: 20.5 }
    // Walk until arrival flips the mode and opens the scan window.
    let arrivedTick = -1
    for (let i = 0; i < 300 && arrivedTick < 0; i++) {
      run(w, 1)
      if (npc.ai!.scanUntil !== undefined) arrivedTick = w.tick
    }
    expect(arrivedTick).toBeGreaterThan(0)
    const at = { x: npc.pos.x, y: npc.pos.y }
    const facings = new Set<number>()
    while (npc.ai!.scanUntil !== undefined) {
      // Planted for every tick OF the scan (the tick after it ends may step off).
      expect(dist(npc.pos, at)).toBeLessThan(0.05)
      facings.add(npc.facing)
      run(w, 1)
    }
    expect(facings.size).toBeGreaterThan(1) // and visibly looked around
  })

  it('an urgent threat cancels the scan instantly (responsiveness unchanged)', () => {
    const w = arena(7, true)
    const npc = spawnNpc(w, 'thug', 10.5, 20.5)
    npc.combat!.weapon = 'bat'
    npc.ai!.scanUntil = w.tick + 1000 // deep in a scan
    const player = spawnPlayer(w, 0, 14.5, 20.5)
    player.health!.iframes = 0
    run(w, 40)
    expect(npc.ai!.mode).toBe('aggro')
    expect(npc.ai!.scanUntil).toBeUndefined() // scan discarded for the fight
    expect(dist(npc.pos, player.pos)).toBeLessThan(3) // it moved, immediately
  })
})
