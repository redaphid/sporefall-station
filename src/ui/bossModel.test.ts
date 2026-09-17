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
/** The name RESOLVER the model now takes (archetype → display name). In the app
 * this is `themeDisplayName`; here it stands in for the swampspace pack, which
 * names `boss` "Mireclaw Alpha" and `vigil` "The Vigil". */
const THEMED: Record<string, string> = { boss: NAME, vigil: 'The Vigil' }
const name = (archetype: string): string => THEMED[archetype] ?? archetype

const bossEntity = (id: number, hp: number, max = 320): Entity => {
  const e = makeEntity('npc', 'boss', 5, 5)
  e.id = id
  e.health = { hp, max, iframes: 0 }
  return e
}
/** A SECOND boss archetype — the thing the old hardcoded model could not draw. */
const vigilEntity = (id: number, hp: number, max = 300): Entity => {
  const e = makeEntity('npc', 'vigil', 5, 5)
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
    expect(bossRevealName(view([bossEntity(1, 320)], [reveal(1)]), name)).toBe(NAME)
    expect(bossRevealName(view([bossEntity(1, 320)]), name)).toBeUndefined()
    expect(bossRevealName(view([bossEntity(1, 320)], [{ type: 'floorChange', floor: 2 }]), name)).toBeUndefined()
  })

  it('names the boss that was ACTUALLY revealed, not a hardcoded Mireclaw', () => {
    // The regression this generalisation exists to prevent: `ui/screens.ts`
    // called `themeDisplayName('boss')`, so every boss entrance card in the
    // game would have read "MIRECLAW ALPHA" regardless of what walked in.
    const v = view([vigilEntity(3, 300)], [reveal(3)])
    expect(bossRevealName(v, name)).toBe('The Vigil')
  })

  it('degrades to the default boss name when the reveal outruns the snapshot', () => {
    // A BLE client can see the event before the entity arrives in a snapshot.
    // An entrance card with no name is worse than a slightly wrong one.
    expect(bossRevealName(view([], [reveal(9)]), name)).toBe(NAME)
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
    expect(bossBar(view([bossEntity(1, 320)]), undefined, name)).toBeNull()
  })

  it('reports name, fraction and phase once latched', () => {
    const bar = bossBar(view([bossEntity(1, 320)]), 1, name)
    expect(bar).toEqual({
      name: NAME,
      hpFrac: 1,
      hp: 320,
      maxHp: 320,
      phase: 1,
      phaseLabel: 'SUMMONING BROOD',
      danger: false,
    })
  })

  it('phase 2 names the counterplay out loud — the regen was previously invisible', () => {
    expect(bossBar(view([bossEntity(1, 128)]), 1, name)?.phaseLabel).toBe('REGENERATING — BURN THE SPORES')
  })

  it('phase 3 reads ENRAGED', () => {
    expect(bossBar(view([bossEntity(1, 32)]), 1, name)?.phaseLabel).toBe('ENRAGED')
  })

  it('drops the bar the instant the boss dies', () => {
    const dead = bossEntity(1, 0)
    dead.dead = true
    expect(bossBar(view([dead]), 1, name)).toBeNull()
  })

  it('drops the bar at 0 hp even before the death flag lands', () => {
    expect(bossBar(view([bossEntity(1, 0)]), 1, name)).toBeNull()
  })

  it('drops the bar if the latched entity left the world (floor swap, desync)', () => {
    expect(bossBar(view([]), 1, name)).toBeNull()
  })

  it('survives a boss with no health component rather than throwing', () => {
    const e = makeEntity('npc', 'boss', 5, 5)
    e.id = 1
    expect(bossBar(view([e]), 1, name)).toBeNull()
  })

  it('clamps overheal — a regenerating Alpha never overflows the bar', () => {
    expect(bossBar(view([bossEntity(1, 400, 320)]), 1, name)?.hpFrac).toBe(1)
  })

  it('ignores a max of 0 instead of dividing by zero', () => {
    expect(bossBar(view([bossEntity(1, 10, 0)]), 1, name)).toBeNull()
  })

  it('picks the LATCHED boss, not merely the first boss-looking entity', () => {
    const other = bossEntity(9, 320)
    const mine = bossEntity(1, 160)
    expect(bossBar(view([other, mine]), 1, name)?.hp).toBe(160)
  })
})

// ── design/boss-variety.md §3.2: the HUD was hardcoded to Mireclaw ──────────
// Everything above pins that Mireclaw's bar is UNCHANGED by the generalisation.
// Everything below pins that a second boss can now exist at all.
describe('a SECOND boss wears its own identity', () => {
  it('shows the Vigil’s name and the Vigil’s phase label, never Mireclaw’s', () => {
    const bar = bossBar(view([vigilEntity(1, 300)]), 1, name)
    expect(bar?.name).toBe('The Vigil')
    expect(bar?.phaseLabel).toBe('VULNERABLE ONLY ASLEEP — BE QUIET')
  })

  it('resolves the phase table from the boss’s OWN archetype, at its own thresholds', () => {
    // The same hp FRACTION on two bosses must read differently. 0.2 is Mireclaw's
    // enrage line; on the Vigil it is that boss's own final band. Before this,
    // one global ladder answered for every boss in the game.
    expect(bossBar(view([vigilEntity(1, 60, 300)]), 1, name)?.phaseLabel).toBe('NEARLY SILENCED — FINISH IT')
    expect(bossBar(view([bossEntity(1, 64, 320)]), 1, name)?.phaseLabel).toBe('ENRAGED')
  })

  it('supports a boss with a DIFFERENT NUMBER of phases', () => {
    // The old model returned a `1 | 2 | 3` union off one global ladder, so a
    // two-phase boss was not merely mislabelled — it was unrepresentable.
    expect(bossBar(view([vigilEntity(1, 300)]), 1, name)?.phase).toBe(1)
    expect(bossBar(view([vigilEntity(1, 60, 300)]), 1, name)?.phase).toBe(2)
  })

  it('danger is per-boss DATA, not the hardcoded “phase === 3”', () => {
    expect(bossBar(view([bossEntity(1, 320)]), 1, name)?.danger).toBe(false)
    expect(bossBar(view([bossEntity(1, 32)]), 1, name)?.danger).toBe(true) // enraged
    // The Vigil declares NO danger band: a low health bar means you have been
    // quiet long enough, which is the opposite of "this is going badly". Its
    // final phase must therefore NOT recolour the bar — something `phase === 3`
    // decided globally and got wrong for every boss but one.
    const nearlyDead = bossBar(view([vigilEntity(1, 60, 300)]), 1, name)
    expect(nearlyDead?.phase).toBe(2)
    expect(nearlyDead?.danger).toBe(false)
  })

  it('an UNREGISTERED archetype degrades to the reference table instead of throwing', () => {
    // The latched id comes off an event, which on a BLE client is whatever that
    // phone's bundle decoded. A wrong label beats a crashed HUD.
    const e = makeEntity('npc', 'mysterious.new.boss', 5, 5)
    e.id = 1
    e.health = { hp: 50, max: 100, iframes: 0 }
    const bar = bossBar(view([e]), 1, name)
    expect(bar).not.toBeNull()
    expect(bar?.phaseLabel).toBe('REGENERATING — BURN THE SPORES')
  })

  it('passes the ARCHETYPE to the resolver, so theme packs name each boss themselves', () => {
    const seen: string[] = []
    bossBar(view([vigilEntity(1, 300)]), 1, (a) => {
      seen.push(a)
      return a
    })
    expect(seen).toEqual(['vigil']) // emphatically not 'boss'
  })
})
