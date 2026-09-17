// The boss bar is the whole point of the fix: the owner cleared ~6 boss floors
// without noticing a boss, because nothing on screen ever said one was there.
// These tests pin the three properties that make it trustworthy — it appears
// only after the entrance, it survives the boss breaking line of sight, and it
// disappears the instant the boss dies.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../game/entity'
import { MIRECLAW_ENRAGE_FRAC, MIRECLAW_RETREAT_FRAC } from '../game/systems/behaviors'
import type { SimEvent } from '../game/types'
import { bossBar, bossPhase, bossRevealName, latchBossId } from './bossModel'

const NAME = 'Mireclaw Alpha'

const bossEntity = (id: number, hp: number, max = 320): Entity => {
  const e = makeEntity('npc', 'boss', 5, 5)
  e.id = id
  e.health = { hp, max, iframes: 0 }
  return e
}
const view = (entities: Entity[], events: SimEvent[] = []) => ({ entities, events })
const reveal = (entityId: number, maxHp = 320): SimEvent => ({ type: 'bossReveal', entityId, x: 5, y: 5, maxHp })

describe('latchBossId', () => {
  it('starts empty — no bar before the Alpha has been seen', () => {
    expect(latchBossId(undefined, [])).toBeUndefined()
  })

  it('latches the revealed boss', () => {
    expect(latchBossId(undefined, [reveal(42)])).toBe(42)
  })

  it('HOLDS the latch across frames with no events — the boss stepping behind a wall must not drop the bar', () => {
    expect(latchBossId(42, [])).toBe(42)
    expect(latchBossId(42, [{ type: 'noise', x: 1, y: 1 }])).toBe(42)
  })

  it('clears on a floor change — the next floor announces its own Alpha', () => {
    expect(latchBossId(42, [{ type: 'floorChange', floor: 6 }])).toBeUndefined()
  })

  it('a reveal AFTER a floor change in the same frame still latches (order is respected)', () => {
    expect(latchBossId(42, [{ type: 'floorChange', floor: 6 }, reveal(77)])).toBe(77)
  })

  it('a floor change AFTER a reveal in the same frame wins', () => {
    expect(latchBossId(undefined, [reveal(77), { type: 'floorChange', floor: 6 }])).toBeUndefined()
  })
})

describe('bossRevealName', () => {
  it('returns the themed name on the frame the entrance fires, and nothing otherwise', () => {
    expect(bossRevealName([reveal(1)], NAME)).toBe(NAME)
    expect(bossRevealName([], NAME)).toBeUndefined()
    expect(bossRevealName([{ type: 'floorChange', floor: 2 }], NAME)).toBeUndefined()
  })
})

describe('bossPhase', () => {
  it('maps HP fraction onto the SAME bands the sim runs on', () => {
    expect(bossPhase(1)).toBe(1)
    expect(bossPhase(MIRECLAW_RETREAT_FRAC + 0.01)).toBe(1)
    expect(bossPhase(MIRECLAW_RETREAT_FRAC)).toBe(2) // boundary belongs to the wounded band
    expect(bossPhase(MIRECLAW_ENRAGE_FRAC + 0.01)).toBe(2)
    expect(bossPhase(MIRECLAW_ENRAGE_FRAC)).toBe(3)
    expect(bossPhase(0)).toBe(3)
  })
})

describe('bossBar', () => {
  it('draws nothing until a boss has been revealed', () => {
    expect(bossBar(view([bossEntity(1, 320)]), undefined, NAME)).toBeNull()
  })

  it('reports name, fraction and phase once latched', () => {
    const bar = bossBar(view([bossEntity(1, 320)]), 1, NAME)
    expect(bar).toEqual({ name: NAME, hpFrac: 1, hp: 320, maxHp: 320, phase: 1, phaseLabel: 'SUMMONING BROOD' })
  })

  it('phase 2 names the counterplay out loud — the regen was previously invisible', () => {
    expect(bossBar(view([bossEntity(1, 128)]), 1, NAME)?.phaseLabel).toBe('REGENERATING — BURN THE SPORES')
  })

  it('phase 3 reads ENRAGED', () => {
    expect(bossBar(view([bossEntity(1, 32)]), 1, NAME)?.phaseLabel).toBe('ENRAGED')
  })

  it('drops the bar the instant the boss dies', () => {
    const dead = bossEntity(1, 0)
    dead.dead = true
    expect(bossBar(view([dead]), 1, NAME)).toBeNull()
  })

  it('drops the bar at 0 hp even before the death flag lands', () => {
    expect(bossBar(view([bossEntity(1, 0)]), 1, NAME)).toBeNull()
  })

  it('drops the bar if the latched entity left the world (floor swap, desync)', () => {
    expect(bossBar(view([]), 1, NAME)).toBeNull()
  })

  it('survives a boss with no health component rather than throwing', () => {
    const e = makeEntity('npc', 'boss', 5, 5)
    e.id = 1
    expect(bossBar(view([e]), 1, NAME)).toBeNull()
  })

  it('clamps overheal — a regenerating Alpha never overflows the bar', () => {
    expect(bossBar(view([bossEntity(1, 400, 320)]), 1, NAME)?.hpFrac).toBe(1)
  })

  it('ignores a max of 0 instead of dividing by zero', () => {
    expect(bossBar(view([bossEntity(1, 10, 0)]), 1, NAME)).toBeNull()
  })

  it('picks the LATCHED boss, not merely the first boss-looking entity', () => {
    const other = bossEntity(9, 320)
    const mine = bossEntity(1, 160)
    expect(bossBar(view([other, mine]), 1, NAME)?.hp).toBe(160)
  })
})
