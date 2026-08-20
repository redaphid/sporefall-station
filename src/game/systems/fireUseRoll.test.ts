// Feature: FIRE and USE are SEPARATE buttons; the dodge-roll fallback lives on
// the USE button ONLY.
//  FIRE (attack): ALWAYS fires the one permanent weapon. It never diverts to a
//    held item. That divert rule existed only while weapons shared the hotbar
//    and you could cycle back to your gun; with a permanent, unselectable weapon
//    there is nothing to cycle back to, so it would leave a player holding a
//    grenade unable to ever shoot again.
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

describe('fire button — FIRE ALWAYS fires the permanent weapon', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    p.health = { hp: 50, max: 120, iframes: 0 }
  })

  it('fire with a bandage HELD → the gun fires; the bandage is untouched', () => {
    p.loadout!.inventory.push({ itemId: 'bandage', qty: 1 })
    p.loadout!.activeSlot = 1
    combatSystem(w, fire())
    expect(bullets(w)).toHaveLength(1) // the gun fired
    expect(p.health!.hp).toBe(50) // no heal
    expect(p.loadout!.inventory.find((s) => s.itemId === 'bandage')!.qty).toBe(1) // not spent
    expect(p.loadout!.activeSlot).toBe(1) // still held
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('fire with a throwable HELD → the gun fires; nothing is lobbed', () => {
    // THE SOFT-LOCK GUARD. Under the old arbitration a held molotov made FIRE
    // throw instead of shoot, and with an unselectable weapon there was no way
    // back — the player could never shoot again for the rest of the run.
    p.loadout!.inventory.push({ itemId: 'molotov', qty: 2 })
    p.loadout!.activeSlot = 1
    combatSystem(w, fire())
    expect(bullets(w)).toHaveLength(1)
    expect(projectiles(w).filter((e) => e.archetype === 'molotov')).toHaveLength(0)
    expect(p.loadout!.inventory.find((s) => s.itemId === 'molotov')!.qty).toBe(2)
  })

  it('firing stays possible forever while an item is held (no dead end)', () => {
    p.loadout!.inventory.push({ itemId: 'molotov', qty: 5 })
    p.loadout!.activeSlot = 1
    for (let i = 0; i < 5; i++) {
      p.combat!.cooldown = 0
      combatSystem(w, fire())
    }
    expect(bullets(w)).toHaveLength(5)
  })
})

