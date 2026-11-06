// Event-sourced one-shot starts in the tracker (animTracker.EVENT_STARTS,
// eventStarts, trackAnim's `fromEvents`), against real sim events and a real
// lobber: which events map to which start, on whom, over which ticks, and when
// an event start is allowed to win.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { walledRoom, worldFromRows } from '../game/testkit'
import type { SimEvent } from '../game/types'
import { ANIM_STATE_DEFS, STATE_TICKS, type AnimStateName } from './animState'
import { fakeArt } from './animTestkit'
import { EVENT_STARTS, eventStarts, trackAnim, type AnimMemory } from './animTracker'
import { EntityViews } from './sprites'

const lob = (entityId: number): SimEvent => ({ type: 'lob', entityId, x: 0, y: 0, tx: 1, ty: 1, ticks: 30 })
const bud = (entityId: number, byId: number): SimEvent => ({ type: 'hiveSpawn', entityId, byId })
const sprout = (entityId: number, byId: number): SimEvent => ({ type: 'hiveSpread', entityId, byId, x: 0, y: 0 })

describe('EVENT_STARTS', () => {
  it('maps lob, hiveSpawn and hiveSpread to attack, and every row starts a one-shot', () => {
    expect(Object.keys(EVENT_STARTS).sort()).toEqual(['hiveSpawn', 'hiveSpread', 'lob'])
    for (const row of Object.values(EVENT_STARTS)) {
      expect(row.state).toBe('attack')
      expect(ANIM_STATE_DEFS[row.state].play).toBe('once')
    }
  })
})

describe('eventStarts', () => {
  const log = [
    { tick: 10, events: [lob(1), { type: 'noise', x: 0, y: 0 } as SimEvent] },
    { tick: 11, events: [bud(50, 2)] },
    { tick: 12, events: [sprout(51, 2), lob(1)] },
    { tick: 14, events: [lob(3)] },
  ]

  it('takes ticks after `after` up to and including `upTo`', () => {
    expect([...eventStarts(log, 10, 12)].sort()).toEqual([
      [1, { attack: 12 }],
      [2, { attack: 12 }],
    ])
    expect([...eventStarts(log, 9, 10)]).toEqual([[1, { attack: 10 }]])
    expect([...eventStarts(log, 12, 13)]).toEqual([])
    expect([...eventStarts(log, 13, 14)]).toEqual([[3, { attack: 14 }]])
  })

  it('the hive spire acts, not the bud or sprout it names as entityId', () => {
    const m = eventStarts(log, 10, 11)
    expect(m.get(2)).toEqual({ attack: 11 })
    expect(m.has(50)).toBe(false)
    expect(eventStarts(log, 11, 12).has(51)).toBe(false)
  })

  it('the latest event in the span wins', () => {
    expect(eventStarts(log, 0, 20).get(1)).toEqual({ attack: 12 })
  })

  it('events no row names start nothing', () => {
    expect(eventStarts([{ tick: 1, events: [{ type: 'noise', x: 0, y: 0 }, { type: 'death', x: 0, y: 0, entityId: 1 } as SimEvent] }], 0, 1).size).toBe(0)
  })
})

describe('trackAnim with event starts, on a real lobber', () => {
  const lobber = () => spawnNpc(worldFromRows(walledRoom(12, 8), { seed: 3 }), 'lobber', 5.5, 4.5)
  const DRAWN: Partial<Record<AnimStateName, number>> = { attack: 16 }

  it('a lob starts the drawn clip on the lob tick, seen late or not', () => {
    const e = lobber()
    const mem: AnimMemory = {}
    trackAnim(mem, e, 100, DRAWN)
    // The lob was on tick 101; this frame is the first to see it, at 104.
    expect(trackAnim(mem, e, 104, DRAWN, { attack: 101 })).toEqual({ state: 'attack', start: 101 })
    expect(trackAnim(mem, e, 116, DRAWN).state).toBe('attack')
    expect(trackAnim(mem, e, 117, DRAWN).state).not.toBe('attack')
  })

  it('without attack frames a lob starts nothing: the body shows what it did before', () => {
    const e = lobber()
    const mem: AnimMemory = {}
    expect(trackAnim(mem, e, 104, {}, { attack: 101 }).state).not.toBe('attack')
    expect(trackAnim(mem, e, 101 + STATE_TICKS.attack - 1, {}).state).not.toBe('attack')
  })

  it('a later cooldown swing keeps its own start over an older lob, and a newer lob replaces an older one', () => {
    const e = lobber()
    const mem: AnimMemory = {}
    trackAnim(mem, e, 100, DRAWN)
    e.combat!.cooldown = 20 // the fists swing on tick 103
    expect(trackAnim(mem, e, 103, DRAWN, { attack: 101 }).start).toBe(103)
    expect(trackAnim(mem, e, 125, DRAWN, { attack: 124 }).start).toBe(124)
  })

  it('a stale event start never overrides a newer one handed in later', () => {
    const e = lobber()
    const mem: AnimMemory = {}
    trackAnim(mem, e, 110, DRAWN, { attack: 108 })
    expect(trackAnim(mem, e, 111, DRAWN, { attack: 102 }).start).toBe(108)
  })

  it('ADVERSARIAL: an event start in the future (a rewound tracker) is ignored, not shown early', () => {
    const e = lobber()
    const mem: AnimMemory = {}
    trackAnim(mem, e, 200, DRAWN, { attack: 200 })
    expect(trackAnim(mem, e, 150, DRAWN).state).not.toBe('attack')
    // ...and it does not hide a real swing observed meanwhile.
    e.combat!.cooldown = 20
    expect(trackAnim(mem, e, 151, DRAWN)).toEqual({ state: 'attack', start: 151 })
  })
})

describe('EntityViews reads each logged tick once, and only from the floor it is on', () => {
  interface Internals {
    views: Map<number, { sprite: { texture: { label?: string } } }>
  }
  const label = (v: EntityViews, id: number): string | undefined => (v as unknown as Internals).views.get(id)?.sprite.texture.label

  it('a floor change does not replay the old floor`s events on a body that reuses an id', () => {
    const w = worldFromRows(walledRoom(12, 8), { seed: 3 })
    const e = spawnNpc(w, 'lobber', 5.5, 4.5)
    const views = new EntityViews(fakeArt({ lobber: { attack: 8 } }))
    const log = [{ tick: 11, events: [lob(e.id)] }]
    views.update(w.entities, 0, 10, 1, [])
    views.update(w.entities, 0, 12, 2, log) // a new floor; tick 11 was the old one's
    expect(label(views, e.id)).not.toMatch(/attack/)
    views.update(w.entities, 0, 13, 2, [...log, { tick: 13, events: [lob(e.id)] }])
    expect(label(views, e.id)).toMatch(/attack\.0$/)
  })

  it('on the same floor the ticks between two updates are all read', () => {
    const w = worldFromRows(walledRoom(12, 8), { seed: 3 })
    const e = spawnNpc(w, 'lobber', 5.5, 4.5)
    const views = new EntityViews(fakeArt({ lobber: { attack: 8 } }))
    views.update(w.entities, 0, 10, 1, [])
    views.update(w.entities, 0, 14, 1, [{ tick: 11, events: [lob(e.id)] }])
    expect(label(views, e.id)).toMatch(/attack\.1$/) // (14 - 11) / tpf 2
  })
})
