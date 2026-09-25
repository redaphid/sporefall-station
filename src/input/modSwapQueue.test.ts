import { describe, expect, it } from 'vitest'
import { packModSwap } from '../game/systems/modSequence'
import { emptyInput } from '../game/types'
import { createModSwapQueue, previewSwaps, withModSwaps } from './modSwapQueue'

describe('mod swap queue', () => {
  it('hands out one swap per sampled command, oldest first, then leaves commands untouched', () => {
    const q = createModSwapQueue()
    q.push(0, 2)
    q.push(1, 3)
    const src = withModSwaps({ sample: () => emptyInput() }, q)
    expect(src.sample().modSwap).toBe(packModSwap(0, 2))
    expect(src.sample().modSwap).toBe(packModSwap(1, 3))
    expect('modSwap' in src.sample()).toBe(false)
  })

  it('rejects nonsense requests and bounds the backlog', () => {
    const q = createModSwapQueue()
    for (const [a, b] of [[1, 1], [-1, 2], [0, 300], [0.5, 1]]) q.push(a, b)
    expect(q.pending()).toHaveLength(0)
    for (let i = 0; i < 40; i++) q.push(0, 1)
    expect(q.pending()).toHaveLength(16)
  })

  it('previewSwaps applies swaps in order and skips out-of-range ones', () => {
    expect(previewSwaps(['a', 'b', 'c'], [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 0, b: 9 }])).toEqual(['b', 'c', 'a'])
  })
})
