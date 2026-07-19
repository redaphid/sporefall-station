import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { applyDamage, detonate } from './combat'
import { interactionSystem, nearestInteractable, pickTicks } from './interaction'
import { spawnObject } from './objects'

const inputs = (...pairs: [number, InputCmd][]): Map<number, InputCmd> => new Map(pairs)
const idleFor = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))
const interactCmd = (): InputCmd => ({ ...emptyInput(), interact: true })

/** Keep an entity "still" so runChannel's drift check passes: prevPos == pos.
 * interactionSystem itself never moves the player, but a test that mutates pos
 * must sync prevPos too. */
const settle = (e: Entity): void => {
  e.prevPos.x = e.pos.x
  e.prevPos.y = e.pos.y
}

const lockedDoor = (w: World, x: number, y: number, lockLevel = 2): Entity => {
  const e = addEntity(w, makeEntity('door', 'door', x, y, 0.5))
  e.door = { open: false, locked: true, lockLevel }
  e.interact = { verb: 'open', range: 1.3 }
  return e
}

describe('teammate revive', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  const downPlayer = (): Entity => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.hp = 0
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    settle(p)
    return p
  }

  it('an adjacent standing teammate revives the downed player after REVIVE_TICKS, restoring 30% hp', () => {
    const downed = downPlayer()
    const helper = spawnPlayer(w, 1, 20.9, 20) // within 1.3
    settle(helper)
    const ids = idleFor(0, 1)
    for (let i = 0; i < 90 && downed.playerCtl!.downed; i++) interactionSystem(w, ids)
    expect(downed.playerCtl!.downed).toBeUndefined()
    expect(downed.health!.hp).toBe(Math.floor(downed.health!.max * 0.3))
  })

  it('a teammate out of range makes no progress and lets the bleed timer tick down', () => {
    const downed = downPlayer()
    downed.playerCtl!.downed!.bleedTicks = 10
    spawnPlayer(w, 1, 25, 20) // far away
    const ids = idleFor(0, 1)
    interactionSystem(w, ids)
    expect(downed.playerCtl!.downed!.reviveProgress).toBe(0)
    expect(downed.playerCtl!.downed!.bleedTicks).toBe(9)
  })

  it('ADVERSARIAL: a helper leaving mid-revive RESETS progress (partial revive is lost)', () => {
    const downed = downPlayer()
    const helper = spawnPlayer(w, 1, 20.9, 20)
    const ids = idleFor(0, 1)
    for (let i = 0; i < 30; i++) interactionSystem(w, ids)
    expect(downed.playerCtl!.downed!.reviveProgress).toBeGreaterThan(0)
    helper.pos.x = 40 // helper flees
    interactionSystem(w, ids)
    expect(downed.playerCtl!.downed!.reviveProgress).toBe(0)
    expect(downed.playerCtl!.downed).toBeDefined()
  })

  it('ADVERSARIAL: a downed teammate is not a valid reviver — two downed players both bleed out', () => {
    const a = downPlayer()
    const b = spawnPlayer(w, 1, 20.5, 20)
    b.health!.hp = 0
    b.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    settle(b)
    const ids = idleFor(0, 1)
    interactionSystem(w, ids)
    expect(a.playerCtl!.downed!.reviveProgress).toBe(0)
    expect(b.playerCtl!.downed!.reviveProgress).toBe(0)
  })
})

