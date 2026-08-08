// The lockpick affordance view-model: what the player SEES while picking.
// This is the fix for the silent 1.5s stare — prompt before, ring during,
// toast on break — asserted for both the host path (exact channel on self)
// and the net-client path (event-tracked estimate).

import { describe, expect, it } from 'vitest'
import type { RenderView } from '../app/session'
import { makeEntity, type Entity } from '../game/entity'
import { generateLevel } from '../game/levelgen/generate'
import type { SimEvent } from '../game/types'
import { createPickTracker, promptText } from './pickModel'

const level = generateLevel(1, 1)

const player = (id: number, x: number, y: number): Entity => {
  const e = makeEntity('player', 'player', x, y)
  e.id = id
  e.playerCtl = { playerId: 0, abilityCooldown: 0, crimeUntilTick: 0 }
  e.loadout = { inventory: [], activeSlot: -1 }
  return e
}

const lockedDoor = (id: number, x: number, y: number, lockLevel = 2): Entity => {
  const e = makeEntity('door', 'door', x, y, 0.5)
  e.id = id
  e.door = { open: false, locked: true, lockLevel }
  e.interact = { verb: 'open', range: 1.3 }
  return e
}

const view = (over: Partial<RenderView>): RenderView => ({
  entities: [],
  events: [],
  tick: 0,
  level,
  floor: 1,
  missionText: '',
  missionComplete: false,
  gameOver: false,
  ...over,
})

describe('pick prompt (before committing)', () => {
  it('standing near a locked door shows the lock level and pick time; far away shows nothing', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    const near = t.update(view({ entities: [self, door], self }))
    expect(near.prompt).toEqual({ doorId: 2, x: 10.8, y: 10, text: 'Lock II · Use to pick (3.5s)' })
    expect(near.ring).toBeUndefined()
    self.pos.x = 20 // walked away
    expect(t.update(view({ entities: [self, door], self, tick: 1 })).prompt).toBeUndefined()
  })

  it('an unlocked or open door prompts nothing (the USE label handles those)', () => {
    const self = player(1, 10, 10)
    const closed = lockedDoor(2, 10.8, 10)
    closed.door!.locked = false
    const t = createPickTracker()
    expect(t.update(view({ entities: [self, closed], self })).prompt).toBeUndefined()
  })

  it('prompt text covers every lock level and clamps degenerate ones', () => {
    expect(promptText(1)).toBe('Lock I · Use to pick (2.0s)')
    expect(promptText(3)).toBe('Lock III · Use to pick (5.0s)')
    expect(promptText(0)).toBe('Lock I · Use to pick (2.0s)') // clamped, never "Lock 0"
    expect(promptText(99)).toBe('Lock III · Use to pick (5.0s)')
  })
})

describe('progress ring — host path (exact channel on self)', () => {
  it('reads progress straight off the channel and suppresses the prompt while picking', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    self.playerCtl!.channel = { kind: 'lockpick', targetId: 2, ticksLeft: 45, total: 60 }
    const t = createPickTracker()
    const ui = t.update(view({ entities: [self, door], self }))
    expect(ui.ring).toEqual({ doorId: 2, x: 10.8, y: 10, progress: 0.25 })
    expect(ui.prompt).toBeUndefined()
  })

  it('ADVERSARIAL: a channel whose door vanished from the view draws no ring and does not crash', () => {
    const self = player(1, 10, 10)
    self.playerCtl!.channel = { kind: 'lockpick', targetId: 999, ticksLeft: 30, total: 60 }
    const t = createPickTracker()
    expect(t.update(view({ entities: [self], self })).ring).toBeUndefined()
  })
})

describe('progress ring — net-client path (event-tracked)', () => {
  it('pickStart for SELF opens an estimated ring that advances by tick and clears on doorToggle', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    const start: SimEvent[] = [{ type: 'pickStart', entityId: 2, byId: 1, ticks: 60 }]
    expect(t.update(view({ entities: [self, door], self, tick: 100, events: start })).ring?.progress).toBe(0)
    const mid = t.update(view({ entities: [self, door], self, tick: 130 }))
    expect(mid.ring?.progress).toBeCloseTo(0.5, 5)
    // completion arrives as the authoritative doorToggle
    door.door!.open = true
    const done = t.update(
      view({ entities: [self, door], self, tick: 160, events: [{ type: 'doorToggle', entityId: 2, open: true }] }),
    )
    expect(done.ring).toBeUndefined()
  })

  it("someone ELSE's pickStart draws nothing on my screen", () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    const ui = t.update(
      view({ entities: [self, door], self, tick: 5, events: [{ type: 'pickStart', entityId: 2, byId: 77, ticks: 60 }] }),
    )
    expect(ui.ring).toBeUndefined()
  })

  it('the estimate never shows full: it clamps shy of 1 until the real doorToggle lands', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    t.update(view({ entities: [self, door], self, tick: 0, events: [{ type: 'pickStart', entityId: 2, byId: 1, ticks: 60 }] }))
    const late = t.update(view({ entities: [self, door], self, tick: 500 }))
    expect(late.ring?.progress).toBeLessThan(1)
  })
})

describe('cancel toast — a broken pick is never silent', () => {
  it('pickCancel(moved) raises a fading toast at the door, which expires after its window', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    const cancel: SimEvent[] = [{ type: 'pickCancel', entityId: 2, byId: 1, reason: 'moved' }]
    // walk away in the same beat, so no prompt/ring muddies the assertion
    self.pos.x = 20
    const ui = t.update(view({ entities: [self, door], self, tick: 10, events: cancel }))
    expect(ui.toast?.text).toBe('Pick broken — stand still!')
    expect(ui.toast?.life).toBeCloseTo(1, 1)
    const later = t.update(view({ entities: [self, door], self, tick: 40 }))
    expect(later.toast?.life).toBeCloseTo(0.5, 1)
    expect(t.update(view({ entities: [self, door], self, tick: 71 })).toast).toBeUndefined()
  })

  it('pickCancel(hurt) names the cause; pickCancel(gone) stays silent (the door just opened)', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    const hurt = t.update(
      view({ entities: [self, door], self, tick: 1, events: [{ type: 'pickCancel', entityId: 2, byId: 1, reason: 'hurt' }] }),
    )
    expect(hurt.toast?.text).toBe('Pick broken — you got hit!')
    const t2 = createPickTracker()
    const gone = t2.update(
      view({ entities: [self, door], self, tick: 1, events: [{ type: 'pickCancel', entityId: 2, byId: 1, reason: 'gone' }] }),
    )
    expect(gone.toast).toBeUndefined()
  })

  it('ADVERSARIAL: events are consumed once per tick — re-rendering the same tick does not restart the toast', () => {
    const self = player(1, 10, 10)
    const door = lockedDoor(2, 10.8, 10)
    const t = createPickTracker()
    const cancel: SimEvent[] = [{ type: 'pickCancel', entityId: 2, byId: 1, reason: 'moved' }]
    t.update(view({ entities: [self, door], self, tick: 10, events: cancel }))
    t.update(view({ entities: [self, door], self, tick: 10, events: cancel })) // second frame, same tick
    const later = t.update(view({ entities: [self, door], self, tick: 69 }))
    expect(later.toast).toBeDefined() // still the ORIGINAL toast...
    expect(t.update(view({ entities: [self, door], self, tick: 71 })).toast).toBeUndefined() // ...on schedule
  })
})
