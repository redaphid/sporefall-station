// Feature: FIRE and USE arbitrate off the ACTIVE slot; the dodge-roll fallback
// lives on the USE button ONLY.
//  FIRE (attack): usable non-weapon in hand → USE it (no bullet); else fire the
//    equipped weapon; nothing to fire (empty gun) → a DRY no-op — never a roll.
//  USE (throwItem): use the held/active usable item; nothing usable → dodge-roll.
// Tests set state exactly, run the REAL systems (combatSystem / tickWorld), and
// assert — adversarial cases included (cooldown gating, full-HP waste, co-op).

import { beforeEach, describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { spawnPlayer, STARTER_AMMO } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { combatSystem, INFINITE_AMMO } from './combat'
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

describe('fire button — a usable ACTIVE item is USED, not fired', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    p.health = { hp: 50, max: 120, iframes: 0 }
  })

  it('fire with a bandage active → heals, consumes the bandage, spawns NO bullet', () => {
    p.playerCtl!.inventory = [{ itemId: 'bandage', qty: 1 }]
    p.playerCtl!.activeSlot = 0
    combatSystem(w, fire())
    expect(p.health!.hp).toBe(80) // 50 + 30 heal
    expect(p.playerCtl!.inventory).toHaveLength(0) // last one consumed → slot gone
    expect(p.playerCtl!.activeSlot).toBe(-1)
    expect(projectiles(w)).toHaveLength(0) // no shot
    expect(p.playerCtl!.roll).toBeUndefined() // used an item, did NOT roll
  })

  it('a stacked consumable decrements by one and keeps the slot', () => {
    p.playerCtl!.inventory = [{ itemId: 'bandage', qty: 3 }]
    p.playerCtl!.activeSlot = 0
    combatSystem(w, fire())
    expect(p.playerCtl!.inventory[0].qty).toBe(2)
    expect(p.health!.hp).toBe(80)
  })

  it('fire with a throwable active → lobs it (a throwable projectile), no gun bullet', () => {
    // Pistol stays in hand (combat.weapon), molotov is the HELD active item.
    p.playerCtl!.inventory = [{ itemId: 'pistol', qty: STARTER_AMMO }, { itemId: 'molotov', qty: 2 }]
    p.playerCtl!.activeSlot = 1
    combatSystem(w, fire())
    const thrown = projectiles(w).filter((e) => e.archetype === 'molotov')
    expect(thrown).toHaveLength(1) // the molotov is airborne
    expect(bullets(w)).toHaveLength(0) // the gun did NOT also fire
    expect(p.playerCtl!.inventory.find((s) => s.itemId === 'molotov')!.qty).toBe(1)
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('adversarial: fire a bandage at FULL HP still consumes it (parity with the Use button)', () => {
    p.health = { hp: 120, max: 120, iframes: 0 }
    p.playerCtl!.inventory = [{ itemId: 'bandage', qty: 1 }]
    p.playerCtl!.activeSlot = 0
    combatSystem(w, fire())
    expect(p.health!.hp).toBe(120)
    expect(p.playerCtl!.inventory).toHaveLength(0) // still spent — no bullet, no roll
    expect(projectiles(w)).toHaveLength(0)
    expect(p.playerCtl!.roll).toBeUndefined()
  })
})