describe('bleed-out → self-revive (solo) or death (no rescuer)', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1) // default 'normal'
  })

  it('a LONE downed player counts down bleedTicks and SELF-REVIVES (no one could rescue them) at a penalty', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.hp = 0
    p.playerCtl!.cash = 50
    p.playerCtl!.inventory = [{ itemId: 'bat', qty: 10 }]
    p.playerCtl!.downed = { bleedTicks: 3, reviveProgress: 0 }
    settle(p)
    const ids = idleFor(0)
    interactionSystem(w, ids)
    interactionSystem(w, ids)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeDefined()
    interactionSystem(w, ids) // 3 → 0: back up, not dead
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.health!.hp).toBe(Math.floor(p.health!.max * 0.3))
    expect(p.playerCtl!.cash).toBe(0) // penalty: cash dropped
    expect(p.playerCtl!.inventory).toHaveLength(0) // penalty: non-key items dropped
    expect(w.revivesLeft).toBe(1) // penalty: one comeback spent
  })

  it('a downed player with a DOWNED teammate (nobody standing to rescue) bleeds out to DEATH', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const mate = spawnPlayer(w, 1, 30, 30) // far away, also down
    p.health!.hp = 0
    p.playerCtl!.downed = { bleedTicks: 3, reviveProgress: 0 }
    mate.health!.hp = 0
    mate.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    settle(p)
    const ids = idleFor(0, 1)
    interactionSystem(w, ids)
    interactionSystem(w, ids)
    interactionSystem(w, ids) // 3 → 0: no possible rescuer → real death
    expect(p.dead).toBe(true)
    expect(p.playerCtl!.downed).toBeDefined() // downed record left as the death cause
  })

  it('casual mode: a lone downed player self-revives with NO penalty and unlimited comebacks', () => {
    const cw = createWorld(1, 1, 'casual')
    const p = spawnPlayer(cw, 0, 20, 20)
    p.health!.hp = 0
    p.playerCtl!.cash = 50
    p.playerCtl!.inventory = [{ itemId: 'bat', qty: 10 }]
    p.playerCtl!.downed = { bleedTicks: 2, reviveProgress: 0 }
    settle(p)
    const ids = idleFor(0)
    interactionSystem(cw, ids)
    interactionSystem(cw, ids) // 2 → 0
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.playerCtl!.cash).toBe(50) // no penalty
    expect(p.playerCtl!.inventory).toHaveLength(1)
    expect(cw.revivesLeft).toBe(2) // untouched — casual doesn't spend the pool
  })
})

