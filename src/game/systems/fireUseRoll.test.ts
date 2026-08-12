// Feature: FIRE and USE are now cleanly separated. The player has ONE permanent
// weapon, so there is nothing for FIRE to arbitrate:
//  FIRE (attack): ALWAYS fires/swings the weapon. Never uses the held item,
//    never rolls. (Overloading FIRE onto the held item would let a player
//    holding a grenade become permanently unable to shoot.)
//  USE (throwItem): use the held/active usable item; nothing usable → dodge-roll.
// Tests set state exactly, run the REAL systems (combatSystem / tickWorld), and
// assert — adversarial cases included (cooldown gating, full-HP waste, co-op).

import { beforeEach, describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { combatSystem } from './combat'
import { ROLL_COOLDOWN, ROLL_TICKS } from './roll'

/** A one-slot input map with `attack` (the fire button) pressed. */
const fire = (extra: Partial<InputCmd> = {}): Map<number, InputCmd> =>
  new Map([[0, { ...emptyInput(), attack: true, ...extra }]])

/** A one-slot input map with `throwItem` (the use button) pressed. */
const use = (extra: Partial<InputCmd> = {}): Map<number, InputCmd> =>
  new Map([[0, { ...emptyInput(), throwItem: true, ...extra }]])

/** A player on the guaranteed-open spawn tile, facing +x. */
const player = (w: World, id = 0): Entity => {
  const s = w.level.spawn
  const p = spawnPlayer(w, id, s.x, s.y)
  p.facing = 0
  return p
}

const projectiles = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'projectile' && !e.dead)
const bullets = (w: World): Entity[] => projectiles(w).filter((e) => e.archetype === 'projectile')

describe('fire button — the held item is IGNORED; the weapon always fires', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    p.health = { hp: 50, max: 120, iframes: 0 }
  })

  it('fire with a consumable held → shoots anyway; the item is NOT consumed', () => {
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 1 }, { itemId: 'medkit', qty: 1 }]
    p.loadout!.activeSlot = 1
    combatSystem(w, fire())
    expect(p.health!.hp).toBe(50) // no heal — FIRE does not use items
    expect(p.loadout!.inventory.find((s) => s.itemId === 'medkit')!.qty).toBe(1)
    expect(bullets(w)).toHaveLength(1) // the pistol fired
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('fire with a throwable held → shoots the gun, does NOT lob the throwable', () => {
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 1 }, { itemId: 'molotov', qty: 2 }]
    p.loadout!.activeSlot = 1
    combatSystem(w, fire())
    expect(projectiles(w).filter((e) => e.archetype === 'molotov')).toHaveLength(0)
    expect(bullets(w)).toHaveLength(1)
    expect(p.loadout!.inventory.find((s) => s.itemId === 'molotov')!.qty).toBe(2)
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('regression: holding a throwable can never lock the player out of shooting', () => {
    // The reason the FIRE/USE arbitration had to go. Hold a grenade, mash FIRE
    // for a while: every cooldown window still produces a bullet.
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 1 }, { itemId: 'grenade', qty: 5 }]
    p.loadout!.activeSlot = 1
    for (let i = 0; i < 10; i++) {
      p.combat!.cooldown = 0
      combatSystem(w, fire())
    }
    expect(bullets(w)).toHaveLength(10)
    expect(p.loadout!.inventory.find((s) => s.itemId === 'grenade')!.qty).toBe(5)
  })
})

