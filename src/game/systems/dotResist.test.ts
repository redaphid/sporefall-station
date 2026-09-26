// #131. A resist scales damage over time and never rounds it away. elementSystem
// used to deal Math.round(dot × resist) each damage tick, so a cinder (burning 0.2,
// "resistant, NOT immune") took round(0.4) = 0 and was immune in practice. Each
// status now carries what it owes between damage ticks, so over any window a
// body takes the exact damage rounded up: never less than resist × the
// unresisted damage, never a whole point more, and 0 only at resist 0. Whole-
// number cases are untouched. Every case runs the real tick (runTicks), which
// also fails any fractional hp.

import { describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import { NPCS } from '../data/npcs'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import type { InputCmd } from '../types'
import { createWorld, type World } from '../world'
import { igniteCell } from './fire'
import { applyStatus, hasStatus } from './statusFx'

const idle = new Map<number, Partial<InputCmd>>()
const DOTS = Object.values(ELEMENTS).filter((d) => d.dot > 0)

/** A rooted, unkillable body of `archetype` near the spawn tile. */
const body = (w: World, archetype: string, dx = 0): Entity => {
  const e = spawnNpc(w, archetype, w.level.spawn.x + dx, w.level.spawn.y)
  e.ai!.guard = true
  e.health = { hp: 100_000, max: 100_000, iframes: 0 }
  return e
}

/** The `hit` amounts `e` took this tick. */
const hitsOn = (w: World, e: Entity): number[] =>
  w.events.flatMap((ev) => (ev.type === 'hit' && ev.targetId === e.id ? [ev.amount] : []))

/** Every hit `archetype` takes from `kind`, applied once for `ticks` on tick 0,
 * alone in a fresh world, until the status wears off. `resist` replaces its
 * roster table. A thug with no override is the unresisted reference. */
const dotHits = (archetype: string, kind: string, ticks: number, resist?: number): number[] => {
  const w = createWorld(1, 1)
  const e = body(w, archetype)
  if (resist !== undefined) e.resist = { [kind]: resist }
  applyStatus(w, e, kind, ticks)
  const hits: number[] = []
  while (hasStatus(e, kind)) {
    runTicks(w, idle, 1)
    hits.push(...hitsOn(w, e))
  }
  return hits
}
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

/** What a body with `resist` must take where an unresisted one takes `neutral`:
 * the exact share, rounded up. The epsilon keeps float dust in the product
 * (0.3 × 10 is 3.0000000000000004) from rounding a whole share up. */
const share = (resist: number, neutral: number): number => Math.ceil(resist * neutral - 1e-9)

describe('a resist scales damage over time instead of rounding it away', () => {
  it('a cinder takes about 20% of what a thug takes from the same burn', () => {
    expect(NPCS.cinder.resist?.burning).toBe(0.2)
    const thug = sum(dotHits('thug', 'burning', ELEMENTS.burning.durationTicks))
    const cinder = sum(dotHits('cinder', 'burning', ELEMENTS.burning.durationTicks))
    expect(thug).toBeGreaterThan(100)
    expect(cinder).toBe(share(0.2, thug))
  })

  it('standing in fire re-lights the burn every tick without forgetting what it owes', () => {
    const w = createWorld(1, 1)
    const thug = body(w, 'thug')
    const cinder = body(w, 'cinder', 1)
    let thugLost = 0
    let cinderLost = 0
    for (let t = 0; t < 300; t++) {
      applyStatus(w, thug, 'burning', ELEMENTS.burning.durationTicks)
      applyStatus(w, cinder, 'burning', ELEMENTS.burning.durationTicks)
      runTicks(w, idle, 1)
      thugLost += sum(hitsOn(w, thug))
      cinderLost += sum(hitsOn(w, cinder))
    }
    expect(cinderLost).toBe(share(0.2, thugLost))
  })

  const rosterRows = Object.values(NPCS).flatMap((def) =>
    DOTS.filter((d) => def.resist?.[d.id] !== undefined).map((d) => [def.archetype, d.id, def.resist![d.id]] as const),
  )
  it.each(rosterRows)('%s under %s (resist %s) takes resist × the full-duration damage', (archetype, kind, resist) => {
    const neutral = sum(dotHits('thug', kind, ELEMENTS[kind].durationTicks))
    const hits = dotHits(archetype, kind, ELEMENTS[kind].durationTicks)
    if (resist === 0) {
      expect(hits).toEqual([])
      return
    }
    expect(sum(hits)).toBe(share(resist, neutral))
  })

  // A status applied on tick 0 for (n - 1) intervals lands n damage ticks.
  const wholeShares = [
    ['burning', 0.2, 10],
    ['burning', 0.35, 20],
    ['poisoned', 0.3, 10],
    ['poisoned', 0.7, 10],
    ['spore', 0.1, 30],
  ] as const
  it.each(wholeShares)('%s at resist %s over %s damage ticks deals exactly its whole share', (kind, resist, n) => {
    const ticks = (n - 1) * ELEMENTS[kind].interval
    const neutral = sum(dotHits('thug', kind, ticks))
    expect(neutral).toBe(n * ELEMENTS[kind].dot)
    expect(sum(dotHits('thug', kind, ticks, resist))).toBe(share(resist, neutral))
  })

  const tiny = [1e-9, 0.001, 0.01, 0.1, 0.2, 0.25, 0.3, 0.49]
  it.each(DOTS.flatMap((d) => tiny.map((r) => [d.id, r] as const)))(
    '%s at resist %s still deals damage inside one damage interval',
    (kind, resist) => {
      expect(sum(dotHits('thug', kind, ELEMENTS[kind].interval, resist))).toBeGreaterThanOrEqual(1)
    },
  )

  it.each(DOTS.map((d) => d.id))('%s at resist 0 deals nothing over its full duration', (kind) => {
    expect(sum(dotHits('thug', kind, ELEMENTS[kind].durationTicks))).toBeGreaterThan(0)
    expect(dotHits('thug', kind, ELEMENTS[kind].durationTicks, 0)).toEqual([])
  })

  const whole = DOTS.flatMap((d) =>
    [0.5, 1, 1.5, 2, 3].filter((r) => Number.isInteger(d.dot * r)).map((r) => [d.id, r] as const),
  )
  it.each(whole)('%s at resist %s hits for exactly dot × resist every time, as before', (kind, resist) => {
    const w = createWorld(1, 1)
    const e = body(w, 'thug')
    e.resist = { [kind]: resist }
    applyStatus(w, e, kind, ELEMENTS[kind].durationTicks)
    const entry = { ...e.fx![kind] }
    const hits: number[] = []
    while (hasStatus(e, kind)) {
      runTicks(w, idle, 1)
      hits.push(...hitsOn(w, e))
      // Nothing is owed between whole hits, so the entry snapshots as it always did.
      if (hasStatus(e, kind)) expect(e.fx![kind]).toEqual(entry)
    }
    expect(hits.length).toBeGreaterThan(0)
    expect(new Set(hits)).toEqual(new Set([ELEMENTS[kind].dot * resist]))
  })
})

describe('damage over time is deterministic', () => {
  it('a mid-burn serialize round-trip continues byte-identically', () => {
    const stage = (): World => {
      const w = createWorld(1, 1)
      applyStatus(w, body(w, 'thug'), 'burning', 240)
      applyStatus(w, body(w, 'cinder', 1), 'burning', 240)
      applyStatus(w, body(w, 'sporeling', 2), 'poisoned', 120)
      const p = spawnPlayer(w, 0, w.level.spawn.x + 3, w.level.spawn.y)
      p.health!.iframes = 0
      igniteCell(w, Math.floor(p.pos.x), Math.floor(p.pos.y))
      return w
    }
    // By tick 10 the cinder has taken 1 hp against 0.8 owed, so its burn holds
    // a fraction when the snapshot is taken.
    const a = runTicks(stage(), idle, 10)
    const snap = serializeWorld(a)
    runTicks(a, idle, 300)
    const b = runTicks(deserializeWorld(snap), idle, 300)
    expectWorldEqual(a, b)
    expectWorldEqual(a, runTicks(stage(), idle, 310))
  })
})