describe('lockpick channel — deterministic, lock-level timed', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a locked door starts a channel whose length comes from the lock level (no class pops locks instantly)', () => {
    for (const [lockLevel, ticks] of [
      [1, 60],
      [2, 105],
      [3, 150],
    ] as const) {
      const world = createWorld(1, 1)
      const p = spawnPlayer(world, 0, 20, 20)
      const door = lockedDoor(world, 20.8, 20, lockLevel)
      settle(p)
      interactionSystem(world, inputs([0, interactCmd()]))
      expect(door.door!.locked).toBe(true) // still locked: the pick is a channel, not instant
      expect(p.playerCtl!.channel).toEqual({ kind: 'lockpick', targetId: door.id, ticksLeft: ticks, total: ticks })
      expect(world.events).toContainEqual({ type: 'pickStart', entityId: door.id, byId: p.id, ticks })
    }
  })

  it('ADVERSARIAL: degenerate lock levels clamp into the table — NO lock is ever unpickable', () => {
    expect(pickTicks(0)).toBe(60) // "locked at L0" still picks like L1
    expect(pickTicks(-3)).toBe(60)
    expect(pickTicks(99)).toBe(150) // absurdly high level caps at L3 time
    expect(pickTicks(2.7)).toBe(105) // fractional level floors to L2
  })

  it('EXACT TICKS: the door stays shut through tick total-1 and opens ON the final tick — always, no dice', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const door = lockedDoor(w, 20.8, 20, 1) // L1 = 60 ticks
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    for (let t = 0; t < 59; t++) {
      interactionSystem(w, idleFor(0))
      expect(door.door!.open).toBe(false)
      expect(p.playerCtl!.channel).toBeDefined()
    }
    w.events.length = 0
    interactionSystem(w, idleFor(0)) // tick 60: pop
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(door.door!.locked).toBe(false)
    expect(door.door!.open).toBe(true)
    expect(w.events).toContainEqual({ type: 'doorToggle', entityId: door.id, open: true })
  })

  it('determinism: two identical worlds pick on exactly the same tick', () => {
    const run = (): number => {
      const world = createWorld(9, 1)
      const p = spawnPlayer(world, 0, 20, 20)
      const door = lockedDoor(world, 20.8, 20, 2)
      settle(p)
      interactionSystem(world, inputs([0, interactCmd()]))
      let t = 0
      while (!door.door!.open && t < 500) {
        interactionSystem(world, idleFor(0))
        t++
      }
      return t
    }
    expect(run()).toBe(run())
    expect(run()).toBeLessThan(500)
  })

  it('deliberate stick input cancels the channel with a pickCancel(moved) event', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const door = lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(p.playerCtl!.channel).toBeDefined()
    w.events.length = 0
    interactionSystem(w, inputs([0, { ...emptyInput(), moveX: 1 }]))
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(w.events).toContainEqual({ type: 'pickCancel', entityId: door.id, byId: p.id, reason: 'moved' })
  })

  it('real knockback displacement cancels; a pushApart-scale nudge does NOT', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    // Brushing NPC shove: a few hundredths of a tile per tick. Pick survives.
    p.prevPos.x = p.pos.x - 0.04
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.channel).toBeDefined()
    // Grenade knockback: a quarter tile in one tick. Pick breaks.
    p.prevPos.x = p.pos.x - 0.25
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.channel).toBeUndefined()
  })

  it('ADVERSARIAL: sub-deadzone stick drift (thumb resting on the stick) does not cancel', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const door = lockedDoor(w, 20.8, 20, 1)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    // NOTE: interactionSystem alone never moves the player; the real movement
    // system zeroes intent below its own deadzone. Here the stick reads 0.2 —
    // under PICK_MOVE_DEADZONE — for the whole channel: the pick must complete.
    for (let t = 0; t < 60; t++) interactionSystem(w, inputs([0, { ...emptyInput(), moveX: 0.2 }]))
    expect(door.door!.open).toBe(true)
  })

  it('taking a hit cancels the channel with pickCancel(hurt); a blow eaten by iframes does not', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.iframes = 0
    const door = lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    w.events.length = 0
    applyDamage(w, p, 5, 30, 20, 0, 999) // zero knockback: the HIT itself must break it
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(w.events).toContainEqual({ type: 'pickCancel', entityId: door.id, byId: p.id, reason: 'hurt' })
    // Restart the pick; now the player has iframes from that hit — an absorbed
    // blow is NOT a landed hit and must not break the new channel.
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(p.playerCtl!.channel).toBeDefined()
    applyDamage(w, p, 5, 30, 20, 0, 999)
    expect(p.playerCtl!.channel).toBeDefined()
  })

  it('a channel aborts (reason gone) if the target door is unlocked by other means mid-pick', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const door = lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    door.door!.locked = false // unlocked by other means, say
    w.events.length = 0
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(w.events).toContainEqual({ type: 'pickCancel', entityId: door.id, byId: p.id, reason: 'gone' })
  })

  it('ADVERSARIAL: creeping out of reach (many sub-threshold nudges) still drops the pick at 1.6 tiles', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    // Each tick moves 0.1 (under PICK_DRIFT_CANCEL) but accumulates away.
    for (let t = 0; t < 20 && p.playerCtl!.channel; t++) {
      p.prevPos.x = p.pos.x
      p.pos.x -= 0.1
      interactionSystem(w, idleFor(0))
    }
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(w.entities.find((e) => e.door)!.door!.open).toBe(false)
  })

  it('CO-OP: two players picking the same door — first pop opens it, the other cancels gone (no double toggle)', () => {
    const a = spawnPlayer(w, 0, 20, 20)
    const b = spawnPlayer(w, 1, 21.6, 20)
    const door = lockedDoor(w, 20.8, 20, 1)
    settle(a)
    settle(b)
    interactionSystem(w, inputs([0, interactCmd()], [1, emptyInput()]))
    interactionSystem(w, inputs([0, emptyInput()], [1, interactCmd()])) // b starts 1 tick later
    for (let t = 0; t < 70; t++) interactionSystem(w, idleFor(0, 1))
    expect(door.door!.open).toBe(true)
    expect(a.playerCtl!.channel).toBeUndefined()
    expect(b.playerCtl!.channel).toBeUndefined()
    // Exactly ONE doorToggle fired across the whole run — replay every tick's
    // events? events reset per tickWorld, but here we drove interactionSystem
    // directly, so the log accumulated: count them.
    expect(w.events.filter((e) => e.type === 'doorToggle')).toHaveLength(1)
  })

  it('SERIALIZE: a world snapshotted MID-CHANNEL resumes and pops the lock on the identical tick', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    lockedDoor(w, 20.8, 20, 2)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    for (let t = 0; t < 40; t++) interactionSystem(w, idleFor(0)) // 40/105 in
    const json = serializeWorld(w)
    const w2 = deserializeWorld(json)
    const remaining = (world: World): number => {
      const pl = world.entities.find((e) => e.playerCtl)!
      const d = world.entities.find((e) => e.door)!
      let t = 0
      while (!d.door!.open && t < 300) {
        interactionSystem(world, new Map([[0, emptyInput()]]))
        t++
      }
      expect(pl.playerCtl!.channel).toBeUndefined()
      return t
    }
    expect(remaining(w2)).toBe(remaining(w)) // both pop after exactly 65 more ticks
  })
})

