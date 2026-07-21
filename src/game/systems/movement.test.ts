import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { moveAndCollide, movementSystem } from './movement'

const makePlayer = (w: World): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', 20, 20))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.speed = 4.5
  e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

const run = (w: World, cmd: InputCmd): void => movementSystem(w, new Map([[0, cmd]]))

// 5x5 map: walls on the border, open 3x3 in the middle.
const blocked = (tx: number, ty: number): boolean => tx < 1 || ty < 1 || tx > 3 || ty > 3

describe('moveAndCollide', () => {
  it('moves freely in open space', () => {
    const e = makeEntity('player', 'test', 2, 2)
    moveAndCollide(e, 0.5, 0.3, blocked)
    expect(e.pos.x).toBeCloseTo(2.5)
    expect(e.pos.y).toBeCloseTo(2.3)
  })

  it('stops at walls and snaps flush', () => {
    const e = makeEntity('player', 'test', 2, 2, 0.35)
    moveAndCollide(e, 10, 0, blocked)
    // Right wall starts at x=4; circle edge should rest just inside it.
    expect(e.pos.x).toBeLessThanOrEqual(4 - 0.35)
    expect(e.pos.x).toBeGreaterThan(3.6 - 0.01)
    expect(e.pos.y).toBe(2)
  })

  it('slides along a wall when moving diagonally into it', () => {
    const e = makeEntity('player', 'test', 3.5, 2, 0.35)
    moveAndCollide(e, 0.5, 0.5, blocked)
    // X is blocked (wall at x=4), Y should still advance.
    expect(e.pos.y).toBeCloseTo(2.5)
    expect(e.pos.x).toBeLessThanOrEqual(4 - 0.35)
  })

  it('never tunnels through walls even with a huge step', () => {
    const e = makeEntity('player', 'test', 2, 2, 0.35)
    moveAndCollide(e, 100, 0, blocked)
    moveAndCollide(e, 0, 100, blocked)
    moveAndCollide(e, -100, 0, blocked)
    moveAndCollide(e, 0, -100, blocked)
    expect(e.pos.x).toBeGreaterThanOrEqual(1)
    expect(e.pos.x).toBeLessThanOrEqual(4)
    expect(e.pos.y).toBeGreaterThanOrEqual(1)
    expect(e.pos.y).toBeLessThanOrEqual(4)
  })
})

describe('movementSystem facing (twin-stick aim)', () => {
  it('faces the aim vector independently of the movement direction', () => {
    const w = createWorld(1, 1)
    const e = makePlayer(w)
    // Walk right, aim up: facing must follow aim (up), not movement (right).
    run(w, { ...emptyInput(), moveX: 1, moveY: 0, aimX: 0, aimY: -1 })
    expect(e.facing).toBeCloseTo(-Math.PI / 2)
  })

  it('falls back to movement direction when aim mirrors movement', () => {
    const w = createWorld(1, 1)
    const e = makePlayer(w)
    run(w, { ...emptyInput(), moveX: -1, moveY: 0, aimX: -1, aimY: 0 })
    expect(e.facing).toBeCloseTo(Math.PI)
  })

  it('holds the last facing when aim is centred (0,0)', () => {
    const w = createWorld(1, 1)
    const e = makePlayer(w)
    run(w, { ...emptyInput(), moveX: 0, moveY: 1, aimX: 0, aimY: 1 })
    const faced = e.facing
    // Now move with a centred aim: facing must not snap away.
    run(w, { ...emptyInput(), moveX: 1, moveY: 0, aimX: 0, aimY: 0 })
    expect(e.facing).toBeCloseTo(faced)
  })
})