describe('use button — the held item is what the USE button spends', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    p.health = { hp: 50, max: 120, iframes: 0 }
  })

  it('use with a bandage held → heals, consumes the bandage, spawns NO bullet', () => {
    p.loadout!.inventory.push({ itemId: 'bandage', qty: 1 })
    p.loadout!.activeSlot = 1
    combatSystem(w, use())
    expect(p.health!.hp).toBe(80) // 50 + 30 heal
    expect(p.loadout!.inventory.some((s) => s.itemId === 'bandage')).toBe(false) // consumed
    expect(p.loadout!.activeSlot).toBe(-1)
    expect(projectiles(w)).toHaveLength(0) // no shot
    expect(p.playerCtl!.roll).toBeUndefined() // used an item, did NOT roll
  })

  it('a stacked consumable decrements by one and keeps the slot', () => {
    p.loadout!.inventory.push({ itemId: 'bandage', qty: 3 })
    p.loadout!.activeSlot = 1
    combatSystem(w, use())
    expect(p.loadout!.inventory.find((s) => s.itemId === 'bandage')!.qty).toBe(2)
    expect(p.health!.hp).toBe(80)
  })

  it('use with a throwable held → lobs it (a throwable projectile), no gun bullet', () => {
    p.loadout!.inventory.push({ itemId: 'molotov', qty: 2 })
    p.loadout!.activeSlot = 1
    combatSystem(w, use())
    const thrown = projectiles(w).filter((e) => e.archetype === 'molotov')
    expect(thrown).toHaveLength(1) // the molotov is airborne
    expect(bullets(w)).toHaveLength(0) // the gun did NOT also fire
    expect(p.loadout!.inventory.find((s) => s.itemId === 'molotov')!.qty).toBe(1)
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('adversarial: using a bandage at FULL HP still consumes it', () => {
    p.health = { hp: 120, max: 120, iframes: 0 }
    p.loadout!.inventory.push({ itemId: 'bandage', qty: 1 })
    p.loadout!.activeSlot = 1
    combatSystem(w, use())
    expect(p.health!.hp).toBe(120)
    expect(p.loadout!.inventory.some((s) => s.itemId === 'bandage')).toBe(false) // still spent
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

  it('active gun → a bullet spawns, nothing is spent, no roll', () => {
    combatSystem(w, fire())
    expect(bullets(w)).toHaveLength(1)
    // There is no ammo: firing costs nothing, so the slot count never moves. The
    // stack exists to give weapon-mods a home, not to count rounds.
    expect(p.loadout!.inventory[0].qty).toBe(1)
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('active melee weapon → swings (sets cooldown), never rolls even with no target', () => {
    p.combat!.weapon = 'bat'
    p.loadout!.inventory = [{ itemId: 'bat', qty: 16 }]
    p.loadout!.activeSlot = 0
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

describe('fire button — nothing to fire is a DRY no-op, never a roll', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('an out-of-ammo gun → fire clicks: no roll (the fallback is not on FIRE)', () => {
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 0 }] // a zero count is meaningless now
    p.loadout!.activeSlot = 0
    combatSystem(w, fire({ moveX: 1 }))
    // The load-bearing guarantee: FIRE never backflips.
    expect(p.playerCtl!.roll).toBeUndefined()
    // A gun can never read as empty — qty is not ammo — so it fires regardless.
    expect(projectiles(w)).toHaveLength(1)
  })

  it('holding fire NEVER rolls across a full roll cycle', () => {
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 0 }]
    p.loadout!.activeSlot = 0
    let rollStarts = 0
    const span = ROLL_TICKS + ROLL_COOLDOWN + 5
    for (let t = 0; t < span; t++) {
      const before = w.events.length
      tickWorld(w, fire({ moveX: 1 }))
      rollStarts += w.events.slice(before).filter((ev) => ev.type === 'roll').length
    }
    expect(rollStarts).toBe(0) // FIRE never rolls
    // And it keeps firing: a zero slot count is not an empty magazine.
    expect(bullets(w).length).toBeGreaterThan(0)
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

  it('an out-of-ammo gun active (not a usable item) → USE rolls', () => {
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 0 }]
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
    p.loadout!.inventory = [{ itemId: 'bandage', qty: 1 }]
    p.loadout!.activeSlot = 0
    combatSystem(w, use({ moveX: 1 })) // moving AND a bandage in hand
    expect(p.health!.hp).toBe(80) // healed
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

describe('fire button — co-op resolves per player independently', () => {
  it('one player heals off a bandage while the other fires a gun, same tick', () => {
    const w = createWorld(1, 1)
    const s = w.level.spawn
    const healer = spawnPlayer(w, 0, s.x, s.y)
    healer.facing = 0
    healer.health = { hp: 40, max: 120, iframes: 0 }
    healer.loadout!.inventory.push({ itemId: 'bandage', qty: 1 })
    healer.loadout!.activeSlot = 1

    const gunner = spawnPlayer(w, 1, s.x + 2, s.y)
    gunner.facing = 0
    // gunner keeps the default pistol loadout

    // The healer presses USE, the gunner presses FIRE, in the same tick: each
    // player's buttons resolve against their own loadout only.
    combatSystem(
      w,
      new Map([
        [0, { ...emptyInput(), throwItem: true }],
        [1, { ...emptyInput(), attack: true }],
      ]),
    )

    expect(healer.health!.hp).toBe(70) // 40 + 30
    expect(healer.loadout!.inventory.some((s2) => s2.itemId === 'bandage')).toBe(false)
    const gunnerBullets = bullets(w).filter((b) => b.projectile!.ownerId === gunner.id)
    expect(gunnerBullets).toHaveLength(1)
    expect(bullets(w).filter((b) => b.projectile!.ownerId === healer.id)).toHaveLength(0)
  })

  it('co-op USE: one player rolls (empty hands) while the other uses a bandage, same tick', () => {
    const w = createWorld(1, 1)
    const s = w.level.spawn
    const roller = spawnPlayer(w, 0, s.x, s.y)
    roller.facing = 0
    roller.loadout!.inventory = [] // nothing usable → rolls
    roller.loadout!.activeSlot = -1

    const healer = spawnPlayer(w, 1, s.x + 2, s.y)
    healer.facing = 0
    healer.health = { hp: 40, max: 120, iframes: 0 }
    healer.loadout!.inventory = [{ itemId: 'bandage', qty: 1 }]
    healer.loadout!.activeSlot = 0

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