describe('fire button — a weapon in hand fires as before', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('active gun with ammo → a bullet spawns and one round is spent, no roll', () => {
    // Default loadout: pistol at slot 0 with STARTER_AMMO.
    combatSystem(w, fire())
    expect(bullets(w)).toHaveLength(1)
    // Ammo spend is gated by the INFINITE_AMMO testing toggle: OFF → one round
    // consumed (normal economy); ON → the mag is untouched (never runs dry).
    expect(p.playerCtl!.inventory[0].qty).toBe(INFINITE_AMMO ? STARTER_AMMO : STARTER_AMMO - 1)
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('active melee weapon → swings (sets cooldown), never rolls even with no target', () => {
    p.combat!.weapon = 'bat'
    p.playerCtl!.inventory = [{ itemId: 'bat', qty: 16 }]
    p.playerCtl!.activeSlot = 0
    combatSystem(w, fire())
    expect(p.combat!.cooldown).toBeGreaterThan(0) // a swing happened
    expect(p.playerCtl!.roll).toBeUndefined()
    expect(projectiles(w)).toHaveLength(0)
  })

  it('bare fists (empty hands, no slot) PUNCH — they do NOT roll', () => {
    // Fists are a real attack, so unarmed FIRE swings. FIRE never rolls at all —
    // the dodge-roll fallback is on the USE button (see the use-button suites).
    p.combat!.weapon = 'fists'
    p.playerCtl!.inventory = []
    p.playerCtl!.activeSlot = -1
    combatSystem(w, fire())
    expect(p.combat!.cooldown).toBeGreaterThan(0) // fists cooldown → it swung
    expect(p.playerCtl!.roll).toBeUndefined()
  })
})

describe('fire button — nothing to fire is a DRY no-op, never a roll', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('an out-of-ammo gun → fire clicks: no roll (the fallback is not on FIRE)', () => {
    p.playerCtl!.inventory = [{ itemId: 'pistol', qty: 0 }] // empty mag
    p.playerCtl!.activeSlot = 0
    combatSystem(w, fire({ moveX: 1 }))
    // The load-bearing guarantee holds in BOTH toggle states: FIRE never backflips.
    expect(p.playerCtl!.roll).toBeUndefined()
    // With INFINITE_AMMO OFF the empty mag is a dry no-op (no bullet); ON, the mag
    // never reads as empty so it fires anyway — either way, no roll.
    expect(projectiles(w)).toHaveLength(INFINITE_AMMO ? 1 : 0)
  })

  it('holding fire on an empty gun NEVER rolls across a full roll cycle', () => {
    p.playerCtl!.inventory = [{ itemId: 'pistol', qty: 0 }]
    p.playerCtl!.activeSlot = 0
    let rollStarts = 0
    const span = ROLL_TICKS + ROLL_COOLDOWN + 5
    for (let t = 0; t < span; t++) {
      const before = w.events.length
      tickWorld(w, fire({ moveX: 1 }))
      rollStarts += w.events.slice(before).filter((ev) => ev.type === 'roll').length
    }
    expect(rollStarts).toBe(0) // FIRE never rolls, empty gun or not
    // OFF: an empty gun never fires. ON: depletion is skipped so it keeps firing.
    if (INFINITE_AMMO) expect(bullets(w).length).toBeGreaterThan(0)
    else expect(bullets(w)).toHaveLength(0)
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
    p.playerCtl!.inventory = [] // nothing to use
    p.playerCtl!.activeSlot = -1
    combatSystem(w, use({ moveX: 1 }))
    const roll = p.playerCtl!.roll
    expect(roll).toBeDefined()
    expect(roll!.untilTick).toBe(w.tick + ROLL_TICKS)
    expect(roll!.dirX).toBeCloseTo(1, 6)
    expect(projectiles(w)).toHaveLength(0)
  })

  it('an out-of-ammo gun active (not a usable item) → USE rolls', () => {
    p.playerCtl!.inventory = [{ itemId: 'pistol', qty: 0 }]
    p.playerCtl!.activeSlot = 0
    combatSystem(w, use({ moveX: 1 }))
    expect(p.playerCtl!.roll).toBeDefined()
    expect(projectiles(w)).toHaveLength(0)
  })

  it('the roll direction falls back to facing when the stick is centred', () => {
    p.playerCtl!.inventory = []
    p.playerCtl!.activeSlot = -1
    p.facing = Math.PI / 2 // down
    combatSystem(w, use()) // no move input
    const roll = p.playerCtl!.roll!
    expect(roll.dirX).toBeCloseTo(0, 6)
    expect(roll.dirY).toBeCloseTo(1, 6)
  })

  it('edge case: USE with a usable item HELD always uses it, never rolls', () => {
    p.health = { hp: 50, max: 120, iframes: 0 }
    p.playerCtl!.inventory = [{ itemId: 'bandage', qty: 1 }]
    p.playerCtl!.activeSlot = 0
    combatSystem(w, use({ moveX: 1 })) // moving AND a bandage in hand
    expect(p.health!.hp).toBe(80) // healed
    expect(p.playerCtl!.roll).toBeUndefined() // used the item, did NOT roll
    expect(p.playerCtl!.inventory).toHaveLength(0)
  })

  it('adversarial: a re-press mid-roll does NOT re-roll (anti-chain gate holds)', () => {
    p.playerCtl!.inventory = []
    p.playerCtl!.activeSlot = -1
    combatSystem(w, use({ moveX: 1 }))
    const first = { ...p.playerCtl!.roll! }
    w.tick += Math.floor(ROLL_TICKS / 2) // still mid-roll window
    combatSystem(w, use({ moveX: 0, moveY: 1 })) // mash use again
    expect(p.playerCtl!.roll).toEqual(first) // unchanged — no second roll
  })

  it('adversarial: a re-press during the post-roll COOLDOWN does not re-roll', () => {
    p.playerCtl!.inventory = []
    p.playerCtl!.activeSlot = -1
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
    p.playerCtl!.inventory = []
    p.playerCtl!.activeSlot = -1
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

describe('fire button — co-op resolves per player independently', () => {
  it('one player heals off a bandage while the other fires a gun, same tick', () => {
    const w = createWorld(1, 1)
    const s = w.level.spawn
    const healer = spawnPlayer(w, 0, s.x, s.y)
    healer.facing = 0
    healer.health = { hp: 40, max: 120, iframes: 0 }
    healer.playerCtl!.inventory = [{ itemId: 'bandage', qty: 1 }]
    healer.playerCtl!.activeSlot = 0

    const gunner = spawnPlayer(w, 1, s.x + 2, s.y)
    gunner.facing = 0
    // gunner keeps the default pistol loadout

    combatSystem(
      w,
      new Map([
        [0, { ...emptyInput(), attack: true }],
        [1, { ...emptyInput(), attack: true }],
      ]),
    )

    expect(healer.health!.hp).toBe(70) // 40 + 30
    expect(healer.playerCtl!.inventory).toHaveLength(0)
    const gunnerBullets = bullets(w).filter((b) => b.projectile!.ownerId === gunner.id)
    expect(gunnerBullets).toHaveLength(1)
    expect(bullets(w).filter((b) => b.projectile!.ownerId === healer.id)).toHaveLength(0)
  })

  it('co-op USE: one player rolls (empty hands) while the other uses a bandage, same tick', () => {
    const w = createWorld(1, 1)
    const s = w.level.spawn
    const roller = spawnPlayer(w, 0, s.x, s.y)
    roller.facing = 0
    roller.playerCtl!.inventory = [] // nothing usable → rolls
    roller.playerCtl!.activeSlot = -1

    const healer = spawnPlayer(w, 1, s.x + 2, s.y)
    healer.facing = 0
    healer.health = { hp: 40, max: 120, iframes: 0 }
    healer.playerCtl!.inventory = [{ itemId: 'bandage', qty: 1 }]
    healer.playerCtl!.activeSlot = 0

    combatSystem(
      w,
      new Map([
        [0, { ...emptyInput(), throwItem: true, moveX: 1 }],
        [1, { ...emptyInput(), throwItem: true }],
      ]),
    )

    expect(roller.playerCtl!.roll).toBeDefined() // empty-handed use → backflip
    expect(healer.playerCtl!.roll).toBeUndefined() // used the bandage instead
    expect(healer.health!.hp).toBe(70)
  })
})

describe('use→roll fallback — determinism / serialization', () => {
  it('a use-triggered roll round-trips and replays byte-identically', () => {
    const w = createWorld(9, 1)
    const p = player(w)
    p.playerCtl!.inventory = []
    p.playerCtl!.activeSlot = -1
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
