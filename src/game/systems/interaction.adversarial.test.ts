import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { interactionSystem, nearestInteractable } from './interaction'
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

  const downPlayer = (classId = 'soldier'): Entity => {
    const p = spawnPlayer(w, 0, classId, 20, 20)
    p.health!.hp = 0
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    settle(p)
    return p
  }

  it('an adjacent standing teammate revives the downed player after REVIVE_TICKS, restoring 30% hp', () => {
    const downed = downPlayer()
    const helper = spawnPlayer(w, 1, 'soldier', 20.9, 20) // within 1.3
    settle(helper)
    const ids = idleFor(0, 1)
    for (let i = 0; i < 90 && downed.playerCtl!.downed; i++) interactionSystem(w, ids)
    expect(downed.playerCtl!.downed).toBeUndefined()
    expect(downed.health!.hp).toBe(Math.floor(downed.health!.max * 0.3))
  })

  it('a Doctor revives twice as fast (reviveSpeedMult 2)', () => {
    const downed = downPlayer()
    spawnPlayer(w, 1, 'doctor', 20.9, 20)
    const ids = idleFor(0, 1)
    let ticks = 0
    while (downed.playerCtl!.downed && ticks < 90) {
      interactionSystem(w, ids)
      ticks++
    }
    expect(downed.playerCtl!.downed).toBeUndefined()
    expect(ticks).toBeLessThanOrEqual(45) // 90 / 2
  })

  it('a teammate out of range makes no progress and lets the bleed timer tick down', () => {
    const downed = downPlayer()
    downed.playerCtl!.downed!.bleedTicks = 10
    spawnPlayer(w, 1, 'soldier', 25, 20) // far away
    const ids = idleFor(0, 1)
    interactionSystem(w, ids)
    expect(downed.playerCtl!.downed!.reviveProgress).toBe(0)
    expect(downed.playerCtl!.downed!.bleedTicks).toBe(9)
  })

  it('ADVERSARIAL: a helper leaving mid-revive RESETS progress (partial revive is lost)', () => {
    const downed = downPlayer()
    const helper = spawnPlayer(w, 1, 'soldier', 20.9, 20)
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
    const b = spawnPlayer(w, 1, 'soldier', 20.5, 20)
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
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
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
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const mate = spawnPlayer(w, 1, 'soldier', 30, 30) // far away, also down
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
    const p = spawnPlayer(cw, 0, 'soldier', 20, 20)
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

describe('lockpick channel', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a Thief pops an easy lock (level ≤ autoPickLockLevel) instantly, no channel', () => {
    const p = spawnPlayer(w, 0, 'thief', 20, 20) // autoPickLockLevel 1
    const door = lockedDoor(w, 20.8, 20, 1)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(door.door!.locked).toBe(false)
    expect(door.door!.open).toBe(true)
    expect(p.playerCtl!.channel).toBeUndefined()
  })

  it('a Thief facing a hard lock (level above their skill) starts a channel instead', () => {
    const p = spawnPlayer(w, 0, 'thief', 20, 20)
    const door = lockedDoor(w, 20.8, 20, 2)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(door.door!.locked).toBe(true)
    expect(p.playerCtl!.channel).toEqual({ kind: 'lockpick', targetId: door.id, ticksLeft: 45 })
  })

  it('a non-Thief starts a lockpick channel on any locked door', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const door = lockedDoor(w, 20.8, 20, 1)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(p.playerCtl!.channel?.targetId).toBe(door.id)
  })

  it('moving cancels an in-progress channel', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    expect(p.playerCtl!.channel).toBeDefined()
    p.pos.x += 0.5 // drifted since prevPos
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.channel).toBeUndefined()
  })

  it('a channel aborts if the target door is unlocked by other means mid-pick', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const door = lockedDoor(w, 20.8, 20)
    settle(p)
    interactionSystem(w, inputs([0, interactCmd()]))
    door.door!.locked = false // hacker opened it, say
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.channel).toBeUndefined()
  })

  it('a completed channel with a lucky roll opens the door (seed chosen so chance(0.7) passes)', () => {
    // Find a seed whose first mission-independent rng roll succeeds.
    let opened = false
    for (let seed = 1; seed < 40 && !opened; seed++) {
      const world = createWorld(seed, 1)
      const p = spawnPlayer(world, 0, 'soldier', 20, 20)
      const door = lockedDoor(world, 20.8, 20)
      settle(p)
      interactionSystem(world, inputs([0, interactCmd()]))
      p.playerCtl!.channel!.ticksLeft = 1 // fast-forward to completion
      settle(p)
      interactionSystem(world, idleFor(0))
      expect(p.playerCtl!.channel).toBeUndefined()
      if (!door.door!.locked) {
        opened = true
        expect(door.door!.open).toBe(true)
      } else {
        // Botched pick: makes noise and stamps a crime window.
        expect(p.playerCtl!.crimeUntilTick).toBeGreaterThan(world.tick)
      }
    }
    expect(opened).toBe(true) // at least one seed opened, proving the success path
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
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const cash = pickup('cash', 20, 20, 25)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.cash).toBe(25)
    expect(cash.dead).toBe(true)
  })

  it('a weapon pickup is grabbed and auto-equipped (first weapon)', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    pickup('bat', 20, 20)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'bat')).toBe(true)
    expect(p.playerCtl!.activeSlot).toBeGreaterThanOrEqual(0)
  })

  it('a consumable auto-heals a hurt player instead of taking a slot', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    p.health!.hp = 10
    pickup('bandage', 20, 20) // heals 30
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.health!.hp).toBe(40)
    expect(p.playerCtl!.inventory.some((s) => s.itemId === 'bandage')).toBe(false)
  })

  it('an out-of-reach pickup is left alone', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const cash = pickup('cash', 23, 20, 25)
    settle(p)
    interactionSystem(w, idleFor(0))
    expect(p.playerCtl!.cash).toBe(0)
    expect(cash.dead).toBeFalsy()
  })

  it('a downed player does not auto-pickup (they only bleed/revive)', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
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
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    expect(nearestInteractable(w.entities, p)).toBeNull()
  })

  it('picks the closest of several in-range interactables', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const far = lockedDoor(w, 21, 20)
    const near = lockedDoor(w, 20.3, 20)
    expect(nearestInteractable(w.entities, p)).toBe(near)
    expect(nearestInteractable(w.entities, p)).not.toBe(far)
  })

  it('respects each entity\'s own interact.range and ignores dead ones', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const inRange = spawnObject(w, 'atm', 20, 20) // range 1.3, at ~20.5,20.5
    inRange.interact = { verb: 'use', range: 1.3 }
    const wideButDead = lockedDoor(w, 20.1, 20)
    wideButDead.dead = true
    expect(nearestInteractable(w.entities, p)).toBe(inRange)
  })

  it('excludes an interactable just past its range', () => {
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    const door = lockedDoor(w, 20, 20)
    door.pos = { x: 21.4, y: 20 } // > 1.3 away
    door.interact!.range = 1.3
    expect(nearestInteractable(w.entities, p)).toBeNull()
  })
})
