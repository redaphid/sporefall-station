// Degenerate cases for damage over time (#130, #131) that dotRegen.test.ts and
// dotResist.test.ts leave open: a body that dies mid-DoT, two elements landing
// on the same tick, a negative resist, an immune player resting in flames, and
// a save that crosses JSON text while a burn holds a fraction.

import { describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import type { InputCmd } from '../types'
import { createWorld, type World } from '../world'
import { REGEN_CALM_TICKS } from './regen'
import { applyStatus } from './statusFx'

const none = new Map<number, Partial<InputCmd>>()
const idle = new Map<number, Partial<InputCmd>>([[0, {}]])

/** A rooted thug near the spawn tile with `hp` and `resist`. */
const body = (w: World, hp: number, resist: Record<string, number>, dx = 0): Entity => {
  const e = spawnNpc(w, 'thug', w.level.spawn.x + dx, w.level.spawn.y)
  e.ai!.guard = true
  e.health = { hp, max: hp, iframes: 0 }
  e.resist = resist
  return e
}

type Beat = { tick: number; type: 'hit' | 'death'; amount?: number }

/** Every hit and death `e` takes over `n` ticks, stamped with the tick it landed on. */
const beats = (w: World, e: Entity, n: number, inputs = none): Beat[] => {
  const out: Beat[] = []
  for (let i = 0; i < n; i++) {
    const tick = w.tick
    runTicks(w, inputs, 1)
    for (const ev of w.events) {
      if (ev.type === 'hit' && ev.targetId === e.id) out.push({ tick, type: 'hit', amount: ev.amount })
      if (ev.type === 'death' && ev.entityId === e.id) out.push({ tick, type: 'death' })
    }
  }
  return out
}

describe('death during damage over time', () => {
  it('a resisted burn kills on the tick its owed hp comes due, once', () => {
    // burning 0.2 owes 0.4 a damage tick: pay 1 on tick 0, nothing on 9, 1 on 18.
    const w = createWorld(1, 1)
    const e = body(w, 2, { burning: 0.2 })
    applyStatus(w, e, 'burning', ELEMENTS.burning.durationTicks)
    expect(beats(w, e, 60)).toEqual([
      { tick: 0, type: 'hit', amount: 1 },
      { tick: 18, type: 'hit', amount: 1 },
      { tick: 18, type: 'death' },
    ])
    expect(e.dead).toBe(true)
    expect(w.byId.has(e.id)).toBe(false)
  })

  it('two elements due on the same tick: the first kills, the second never lands', () => {
    // Tick 0 is a damage tick for every element, so burning and poison both come due.
    const w = createWorld(1, 1)
    const e = body(w, 1, { burning: 0.2, poisoned: 0.2 })
    applyStatus(w, e, 'burning', 600)
    applyStatus(w, e, 'poisoned', 600)
    expect(beats(w, e, 30)).toEqual([
      { tick: 0, type: 'hit', amount: 1 },
      { tick: 0, type: 'death' },
    ])
    expect(e.health!.hp).toBe(0)
  })

  it('a downed player takes no DoT and banks nothing while down', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    p.resist = { burning: 0.2 }
    p.health!.hp = 1
    applyStatus(w, p, 'burning', ELEMENTS.burning.durationTicks)
    expect(beats(w, p, 1, idle)).toEqual([
      { tick: 0, type: 'hit', amount: 1 },
      { tick: 0, type: 'death' },
    ])
    expect(p.playerCtl!.downed).toBeTruthy()
    const entry = p.fx?.burning ? { ...p.fx.burning } : undefined
    expect(beats(w, p, 60, idle)).toEqual([])
    expect(p.fx?.burning).toEqual(entry)
  })
})

describe('resists outside (0, ∞)', () => {
  it('a negative resist neither heals nor banks a debt', () => {
    const w = createWorld(1, 1)
    const e = body(w, 50, { burning: -1, poisoned: -0.3, spore: -2 })
    e.health!.hp = 40
    for (const kind of ['burning', 'poisoned', 'spore']) applyStatus(w, e, kind, 300)
    expect(beats(w, e, 300)).toEqual([])
    expect(e.health).toEqual({ hp: 40, max: 50, iframes: 0 })
    expect(Object.values(e.fx ?? {}).filter((s) => s.prepaidMicroHp !== undefined)).toEqual([])
  })

  it('an immune player resting in flames is never hurt, so regen keeps healing', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    p.health!.iframes = 0
    p.health!.hp = 60
    p.resist = { burning: 0 }
    applyStatus(w, p, 'burning', ELEMENTS.burning.durationTicks)
    expect(beats(w, p, REGEN_CALM_TICKS + 30, idle)).toEqual([])
    expect(p.fx?.burning).toBeDefined()
    expect(p.health!.lastHurtTick).toBeUndefined()
    expect(p.health!.hp).toBeGreaterThan(60)
  })
})

describe('two resisted elements at once', () => {
  it('each status owes its own share, so the total is each share rounded up', () => {
    const w = createWorld(1, 1)
    const control = body(w, 100_000, {})
    const subject = body(w, 100_000, { burning: 0.3, poisoned: 0.3 }, 1)
    for (const e of [control, subject]) {
      applyStatus(w, e, 'burning', 300)
      applyStatus(w, e, 'poisoned', 300)
    }
    runTicks(w, none, 310)
    const burnLost = 100_000 - control.health!.hp
    expect(burnLost).toBeGreaterThan(0)
    // Unresisted: burning 2 × 34 damage ticks + poison 1 × 21 = 89 over 300 ticks.
    expect(burnLost).toBe(2 * 34 + 21)
    expect(100_000 - subject.health!.hp).toBe(Math.ceil(0.3 * 68 - 1e-9) + Math.ceil(0.3 * 21 - 1e-9))
  })
})

describe('the owed fraction across a save', () => {
  it('a mid-burn save through JSON text carries the fraction and resumes in lockstep', () => {
    const w = createWorld(1, 1)
    const e = body(w, 100_000, { burning: 0.2 })
    applyStatus(w, e, 'burning', 300)
    runTicks(w, none, 10)
    const text = JSON.stringify(serializeWorld(w))
    const saved = JSON.parse(text).entities.find((j: { id: number }) => j.id === e.id)
    expect(saved.fx.burning.prepaidMicroHp).toBeGreaterThan(0)

    const loaded = deserializeWorld(JSON.parse(text))
    runTicks(w, none, 300)
    runTicks(loaded, none, 300)
    expectWorldEqual(loaded, w)
    // 34 damage ticks owe 0.4 each: 13.6, paid as 14.
    expect(100_000 - e.health!.hp).toBe(14)
  })
})
