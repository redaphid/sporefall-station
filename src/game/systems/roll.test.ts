import { beforeEach, describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { SnapFlags, snapEntity } from '../snapshot'
import { emptyInput, SIM_DT, type InputCmd } from '../types'
import { addEntity, createWorld, isBlocked, type World } from '../world'
import { applyDamage, combatSystem } from './combat'
import { movementSystem } from './movement'
import { addStatus } from './statusFx'
import { isRolling, ROLL_COOLDOWN, ROLL_SPEED, ROLL_TICKS, rollSystem } from './roll'
import { tickWorld } from '../world'

/** One-slot input map with `roll` pressed and an optional move vector. */
const rollCmd = (moveX = 0, moveY = 0, extra: Partial<InputCmd> = {}): Map<number, InputCmd> =>
  new Map([[0, { ...emptyInput(), roll: true, moveX, moveY, ...extra }]])

const noInput = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

/** A player spawned on the guaranteed-open level spawn tile. */
const player = (w: World): Entity => {
  const s = w.level.spawn
  return spawnPlayer(w, 0, s.x, s.y)
}

describe('rollSystem — start conditions & direction', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a roll press starts a roll with tick-based windows and the move direction', () => {
    const p = player(w)
    rollSystem(w, rollCmd(1, 0))
    const roll = p.playerCtl!.roll
    expect(roll).toBeDefined()
    expect(roll!.untilTick).toBe(w.tick + ROLL_TICKS)
    expect(roll!.cooldownUntilTick).toBe(w.tick + ROLL_TICKS + ROLL_COOLDOWN)
    expect(roll!.dirX).toBeCloseTo(1, 6)
    expect(roll!.dirY).toBeCloseTo(0, 6)
    expect(isRolling(p, w.tick)).toBe(true)
  })

  it('normalizes a diagonal move into a unit roll heading', () => {
    const p = player(w)
    rollSystem(w, rollCmd(1, 1))
    const roll = p.playerCtl!.roll!
    expect(Math.hypot(roll.dirX, roll.dirY)).toBeCloseTo(1, 6)
    expect(roll.dirX).toBeCloseTo(Math.SQRT1_2, 6)
    expect(roll.dirY).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('stationary: falls back to the facing direction', () => {
    const p = player(w)
    p.facing = Math.PI / 2 // facing +y (down)
    rollSystem(w, rollCmd(0, 0))
    const roll = p.playerCtl!.roll!
    expect(roll.dirX).toBeCloseTo(0, 6)
    expect(roll.dirY).toBeCloseTo(1, 6)
  })

  it('no roll press → no roll state at all (snapshot stays clean)', () => {
    const p = player(w)
    rollSystem(w, noInput())
    expect(p.playerCtl!.roll).toBeUndefined()
  })
})

describe('rollSystem — the constraints', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('a downed player cannot roll', () => {
    p.playerCtl!.downed = { bleedTicks: 100, reviveProgress: 0 }
    rollSystem(w, rollCmd(1, 0))
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('a stunned player cannot roll', () => {
    p.status!.stun = 10
    rollSystem(w, rollCmd(1, 0))
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('an asleep player cannot roll', () => {
    p.status!.sleep = 10
    rollSystem(w, rollCmd(1, 0))
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('an immobilized (electrified) player cannot roll', () => {
    addStatus(w, p, 'electrified', 10)
    rollSystem(w, rollCmd(1, 0))
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('a dead player cannot roll', () => {
    p.dead = true
    rollSystem(w, rollCmd(1, 0))
    expect(p.playerCtl!.roll).toBeUndefined()
  })
})

describe('rollSystem — cooldown gate (no chain-rolling)', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('a second roll press during the active window is ignored', () => {
    rollSystem(w, rollCmd(1, 0))
    const first = { ...p.playerCtl!.roll! }
    w.tick += Math.floor(ROLL_TICKS / 2) // still mid-roll
    rollSystem(w, rollCmd(0, 1)) // try to re-roll a new direction
    expect(p.playerCtl!.roll).toEqual(first) // unchanged — no re-roll
  })

  it('a roll press during cooldown (after the window, before ready) is ignored', () => {
    rollSystem(w, rollCmd(1, 0))
    const first = { ...p.playerCtl!.roll! }
    w.tick = first.untilTick // roll window ended…
    expect(isRolling(p, w.tick)).toBe(false)
    w.tick = first.cooldownUntilTick - 1 // …still cooling down
    rollSystem(w, rollCmd(0, 1))
    expect(p.playerCtl!.roll).toEqual(first) // still gated
  })

  it('a roll press exactly at cooldownUntilTick starts a fresh roll', () => {
    rollSystem(w, rollCmd(1, 0))
    const first = { ...p.playerCtl!.roll! }
    w.tick = first.cooldownUntilTick
    rollSystem(w, rollCmd(0, 1))
    const second = p.playerCtl!.roll!
    expect(second.untilTick).toBe(w.tick + ROLL_TICKS)
    expect(second.dirY).toBeCloseTo(1, 6) // the new direction took
  })

  it('the spent roll object is cleared once cooldown fully elapses', () => {
    rollSystem(w, rollCmd(1, 0))
    const cd = p.playerCtl!.roll!.cooldownUntilTick
    w.tick = cd
    rollSystem(w, noInput()) // no press — just expire it
    expect(p.playerCtl!.roll).toBeUndefined()
  })
})

describe('applyDamage — dodge-roll i-frames (exact window)', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    p.health = { hp: 100, max: 100, iframes: 0 }
  })

  const hurt = (): boolean => applyDamage(w, p, 25, p.pos.x - 1, p.pos.y, 0, 999)

  it('blocks damage for every tick strictly inside the roll window', () => {
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    for (let t = w.tick; t < p.playerCtl!.roll.untilTick; t++) {
      w.tick = t
      hurt()
      expect(p.health!.hp).toBe(100)
    }
  })

  it('the LAST rolling tick (untilTick-1) is still invulnerable', () => {
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    w.tick = p.playerCtl!.roll.untilTick - 1
    hurt()
    expect(p.health!.hp).toBe(100)
  })

  it('the FIRST post-roll tick (untilTick) takes damage — i-frames end cleanly', () => {
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    w.tick = p.playerCtl!.roll.untilTick
    hurt()
    expect(p.health!.hp).toBe(75)
  })

  it('the tick BEFORE a roll starts is vulnerable (no early i-frames)', () => {
    // No roll yet this tick.
    hurt()
    expect(p.health!.hp).toBe(75)
  })
})

describe('combatSystem — cannot act mid-roll', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    p.combat = { weapon: 'pistol', cooldown: 0 }
  })

  it('an attack pressed mid-roll fires nothing (no projectile, no cooldown)', () => {
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    const before = w.entities.filter((e) => e.projectile).length
    combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    expect(w.entities.filter((e) => e.projectile).length).toBe(before)
    expect(p.combat!.cooldown).toBe(0)
  })

  it('once the roll ends the same attack fires normally', () => {
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    w.tick = p.playerCtl!.roll.untilTick // roll over
    combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    expect(w.entities.some((e) => e.projectile)).toBe(true)
  })
})