describe('fire button — a weapon in hand fires as before', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('the permanent gun fires and spends nothing, no roll', () => {
    // Default loadout: the pistol in slot 0, qty 1, no ammo to spend.
    combatSystem(w, fire())
    expect(bullets(w)).toHaveLength(1)
    expect(p.loadout!.inventory[0].qty).toBe(1)
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('a melee weapon in hand → swings (sets cooldown), never rolls even with no target', () => {
    p.combat!.weapon = 'bat'
    p.loadout!.inventory = [{ itemId: 'bat', qty: 16 }]
    p.loadout!.activeSlot = -1
    combatSystem(w, fire())
    expect(p.combat!.cooldown).toBeGreaterThan(0) // a swing happened
    expect(p.playerCtl!.roll).toBeUndefined()
    expect(projectiles(w)).toHaveLength(0)
  })

  it('bare fists (empty hands, no slot) PUNCH — they do NOT roll', () => {
    // Fists are a real attack, so unarmed FIRE swings. FIRE never rolls at all —
    // the dodge-roll fallback is on the USE button (see the use-button suites).
    p.combat!.weapon = 'fists'
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    combatSystem(w, fire())
    expect(p.combat!.cooldown).toBeGreaterThan(0) // fists cooldown → it swung
    expect(p.playerCtl!.roll).toBeUndefined()
  })
})

describe('fire button — never a roll, whatever is in hand', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('the gun cannot run dry, and FIRE never backflips', () => {
    combatSystem(w, fire({ moveX: 1 }))
    expect(p.playerCtl!.roll).toBeUndefined()
    expect(projectiles(w)).toHaveLength(1)
  })

  it('holding fire NEVER rolls across a full roll cycle, and keeps shooting', () => {
    let rollStarts = 0
    const span = ROLL_TICKS + ROLL_COOLDOWN + 5
    for (let t = 0; t < span; t++) {
      const before = w.events.length
      tickWorld(w, fire({ moveX: 1 }))
      rollStarts += w.events.slice(before).filter((ev) => ev.type === 'roll').length
    }
    expect(rollStarts).toBe(0) // FIRE never rolls
    expect(bullets(w).length).toBeGreaterThan(0) // and never runs dry
  })
})

describe('use button — nothing usable → dodge-roll (the backflip)', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('empty hands (no usable item) → USE rolls, along the move vector', () => {
    p.loadout!.inventory = [] // nothing to use
    p.loadout!.activeSlot = -1
    combatSystem(w, use({ moveX: 1 }))
    const roll = p.playerCtl!.roll
    expect(roll).toBeDefined()
    expect(roll!.untilTick).toBe(w.tick + ROLL_TICKS)
    expect(roll!.dirX).toBeCloseTo(1, 6)
    expect(projectiles(w)).toHaveLength(0)
  })

  it('a gun slot active (not a usable item) → USE rolls', () => {
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 1 }]
    p.loadout!.activeSlot = 0
    combatSystem(w, use({ moveX: 1 }))
    expect(p.playerCtl!.roll).toBeDefined()
    expect(projectiles(w)).toHaveLength(0)
  })

  it('the roll direction falls back to facing when the stick is centred', () => {
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    p.facing = Math.PI / 2 // down
    combatSystem(w, use()) // no move input
    const roll = p.playerCtl!.roll!
    expect(roll.dirX).toBeCloseTo(0, 6)
    expect(roll.dirY).toBeCloseTo(1, 6)
  })

  it('edge case: USE with a usable item HELD always uses it, never rolls', () => {
    p.health = { hp: 50, max: 120, iframes: 0 }
    p.loadout!.inventory = [{ itemId: 'medkit', qty: 1 }]
    p.loadout!.activeSlot = 0
    combatSystem(w, use({ moveX: 1 })) // moving AND a medkit in hand
    expect(p.health!.hp).toBe(120) // healed (100, clamped to max)
    expect(p.playerCtl!.roll).toBeUndefined() // used the item, did NOT roll
    expect(p.loadout!.inventory).toHaveLength(0)
  })

  it('adversarial: a re-press mid-roll does NOT re-roll (anti-chain gate holds)', () => {
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    combatSystem(w, use({ moveX: 1 }))
    const first = { ...p.playerCtl!.roll! }
    w.tick += Math.floor(ROLL_TICKS / 2) // still mid-roll window
    combatSystem(w, use({ moveX: 0, moveY: 1 })) // mash use again
    expect(p.playerCtl!.roll).toEqual(first) // unchanged — no second roll
  })

  it('adversarial: a re-press during the post-roll COOLDOWN does not re-roll', () => {
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    combatSystem(w, use({ moveX: 1 }))
    const first = { ...p.playerCtl!.roll! }
    w.tick = first.cooldownUntilTick - 1 // window over, still cooling down
    combatSystem(w, use({ moveX: 0, moveY: 1 }))
    expect(p.playerCtl!.roll).toEqual(first) // still gated by cooldown
  })
})

