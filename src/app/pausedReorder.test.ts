// A reorder made in the pause menu must survive the pause. The session keeps
// sampling its local input while paused (the pad's Start and the keyboard's
// buffered taps are read and dropped), so the swap queue must not hand a swap
// to a command the paused sim throws away. The swap waits in the queue, the
// pause menu previews it from there, and the first tick after Resume applies
// it through the real sim.

import { describe, expect, it } from 'vitest'
import { weaponStack } from '../game/systems/inventory'
import { emptyInput } from '../game/types'
import { createModSwapQueue, previewSwaps, withModSwaps } from '../input/modSwapQueue'
import { HostSession } from './hostSession'

const order = (s: HostSession): string[] => weaponStack(s.self)!.mods!.map((m) => m.id)

const pausedSession = () => {
  const queue = createModSwapQueue()
  const live: { session?: HostSession } = {}
  const input = withModSwaps({ sample: emptyInput }, queue, () => !(live.session?.isPaused ?? false))
  const s = new HostSession(11, input)
  live.session = s
  weaponStack(s.self)!.mods = [{ id: 'frost', stacks: 1 }, { id: 'heavy', stacks: 1 }, { id: 'shock', stacks: 1 }]
  s.isPaused = true
  return { s, queue }
}

describe('reordering from the pause menu', () => {
  it('a swap queued while paused is still queued after paused ticks, and the sim is untouched', () => {
    const { s, queue } = pausedSession()
    queue.push(0, 2)
    for (let i = 0; i < 30; i++) s.tick()
    expect(queue.pending()).toEqual([{ a: 0, b: 2 }])
    expect(order(s)).toEqual(['frost', 'heavy', 'shock'])
    expect(previewSwaps(order(s), queue.pending())).toEqual(['shock', 'heavy', 'frost'])
  })

  it('the first tick after Resume applies it, and a second queued swap applies on the tick after', () => {
    const { s, queue } = pausedSession()
    queue.push(0, 2)
    queue.push(1, 2)
    for (let i = 0; i < 5; i++) s.tick()
    s.isPaused = false
    s.tick()
    expect(order(s)).toEqual(['shock', 'heavy', 'frost'])
    s.tick()
    expect(order(s)).toEqual(['shock', 'frost', 'heavy'])
    expect(queue.pending()).toEqual([])
  })

  it('a swap queued during play rides the next command, as before', () => {
    const { s, queue } = pausedSession()
    s.isPaused = false
    queue.push(0, 1)
    s.tick()
    expect(order(s)).toEqual(['heavy', 'frost', 'shock'])
  })
})
