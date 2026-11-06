// The renderer's event log (eventLog.ts): every recent sim tick's events, kept
// past the per-tick wipe of world.events, for consumers that skip ticks.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { runTicks, walledRoom, worldFromRows } from '../game/testkit'
import type { SimEvent } from '../game/types'
import { createEventLog, EVENT_LOG_TICKS } from './eventLog'

const noise = (x: number): SimEvent => ({ type: 'noise', x, y: 0 })

describe('event log', () => {
  it('keeps each tick`s events after the sim wipes world.events', () => {
    const w = worldFromRows(walledRoom(20, 10), { seed: 5 })
    const p = spawnPlayer(w, 0, 5.5, 5.5)
    spawnNpc(w, 'mutant', 9.5, 5.5)
    const log = createEventLog()
    const seen: { tick: number; types: string[] }[] = []
    for (let i = 0; i < 60; i++) {
      runTicks(w, new Map([[0, { attack: true, aimX: 1, aimY: 0 }]]), 1)
      if (w.events.length > 0) seen.push({ tick: w.tick, types: w.events.map((e) => e.type) })
      log.afterTick(w.tick, w.events)
    }
    expect(p.dead).toBeFalsy()
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(log.entries.map((e) => ({ tick: e.tick, types: e.events.map((x) => x.type) }))).toEqual(seen)
  })

  it('copies the events: wiping or refilling the source array changes nothing logged', () => {
    const log = createEventLog()
    const events = [noise(1)]
    log.afterTick(1, events)
    events.length = 0
    events.push(noise(2))
    expect(log.entries).toEqual([{ tick: 1, events: [noise(1)] }])
  })

  it('a tick with no events adds no entry', () => {
    const log = createEventLog()
    log.afterTick(1, [])
    log.afterTick(2, [noise(2)])
    log.afterTick(3, [])
    expect(log.entries.map((e) => e.tick)).toEqual([2])
  })

  it('afterTick ignores a repeat of the newest tick (a paused host calls it every frame)', () => {
    const log = createEventLog()
    const events = [noise(1)]
    for (let i = 0; i < 100; i++) log.afterTick(7, events)
    expect(log.entries).toEqual([{ tick: 7, events: [noise(1)] }])
  })

  it('frame appends: two client frames on one tick both land', () => {
    const log = createEventLog()
    log.frame(4, [noise(1)])
    log.frame(4, [noise(2)])
    log.frame(5, [noise(3)])
    expect(log.entries).toEqual([
      { tick: 4, events: [noise(1)] },
      { tick: 4, events: [noise(2)] },
      { tick: 5, events: [noise(3)] },
    ])
  })

  it(`keeps exactly the last ${EVENT_LOG_TICKS} ticks`, () => {
    const log = createEventLog()
    for (let t = 1; t <= 200; t++) log.afterTick(t, [noise(t)])
    expect(log.entries.map((e) => e.tick)).toEqual(Array.from({ length: EVENT_LOG_TICKS }, (_, k) => 200 - EVENT_LOG_TICKS + 1 + k))
  })

  it('a tick earlier than the newest (restart, rewind) starts the log over', () => {
    const log = createEventLog()
    for (let t = 1; t <= 10; t++) log.afterTick(t, [noise(t)])
    log.afterTick(3, [noise(-3)])
    expect(log.entries).toEqual([{ tick: 3, events: [noise(-3)] }])
    log.frame(1, [noise(-1)])
    expect(log.entries).toEqual([{ tick: 1, events: [noise(-1)] }])
  })
})