describe('explosive breach — the loud alternative to picking', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a blast centred at a locked door blows it open (unlocked + open + doorBreach event) and is HEARD', () => {
    const door = lockedDoor(w, 20, 20, 2)
    const noisesBefore = w.noises.length
    detonate(w, 20, 20.5, 1.8, 40, 1)
    expect(door.door!.locked).toBe(false)
    expect(door.door!.open).toBe(true)
    expect(w.events).toContainEqual({ type: 'doorBreach', entityId: door.id, x: door.pos.x, y: door.pos.y })
    expect(w.noises.length).toBeGreaterThan(noisesBefore) // NPCs will come investigate
  })

  it('a plain CLOSED (unlocked) door also blows open — explosions do not discriminate', () => {
    const e = addEntity(w, makeEntity('door', 'door', 20, 20, 0.5))
    e.door = { open: false, locked: false, lockLevel: 0 }
    detonate(w, 20.4, 20, 1.8, 40, 1)
    expect(e.door.open).toBe(true)
    expect(w.events.some((ev) => ev.type === 'doorBreach' && ev.entityId === e.id)).toBe(true)
  })

  it('BUNKER SPACING: one grenade cannot take both airlock doors 2 tiles apart (centre-distance rule)', () => {
    const outer = lockedDoor(w, 20, 20, 2)
    const inner = lockedDoor(w, 20, 22, 2) // vestibule between: 2.0 apart
    detonate(w, 20, 20, 1.8, 40, 1) // grenade blast radius = 1.8
    expect(outer.door!.open).toBe(true)
    expect(inner.door!.open).toBe(false)
    expect(inner.door!.locked).toBe(true)
  })

  it('ADVERSARIAL: an already-open door and a dead door emit no breach event', () => {
    const open = addEntity(w, makeEntity('door', 'door', 20, 20, 0.5))
    open.door = { open: true, locked: false, lockLevel: 0 }
    const dead = lockedDoor(w, 20.5, 20)
    dead.dead = true
    detonate(w, 20.2, 20, 2, 40, 1)
    expect(w.events.filter((ev) => ev.type === 'doorBreach')).toHaveLength(0)
  })

  it('breaching a mission door mid-pick cancels the picker with reason gone (not a silent stall)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.iframes = 9999 // survive the nearby blast — we are testing the channel, not hp
    const door = lockedDoor(w, 20.8, 20, 2)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    detonate(w, 20.8, 20, 1.5, 40, 999)
    w.events.length = 0
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.channel).toBeUndefined()
    expect(w.events).toContainEqual({ type: 'pickCancel', entityId: door.id, byId: p.id, reason: 'gone' })
  })
})

describe('auto-pickup', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  const pickup = (itemId: string, x: number, y: number, qty = 1): Entity => {
    const e = addEntity(w, makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3))
    e.pickup = { itemId, qty }
    return e
  }

  it('walking over cash banks it and consumes the pickup', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const cash = pickup('cash', 20, 20, 25)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.cash).toBe(25)
    expect(cash.dead).toBe(true)
  })

  it('a weapon pickup is grabbed and auto-equipped (first weapon)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    pickup('bat', 20, 20)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'bat')).toBe(true)
    expect(p.playerCtl!.activeSlot).toBeGreaterThanOrEqual(0)
  })

  it('a consumable auto-heals a hurt player instead of taking a slot', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.hp = 10
    pickup('bandage', 20, 20) // heals 30
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.health!.hp).toBe(40)
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'bandage')).toBe(false)
  })

  it('an out-of-reach pickup is left alone', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const cash = pickup('cash', 23, 20, 25)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.cash).toBe(0)
    expect(cash.dead).toBeFalsy()
  })

  it('a downed player does not auto-pickup (they only bleed/revive)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    pickup('cash', 20, 20, 25)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.cash).toBe(0)
  })
})

describe('nearestInteractable', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('returns null when nothing carries an interact component in range', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    expect(nearestInteractable(w.entities, p)).toBeNull()
  })

  it('picks the closest of several in-range interactables', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const far = lockedDoor(w, 21, 20)
    const near = lockedDoor(w, 20.3, 20)
    expect(nearestInteractable(w.entities, p)).toBe(near)
    expect(nearestInteractable(w.entities, p)).not.toBe(far)
  })

  it('respects each entity\'s own interact.range and ignores dead ones', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const inRange = spawnObject(w, 'atm', 20, 20) // range 1.3, at ~20.5,20.5
    inRange.interact = { verb: 'use', range: 1.3 }
    const wideButDead = lockedDoor(w, 20.1, 20)
    wideButDead.dead = true
    expect(nearestInteractable(w.entities, p)).toBe(inRange)
  })

  it('excludes an interactable just past its range', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    const door = lockedDoor(w, 20, 20)
    door.pos = { x: 21.4, y: 20 } // > 1.3 away
    door.interact!.range = 1.3
    expect(nearestInteractable(w.entities, p)).toBeNull()
  })
})
