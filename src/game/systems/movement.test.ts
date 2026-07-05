import { describe, expect, it } from 'vitest'
import { makeEntity } from '../entity'
import { moveAndCollide } from './movement'

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
