// Lurker ('lurker' behavior + dormancy wake triggers) — adversarial TDD.
// Exact world state, the REAL systems via tickWorld, assertions on the ambush
// contract: a dormant lurker is INERT (no movement, no thinking) until a
// proximity trip, its door opening, or a hit — then it bursts at the player
// with total commitment. Populate seeds it deterministically into preferred
// back rooms, never floor 1, never the bunker guard band.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { Tile, isWallTile, tileAt } from '../levelgen/level'
import { assignRoomTypes } from '../levelgen/roomTypes'
import { spawnPlayer } from '../player'
import { populateWorld, roomOwningTile, spawnNpc } from '../populate'
import { serializeWorld } from '../serialize'
import { emptyInput, type SimEvent } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'

const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
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

const arena = (seed = 7): World => {
  const w = createWorld(seed, 1, 'normal', true)
  carve(w, 4, 4, 40, 30)
  return w
}

const lurkerAt = (w: World, x: number, y: number): Entity => {
  const e = spawnNpc(w, 'lurker', x, y)
  e.ai!.guard = true // as populate spawns it
  return e
}

describe('dormancy: the parked ambush', () => {
  it('stays INERT while nothing trips it — no movement, no aggro, for a long while', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 30.5, 20.5) // ~20 tiles off: outside every trigger
    const lurk = lurkerAt(w, 10.5, 10.5)
    const at = { x: lurk.pos.x, y: lurk.pos.y }
    run(w, 300)
    expect(lurk.ai!.dormant).toBe(true)
    expect(dist(lurk.pos, at)).toBeLessThan(0.01)
    expect(lurk.ai!.targetId).toBeUndefined()
    void player
  })

  it('a player straying CLOSE trips it: woke(proximity), instant aggro, the burst closes fast', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 12.8, 10.5) // inside WAKE_PROXIMITY_RANGE? no — 2.3 tiles: yes
    player.health!.iframes = 0
    const lurk = lurkerAt(w, 10.5, 10.5)
    const events = run(w, 10)
    const woke = events.find((ev) => ev.type === 'woke' && ev.entityId === lurk.id)
    expect(woke).toMatchObject({ type: 'woke', by: 'proximity' })
    expect(lurk.ai!.dormant).toBe(false)
    run(w, 50)
    expect(lurk.ai!.mode).toBe('aggro')
    expect(lurk.ai!.targetId).toBe(player.id)
    expect(dist(lurk.pos, player.pos)).toBeLessThan(1.6) // it POUNCED (knife reach)
    expect(player.health!.hp).toBeLessThan(player.health!.max) // and drew blood
  })

  it('its door OPENING trips it even with the player at arm’s length beyond proximity', () => {
    const w = arena()
    spawnPlayer(w, 0, 20.5, 10.5) // outside proximity (10 tiles), will "open" remotely
    const lurk = lurkerAt(w, 10.5, 10.5)
    const door = makeEntity('door', 'door', 13.5, 10.5, 0.5) // within WAKE_DOOR_RANGE (4)
    door.door = { open: false, locked: false, lockLevel: 0 }
    addEntity(w, door)
    run(w, 60)
    expect(lurk.ai!.dormant).toBe(true) // a CLOSED door wakes nothing
    door.door!.open = true
    const events = run(w, 10)
    expect(events.find((ev) => ev.type === 'woke' && ev.entityId === lurk.id)).toMatchObject({ by: 'door' })
    expect(lurk.ai!.dormant).toBe(false)
  })

  it('a hit trips it (no free pot-shots at a sleeping body)', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 25.5, 10.5)
    const lurk = lurkerAt(w, 10.5, 10.5)
    applyDamage(w, lurk, 3, player.pos.x, player.pos.y, 0, player.id)
    const events = run(w, 10)
    expect(events.find((ev) => ev.type === 'woke' && ev.entityId === lurk.id)).toMatchObject({ by: 'damage' })
  })

  it('the pounce COMMITS: even badly wounded it keeps charging (no flee flip-flop)', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 13.5, 10.5)
    player.health!.iframes = 0
    const lurk = lurkerAt(w, 10.5, 10.5)
    lurk.health!.hp = 4 // nearly dead — a `basic` brain would flee at this hp
    run(w, 60)
    expect(lurk.ai!.dormant).toBe(false)
    expect(lurk.ai!.mode).toBe('aggro') // never broke off
    expect(dist(lurk.pos, player.pos)).toBeLessThan(2)
  })

  it('prey retreats out of reach → the lurker parks again instead of wandering the floor', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 12.8, 10.5)
    const lurk = lurkerAt(w, 10.5, 10.5)
    run(w, 30)
    expect(lurk.ai!.dormant).toBe(false)
    // The player blinks far away — outside sight and pounce range for good.
    player.pos = { x: 38.5, y: 28.5 }
    player.prevPos = { x: 38.5, y: 28.5 }
    run(w, 400)
    const parked = { x: lurk.pos.x, y: lurk.pos.y }
    run(w, 120)
    expect(dist(lurk.pos, parked)).toBeLessThan(0.6) // guard: parked, not ambling
  })
})

describe('populate seeding', () => {
  const lurkers = (w: World): Entity[] => w.entities.filter((e) => e.archetype === 'lurker')

  it('floor 1 is always lurker-free (the gentle floor stays gentle)', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const w = createWorld(seed, 1)
      populateWorld(w)
      expect(lurkers(w)).toHaveLength(0)
    }
  })

  it('deeper floors seed dormant lurkers in preferred back rooms, wall-hugging, off the guard band', () => {
    let saw = 0
    for (let seed = 1; seed <= 20; seed++) {
      for (let floor = 2; floor <= 4; floor++) {
        const w = createWorld(seed, floor)
        populateWorld(w)
        for (const l of lurkers(w)) {
          saw++
          expect(l.ai!.dormant).toBe(true)
          expect(l.ai!.guard).toBe(true)
          const tx = Math.floor(l.pos.x)
          const ty = Math.floor(l.pos.y)
          const b = w.level.buildings[l.ai!.zone!.building]
          const ri = roomOwningTile(b.rooms, tx, ty)
          expect(ri).toBeGreaterThanOrEqual(0)
          if (b.role === 'bunker') expect(ri).not.toBe(0) // never the patrol band
          const types = b.roomTypes ?? assignRoomTypes(b)
          expect(['stockroom', 'guardpost', 'bathroom', 'storage']).toContain(types[ri])
          // Wall-hugging: at least one orthogonal wall neighbour.
          const walls = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ].filter(([dx, dy]) => isWallTile(tileAt(w.level, tx + dx, ty + dy))).length
          expect(walls).toBeGreaterThanOrEqual(1)
        }
      }
    }
    expect(saw).toBeGreaterThan(0) // the haunting genuinely happens in the wild
  })

  it('seeding is deterministic and the whole floor evolves byte-identically', () => {
    // Find a seeded lurker floor, then prove two populates + runs agree.
    for (let seed = 1; seed <= 20; seed++) {
      const w = createWorld(seed, 3)
      populateWorld(w)
      if (lurkers(w).length === 0) continue
      const a = createWorld(seed, 3)
      populateWorld(a)
      const b = createWorld(seed, 3)
      populateWorld(b)
      run(a, 150)
      run(b, 150)
      expect(serializeWorld(a)).toEqual(serializeWorld(b))
      return
    }
    throw new Error('no lurker floor found in seed bound')
  })
})
