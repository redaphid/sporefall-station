import { describe, it, expect, vi } from 'vitest'
import { pickNewSeed } from './newSeed'
import { createPersister, SAVE_KEY, type KeyValueStore } from './persistence'
import { createWorld } from '../game/world'

describe('pickNewSeed', () => {
  it('returns a 32-bit seed different from the current one', () => {
    const seed = pickNewSeed(12345, () => 0.42)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).not.toBe(12345)
  })

  it('never equals current even when rand keeps colliding, then nudges', () => {
    // rand always maps to `current` → the retry loop exhausts and falls back.
    const current = 1000
    const collide = () => current / 0xffffffff
    expect(pickNewSeed(current, collide)).not.toBe(current)
  })

  it('is different from current across many draws', () => {
    let n = 0
    const rand = () => (n++ % 97) / 97
    for (let c = 0; c < 200; c++) expect(pickNewSeed(c, rand)).not.toBe(c)
  })

  it('uses the injected source (deterministic given rand)', () => {
    const rand = vi.fn(() => 0.5)
    const a = pickNewSeed(1, rand)
    const b = pickNewSeed(1, rand)
    expect(a).toBe(b)
    expect(rand).toHaveBeenCalled()
  })
})

describe('new-seed restart clears the saved run', () => {
  it('clearing the persister wipes the save slot so the old run is not resumed', () => {
    const map = new Map<string, string>()
    const store: KeyValueStore = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    }
    const persister = createPersister(store, { intervalTicks: 1, now: () => 0 })
    // A run is in progress and saved.
    const world = createWorld(pickNewSeed(0, () => 0.1), 1, 'normal')
    world.tick = 5
    persister.maybeSave(world)
    expect(map.has(SAVE_KEY)).toBe(true)
    // New-seed path clears the save (same call the restart wiring makes).
    persister.clear()
    expect(map.has(SAVE_KEY)).toBe(false)
  })
})
