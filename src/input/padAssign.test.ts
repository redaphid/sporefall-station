import { describe, it, expect } from 'vitest'
import { assignPads } from './padAssign'

describe('assignPads', () => {
  describe('press-to-join', () => {
    it('gives the first joining pad slot 0', () => {
      const r = assignPads(new Map(), [3], [3])
      expect(r.assignments.get(3)).toBe(0)
    })
    it('emits a join event for it', () => {
      const r = assignPads(new Map(), [3], [3])
      expect(r.events).toContainEqual({ type: 'join', padIndex: 3, slot: 0 })
    })
    it('gives a second joining pad the next slot', () => {
      const prev = new Map([[3, 0]])
      const r = assignPads(prev, [3, 5], [5])
      expect(r.assignments.get(5)).toBe(1)
    })
    it('does not re-join a pad that is already assigned', () => {
      const prev = new Map([[3, 0]])
      const r = assignPads(prev, [3], [3])
      expect(r.events).toHaveLength(0)
    })
    it('leaves a connected but silent pad unassigned', () => {
      const r = assignPads(new Map(), [3], [])
      expect(r.assignments.size).toBe(0)
    })
  })

  describe('hotplug', () => {
    it('drops the assignment when a pad disconnects', () => {
      const prev = new Map([[3, 0]])
      const r = assignPads(prev, [], [])
      expect(r.assignments.has(3)).toBe(false)
    })
    it('emits a leave event carrying the freed slot', () => {
      const prev = new Map([[3, 0]])
      const r = assignPads(prev, [], [])
      expect(r.events).toContainEqual({ type: 'leave', padIndex: 3, slot: 0 })
    })
    it('reuses the lowest freed slot for a new joiner', () => {
      const prev = new Map([
        [3, 0],
        [5, 1],
      ])
      // pad 3 (slot 0) unplugged; a fresh pad 7 presses to join
      const r = assignPads(prev, [5, 7], [7])
      expect(r.assignments.get(7)).toBe(0)
    })
    it('keeps a surviving pad on its slot across the reshuffle', () => {
      const prev = new Map([
        [3, 0],
        [5, 1],
      ])
      const r = assignPads(prev, [5, 7], [7])
      expect(r.assignments.get(5)).toBe(1)
    })
  })
})
