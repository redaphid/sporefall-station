import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { moveAndCollide, movementSystem } from './movement'

const makePlayer = (w: World): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', 20, 20))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.speed = 4.5
  e.playerCtl = { playerId: 0, classId: 'soldier', abilityCooldown: 0, inventory: [], activeSlot: -1, cash: 0, crimeUntilTick: 0 }
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
