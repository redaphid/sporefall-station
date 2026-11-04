import { describe, expect, it, vi } from 'vitest'

// ai.ts builds these tables at module load from goal codes, and ai.ts sits on
// import cycles through world.ts. If the first module of a graph is one that
// reaches ai.ts mid-cycle, the codes are not yet initialized: vitest hands back
// undefined, native ESM throws. Each case loads a fresh module graph from a
// different entry, so a table built too early shows up as `undefined` here.
const ENTRIES = ['./behaviors', './goals', './groups', './ai', '../world', '../populate', '../serialize']

describe.each(ENTRIES)('ai goal tables when %s loads first', (entry) => {
  const load = async (): Promise<typeof import('./ai')> => {
    vi.resetModules()
    await import(/* @vite-ignore */ entry)
    return import('./ai')
  }

  it('TACTICAL is the nine group placement goals', async () => {
    const { TACTICAL } = await load()
    expect([...TACTICAL]).toEqual(['formup', 'flank', 'stage', 'guard', 'emplace', 'breach', 'fallback', 'tend', 'ring'])
  })

  it('GROUP_MOVES is the seven group-layer moves', async () => {
    const { GROUP_MOVES } = await load()
    expect([...GROUP_MOVES]).toEqual(['stage', 'guard', 'emplace', 'breach', 'fallback', 'tend', 'ring'])
  })

  it('NOTABLE_GOALS is the six event-worthy goals', async () => {
    const { NOTABLE_GOALS } = await load()
    expect([...NOTABLE_GOALS]).toEqual(['battle', 'pursue', 'flee', 'alert', 'search', 'scavenge'])
  })
})
