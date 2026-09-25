// The boss bar is the whole point of the fix: the owner cleared ~6 boss floors
// without noticing a boss, because nothing on screen ever said one was there.
// These tests pin the three properties that make it trustworthy — it appears
// only after the entrance, it survives the boss breaking line of sight, and it
// disappears the instant the boss dies.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../game/entity'
import { MIRECLAW_ENRAGE_FRAC, MIRECLAW_RETREAT_FRAC } from '../game/systems/behaviors'
import type { SimEvent } from '../game/types'
import { bossBar, bossPhase, bossRevealName, isRunReset, latchBossId, playerOutOfFight } from './bossModel'

const NAME = 'Mireclaw Alpha'

const bossEntity = (id: number, hp: number, max = 320): Entity => {
  const e = makeEntity('npc', 'boss', 5, 5)
  e.id = id
  e.health = { hp, max, iframes: 0 }
  return e
}
/** A local player entity — alive and standing unless told otherwise. */
const player = (over: { dead?: boolean; downed?: boolean } = {}): Entity => {
  const e = makeEntity('player', 'player', 1, 1)
  e.dead = over.dead
  e.playerCtl = {
    playerId: 0,
    ...(over.downed ? { downed: { bleedTicks: 900, reviveProgress: 0 } } : {}),
  } as Entity['playerCtl']
  return e
}
const view = (entities: Entity[], events: SimEvent[] = []) => ({ entities, events, self: player() })
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

// ---------------------------------------------------------------------------
// The reported bug: "I still see the boss health bar when I die."
//
// The bar was gated ONLY on the boss being alive, never on the player. A boss
// at full HP is still very much alive when it kills you, so the bar stayed up —
// and because the HUD carries z-index:66 while the restart overlay carries
// none, it painted on TOP of the YOU DIED scrim rather than behind it.
// ---------------------------------------------------------------------------

describe('playerOutOfFight — the local player is no longer playing', () => {
  it('is false during ordinary play', () => {
    expect(playerOutOfFight({ entities: [], events: [], self: player() })).toBe(false)
  })

  it('is true when the local player is DEAD', () => {
    expect(playerOutOfFight({ entities: [], events: [], self: player({ dead: true }) })).toBe(true)
  })

  it('is true when the local player is DOWNED (bleeding out)', () => {
    expect(playerOutOfFight({ entities: [], events: [], self: player({ downed: true }) })).toBe(true)
  })

  it('is true at game-over even if self still looks alive', () => {
    expect(playerOutOfFight({ entities: [], events: [], self: player(), gameOver: true })).toBe(true)
  })

  it('is false with no self at all — a spectator frame is not a death screen', () => {
    expect(playerOutOfFight({ entities: [], events: [] })).toBe(false)
  })
})

describe('bossBar hides while the player is out of the fight', () => {
  const liveBoss = () => [bossEntity(1, 320)]

  it('REGRESSION: a healthy boss draws NO bar once the local player is dead', () => {
    const v = { entities: liveBoss(), events: [], self: player({ dead: true }) }
    expect(bossBar(v, 1, NAME)).toBeNull()
  })

  it('draws no bar while the local player is downed and bleeding out', () => {
    const v = { entities: liveBoss(), events: [], self: player({ downed: true }) }
    expect(bossBar(v, 1, NAME)).toBeNull()
  })

  it('draws no bar at game-over', () => {
    const v = { entities: liveBoss(), events: [], self: player(), gameOver: true }
    expect(bossBar(v, 1, NAME)).toBeNull()
  })

  it('control: the SAME boss and latch DO draw a bar while the player is up', () => {
    const v = { entities: liveBoss(), events: [], self: player() }
    expect(bossBar(v, 1, NAME)?.hp).toBe(320)
  })

  it('comes back on a revive — the gate is not a one-way latch', () => {
    const down = { entities: liveBoss(), events: [], self: player({ downed: true }) }
    expect(bossBar(down, 1, NAME)).toBeNull()
    const up = { entities: liveBoss(), events: [], self: player() }
    expect(bossBar(up, 1, NAME)?.hp).toBe(320)
  })

  it('player and boss dying on the SAME frame still yields no bar', () => {
    const dead = bossEntity(1, 0)
    dead.dead = true
    const v = { entities: [dead], events: [], self: player({ dead: true }) }
    expect(bossBar(v, 1, NAME)).toBeNull()
  })
})

describe('isRunReset — "Run it back" must not carry the latch into a new world', () => {
  it('is false on the first frame we have ever seen', () => {
    expect(isRunReset(undefined, 0)).toBe(false)
    expect(isRunReset(undefined, 5000)).toBe(false)
  })

  it('is false while the tick advances normally', () => {
    expect(isRunReset(10, 11)).toBe(false)
    expect(isRunReset(10, 10)).toBe(false) // a repeated frame is not a new run
  })

  it('is TRUE when the tick goes backwards — the world was rebuilt in place', () => {
    expect(isRunReset(5000, 0)).toBe(true)
    expect(isRunReset(1, 0)).toBe(true)
  })
})