describe('movementSystem — the roll burst', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('a rolling player bursts along the roll heading, faster than a walk', () => {
    const startX = p.pos.x
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    movementSystem(w, noInput()) // no move input — the roll drives it
    const rolled = p.pos.x - startX
    expect(rolled).toBeCloseTo(ROLL_SPEED * SIM_DT, 3)
    expect(rolled).toBeGreaterThan(p.speed * SIM_DT) // decisively faster than walking
  })

  it('control returns to normal after the window (no residual burst)', () => {
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    w.tick = p.playerCtl!.roll.untilTick // rolling window is over
    const startX = p.pos.x
    movementSystem(w, noInput())
    expect(p.pos.x).toBeCloseTo(startX, 6) // idle, no input → no motion
  })

  it('a roll does NOT clip through a wall (uses the collision path)', () => {
    // Park the player against a solid tile and roll into it.
    const open = findOpenWithSolidNeighbor(w)
    p.pos = { x: open.x + 0.5, y: open.y + 0.5 }
    p.prevPos = { ...p.pos }
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: open.dx, dirY: open.dy }
    for (let i = 0; i < ROLL_TICKS; i++) movementSystem(w, noInput())
    // The player's circle never overlaps the solid tile it rolled toward.
    expect(isBlocked(w, Math.floor(p.pos.x), Math.floor(p.pos.y))).toBe(false)
    expect(circleClearsSolids(w, p)).toBe(true)
  })
})

