import { describe, expect, it } from 'vitest'
import { HUNT_FIRST, tideFlooded, TIDE_FLOOD, TIDE_PERIOD } from '../game/floorModifiers'
import { spawnPlayer } from '../game/player'
import { createWorld, tickWorld } from '../game/world'
import { runVerb, WRITE_VERBS } from './verbs'

describe('modifier verb', () => {
  it('is a write verb (deferred onto the sim step)', () => {
    expect(WRITE_VERBS.has('modifier')).toBe(true)
  })

  it('reads null on a clean floor, forces a kind, and clears it', () => {
    const w = createWorld(1, 2)
    w.tick = 500
    expect(runVerb(w, 'modifier')).toBe('null')
    expect(JSON.parse(runVerb(w, 'modifier brownout'))).toEqual({ kind: 'brownout', since: 500 })
    expect(w.events).toContainEqual({ type: 'floorModifier', kind: 'brownout' })
    expect(runVerb(w, 'modifier none')).toBe('null')
    expect(w.modifier).toBeUndefined()
  })

  it('ages the floor so a flood or a hunt can be staged right now', () => {
    const w = createWorld(1, 2)
    w.tick = 1000
    runVerb(w, `modifier bogTide ${TIDE_PERIOD - TIDE_FLOOD}`)
    expect(tideFlooded(w.modifier, w.tick)).toBe(true)
    runVerb(w, `modifier hunted ${HUNT_FIRST}`)
    expect(w.modifier!.huntAt).toBe(w.tick)
  })

  it('a staged hunt really lands through the real systems', () => {
    const w = createWorld(4, 2)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    runVerb(w, `modifier hunted ${HUNT_FIRST}`)
    tickWorld(w, new Map())
    expect(w.groups?.list.some((g) => g.tracker)).toBe(true)
  })

  it('rejects unknown kinds and bad ages loudly', () => {
    const w = createWorld(1, 2)
    expect(() => runVerb(w, 'modifier lava')).toThrow(/usage/)
    expect(() => runVerb(w, 'modifier bogTide -5')).toThrow(/usage/)
    expect(() => runVerb(w, 'modifier bogTide soon')).toThrow(/usage/)
    expect(() => runVerb(w, 'modifier bogTide 1.5')).toThrow(/usage/)
    expect(w.modifier).toBeUndefined()
  })
})
