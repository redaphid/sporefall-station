// The `theme` verb: a presentation-only hook — it must dispatch to the injected
// renderer callback and NEVER touch world state (determinism guard).

import { describe, expect, it } from 'vitest'
import { serializeWorld } from '../game/serialize'
import { createWorld, type World } from '../game/world'
import { runVerb, WRITE_VERBS } from './verbs'

const world = (): World => createWorld(1234, 1)

describe('theme verb', () => {
  it('dispatches the id to ctx.setTheme', () => {
    const w = world()
    const seen: string[] = []
    const reply = runVerb(w, 'theme swamp', { setTheme: (id) => seen.push(id) })
    expect(seen).toEqual(['swamp'])
    expect(JSON.parse(reply)).toEqual({ theme: 'swamp', status: 'switching' })
  })

  it('never touches world state (byte-identical before/after)', () => {
    const w = world()
    const before = JSON.stringify(serializeWorld(w))
    runVerb(w, 'theme test', { setTheme: () => {} })
    expect(JSON.stringify(serializeWorld(w))).toBe(before)
  })

  it('is not a write verb (runs immediately, no sim-step deferral)', () => {
    expect(WRITE_VERBS.has('theme')).toBe(false)
  })

  it('reports unavailability in headless contexts (no renderer hook)', () => {
    expect(() => runVerb(world(), 'theme swamp')).toThrow(/unavailable/)
  })

  it('rejects missing, extra, and malformed ids', () => {
    const setTheme = (): void => {}
    expect(() => runVerb(world(), 'theme', { setTheme })).toThrow(/usage/)
    expect(() => runVerb(world(), 'theme a b', { setTheme })).toThrow(/usage/)
    expect(() => runVerb(world(), 'theme ../x', { setTheme })).toThrow(/invalid/)
    expect(() => runVerb(world(), 'theme Swamp', { setTheme })).toThrow(/invalid/)
  })

  it('works through the `command` escape hatch', () => {
    const seen: string[] = []
    runVerb(world(), 'command theme city', { setTheme: (id) => seen.push(id) })
    expect(seen).toEqual(['city'])
  })
})