describe('dodge-roll — determinism & serialization', () => {
  it('a mid-roll world round-trips through serialize and replays byte-identically', () => {
    const w = createWorld(7, 1)
    player(w)
    // Drive real ticks: press roll on tick 0, then keep moving.
    rollSystem(w, rollCmd(1, 0))
    movementSystem(w, rollCmd(1, 0))
    const json = serializeWorld(w)
    expect(json.entities.find((e) => (e as { playerCtl?: unknown }).playerCtl)).toBeTruthy()

    // Two independent worlds from the same snapshot, run the same inputs.
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    for (let i = 0; i < ROLL_TICKS + ROLL_COOLDOWN + 5; i++) {
      rollSystem(a, noInput())
      movementSystem(a, noInput())
      rollSystem(b, noInput())
      movementSystem(b, noInput())
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('the roll object survives a serialize/deserialize round-trip intact', () => {
    const w = createWorld(3, 1)
    const p = player(w)
    p.playerCtl!.roll = { untilTick: w.tick + 9, cooldownUntilTick: w.tick + 40, dirX: Math.SQRT1_2, dirY: -Math.SQRT1_2 }
    const restored = deserializeWorld(serializeWorld(w))
    const rp = restored.entities.find((e) => e.playerCtl)!
    expect(rp.playerCtl!.roll).toEqual(p.playerCtl!.roll)
  })
})

describe('dodge-roll — multiplayer i-frame agreement (snapshot flag)', () => {
  it('the Rolling snapshot flag is set EXACTLY when the host is invulnerable', () => {
    const w = createWorld(1, 1)
    const p = player(w)
    p.health = { hp: 100, max: 100, iframes: 0 }
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    const start = w.tick
    for (let t = start; t <= start + ROLL_TICKS + 2; t++) {
      w.tick = t
      const flagged = (snapEntity(w, p).flags & SnapFlags.Rolling) !== 0
      // Immunity check without mutating hp: probe applyDamage on a fresh copy tick.
      const invulnerable = isRolling(p, w.tick)
      expect(flagged).toBe(invulnerable) // client is told the i-frame window precisely
    }
  })

  it('host: a player rolling through a bullet takes no damage; a hit after does', () => {
    const w = createWorld(1, 1)
    const p = player(w)
    p.health = { hp: 100, max: 100, iframes: 0 }
    p.playerCtl!.roll = { untilTick: w.tick + ROLL_TICKS, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 }
    // Bullet lands mid-roll → shrugged off.
    applyDamage(w, p, 40, p.pos.x - 1, p.pos.y, 0, 999)
    expect(p.health!.hp).toBe(100)
    // Same bullet one tick after the window → it bites.
    w.tick = p.playerCtl!.roll.untilTick
    applyDamage(w, p, 40, p.pos.x - 1, p.pos.y, 0, 999)
    expect(p.health!.hp).toBe(60)
  })
})

describe('dodge-roll — headline: roll THROUGH a bullet (mirrors the e2e world)', () => {
  // combat-stage's level (seed 7 / floor 1): the y=11 lane is open, so the player
  // and an inbound bullet share a clear line. This is the exact world the e2e
  // recorder injects (e2e/feature-dodge-roll.mjs).
  const duel = (): { w: World; p: Entity } => {
    const w = createWorld(7, 1)
    const p = spawnPlayer(w, 0, 6, 11)
    p.health = { hp: 120, max: 120, iframes: 0 }
    p.facing = 0
    addEntity(w, {
      id: 0,
      kind: 'projectile',
      archetype: 'projectile',
      pos: { x: 14, y: 11 },
      prevPos: { x: 14, y: 11 },
      vel: { x: -11, y: 0 },
      intent: { x: 0, y: 0 },
      speed: 0,
      radius: 0.15,
      facing: Math.PI,
      projectile: { ownerId: 999, damage: 40, ttl: 90 },
    })
    return { w, p }
  }

  /** Play the `dodgeRoll` timeline: 15 idle ticks, roll +x, then coast. */
  const play = (w: World, doRoll: boolean, ticks = 60): void => {
    for (let t = 0; t < ticks; t++) {
      const cmd: InputCmd = t === 15 && doRoll ? { ...emptyInput(), roll: true, moveX: 1 } : emptyInput()
      tickWorld(w, new Map([[0, cmd]]))
    }
  }

  it('rolling into the bullet: hp is UNCHANGED and the bullet is spent', () => {
    const { w, p } = duel()
    play(w, true)
    expect(p.health!.hp).toBe(120)
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(w.entities.some((e) => e.kind === 'projectile' && !e.dead)).toBe(false)
  })

  it('control — no roll, same bullet: hp DROPS by the bullet damage', () => {
    const { w, p } = duel()
    play(w, false)
    expect(p.health!.hp).toBe(80) // 120 - 40
  })
})

// ---- helpers for the wall-clip test ----

/** Find an open cell with an axis-adjacent solid cell; returns the open cell and
 * a unit direction pointing INTO the wall. */
const findOpenWithSolidNeighbor = (w: World): { x: number; y: number; dx: number; dy: number } => {
  for (let y = 1; y < w.level.h - 1; y++) {
    for (let x = 1; x < w.level.w - 1; x++) {
      if (isBlocked(w, x, y)) continue
      if (isBlocked(w, x - 1, y)) return { x, y, dx: -1, dy: 0 }
      if (isBlocked(w, x + 1, y)) return { x, y, dx: 1, dy: 0 }
      if (isBlocked(w, x, y - 1)) return { x, y, dx: 0, dy: -1 }
      if (isBlocked(w, x, y + 1)) return { x, y, dx: 0, dy: 1 }
    }
  }
  throw new Error('no open-with-solid-neighbor cell in this level')
}

/** True if the entity's circle overlaps no solid tile — i.e. it never clipped in. */
const circleClearsSolids = (w: World, e: Entity): boolean => {
  const r = e.radius
  for (let ty = Math.floor(e.pos.y - r); ty <= Math.floor(e.pos.y + r); ty++) {
    for (let tx = Math.floor(e.pos.x - r); tx <= Math.floor(e.pos.x + r); tx++) {
      if (!isBlocked(w, tx, ty)) continue
      const cx = Math.max(tx, Math.min(e.pos.x, tx + 1))
      const cy = Math.max(ty, Math.min(e.pos.y, ty + 1))
      if ((e.pos.x - cx) ** 2 + (e.pos.y - cy) ** 2 < r * r) return false
    }
  }
  return true
}