describe('use→roll fallback — integration through the full tick pipeline', () => {
  it('holding use with empty hands rolls, waits out the cooldown, then rolls again', () => {
    const w = createWorld(1, 1)
    const p = player(w)
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    // Hold use for a full roll+cooldown cycle plus a couple ticks. Real pipeline:
    // rollSystem clears the spent roll at cooldownUntilTick, then combatSystem
    // re-rolls the SAME tick — so exactly two roll starts, no chain-lock between.
    let rollStarts = 0
    const span = ROLL_TICKS + ROLL_COOLDOWN + 2
    for (let t = 0; t < span; t++) {
      const before = w.events.length
      tickWorld(w, use({ moveX: 1 }))
      rollStarts += w.events.slice(before).filter((ev) => ev.type === 'roll').length
    }
    expect(rollStarts).toBe(2)
    expect(bullets(w)).toHaveLength(0)
    expect(p.dead).toBeFalsy()
  })
})

describe('co-op resolves per player independently', () => {
  it('FIRE: both players shoot their own permanent gun, same tick', () => {
    const w = createWorld(1, 1)
    const s = w.level.spawn
    const holder = spawnPlayer(w, 0, s.x, s.y)
    holder.facing = 0
    holder.health = { hp: 40, max: 120, iframes: 0 }
    holder.loadout!.inventory.push({ itemId: 'medkit', qty: 1 })
    holder.loadout!.activeSlot = 1 // holding a medkit — irrelevant to FIRE

    const gunner = spawnPlayer(w, 1, s.x + 2, s.y)
    gunner.facing = 0

    combatSystem(
      w,
      new Map([
        [0, { ...emptyInput(), attack: true }],
        [1, { ...emptyInput(), attack: true }],
      ]),
    )

    expect(holder.health!.hp).toBe(40) // FIRE never used the medkit
    expect(holder.loadout!.inventory.find((x) => x.itemId === 'medkit')!.qty).toBe(1)
    expect(bullets(w).filter((b) => b.projectile!.ownerId === gunner.id)).toHaveLength(1)
    expect(bullets(w).filter((b) => b.projectile!.ownerId === holder.id)).toHaveLength(1)
  })

  it('co-op USE: one player rolls (empty hands) while the other uses a medkit, same tick', () => {
    const w = createWorld(1, 1)
    const s = w.level.spawn
    const roller = spawnPlayer(w, 0, s.x, s.y)
    roller.facing = 0
    roller.loadout!.inventory = [] // nothing usable → rolls
    roller.loadout!.activeSlot = -1

    const healer = spawnPlayer(w, 1, s.x + 2, s.y)
    healer.facing = 0
    healer.health = { hp: 40, max: 120, iframes: 0 }
    healer.loadout!.inventory = [{ itemId: 'medkit', qty: 1 }]
    healer.loadout!.activeSlot = 0

    combatSystem(
      w,
      new Map([
        [0, { ...emptyInput(), throwItem: true, moveX: 1 }],
        [1, { ...emptyInput(), throwItem: true }],
      ]),
    )

    expect(roller.playerCtl!.roll).toBeDefined() // empty-handed use → backflip
    expect(healer.playerCtl!.roll).toBeUndefined() // used the medkit instead
    expect(healer.health!.hp).toBe(120)
  })
})

describe('use→roll fallback — determinism / serialization', () => {
  it('a use-triggered roll round-trips and replays byte-identically', () => {
    const w = createWorld(9, 1)
    const p = player(w)
    p.loadout!.inventory = []
    p.loadout!.activeSlot = -1
    tickWorld(w, use({ moveX: 1 })) // use with empty hands → roll begins
    const json = serializeWorld(w)
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    for (let i = 0; i < ROLL_TICKS + ROLL_COOLDOWN + 5; i++) {
      tickWorld(a, new Map([[0, emptyInput()]]))
      tickWorld(b, new Map([[0, emptyInput()]]))
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})