// Collision now consults a per-tick closed-door index instead of scanning every
// entity for a door on each probed tile (the old doorClosedAt path was O(n²) and
// dominated the frame as the crowd grew — the stuck-walk/laggy-controls
// regression). These lock in that the index blocks EXACTLY like the old scan.
describe('movementSystem — closed doors block collision (per-tick door index)', () => {
  // A fully-open level so ONLY the door can stop the player (isolates the door
  // path from level walls).
  const openWorld = (): World => {
    const w = createWorld(1, 1)
    w.level.solid = new Uint8Array(w.level.w * w.level.h)
    return w
  }
  const doorAt = (w: World, tx: number, ty: number, open: boolean): Entity => {
    const d = addEntity(w, makeEntity('door', 'door.wood', tx + 0.5, ty + 0.5))
    d.door = { open, locked: false, lockLevel: 0 }
    return d
  }

  it('stops a player walking into a CLOSED door', () => {
    const w = openWorld()
    const e = makePlayer(w)
    e.pos.x = 20.5
    e.pos.y = 20.5
    e.radius = 0.3
    doorAt(w, 22, 20, false) // closed door two tiles to the right
    for (let i = 0; i < 20; i++) run(w, { ...emptyInput(), moveX: 1 })
    expect(e.pos.x).toBeLessThan(22) // circle edge rests outside the door tile
  })

  it('lets the player pass once the same door is OPEN', () => {
    const w = openWorld()
    const e = makePlayer(w)
    e.pos.x = 20.5
    e.pos.y = 20.5
    e.radius = 0.3
    doorAt(w, 22, 20, true) // open — no obstruction
    for (let i = 0; i < 20; i++) run(w, { ...emptyInput(), moveX: 1 })
    expect(e.pos.x).toBeGreaterThan(22) // walked through the doorway
  })

  it('a dead/removed door no longer blocks (index excludes dead doors)', () => {
    const w = openWorld()
    const e = makePlayer(w)
    e.pos.x = 20.5
    e.pos.y = 20.5
    e.radius = 0.3
    const d = doorAt(w, 22, 20, false)
    d.dead = true // e.g. blasted open
    for (let i = 0; i < 20; i++) run(w, { ...emptyInput(), moveX: 1 })
    expect(e.pos.x).toBeGreaterThan(22)
  })
})

// Performance regression guard for the O(n²) collision door-scan. The fixed code
// runs this in well under a millisecond; the regressed full-entity-scan-per-tile
// path was ~40-90× slower and scaled quadratically with the crowd, blowing the
// 33ms tick budget on mobile. A deliberately loose absolute budget with a huge
// margin over the fixed cost — it exists to catch a reintroduced O(n²) scan, not
// to microbenchmark, so it will not false-fail on a slow CI box.
describe('movementSystem — collision cost stays bounded with a large crowd + many doors', () => {
  it('300 movers and 40 closed doors tick cheaply (guards against the O(n²) door scan)', () => {
    const w = createWorld(7, 1)
    w.level.solid = new Uint8Array(w.level.w * w.level.h)
    const inputs = new Map<number, InputCmd>()
    // 40 closed doors scattered across the field.
    for (let i = 0; i < 40; i++) {
      const d = addEntity(w, makeEntity('door', 'door.wood', 5 + (i % 20) + 0.5, 5 + Math.floor(i / 20) * 3 + 0.5))
      d.door = { open: false, locked: false, lockLevel: 0 }
    }
    // 300 moving NPCs, each with a live move intent so the collision path runs.
    for (let i = 0; i < 300; i++) {
      const n = addEntity(w, makeEntity('npc', 'thug', 10 + (i % 30) * 0.7, 10 + Math.floor(i / 30) * 0.7, 0.3))
      n.speed = 3
      n.intent = { x: 1, y: 0 }
    }
    // Warm, then time a batch of full movement ticks.
    for (let i = 0; i < 20; i++) movementSystem(w, inputs)
    const N = 60
    const t0 = performance.now()
    for (let i = 0; i < N; i++) movementSystem(w, inputs)
    const per = (performance.now() - t0) / N
    // Fixed cost is ~0.1-0.5ms here; the regressed O(n²) scan was many ms. 8ms is
    // a ~20-40× safety margin over the fixed path, far under the 33.3ms budget.
    expect(per).toBeLessThan(8)
  })
})
