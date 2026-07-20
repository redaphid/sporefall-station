// Increment A — "Credentials & Power". Biolock hatches opened three ways
// (keycard / power-cut / breach), the power-cut cost, and the no-dead-end
// guarantee. Exact state in, real systems run — adversarial TDD.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { arbitrateGoal } from './behaviors'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { detonate } from './combat'
import { interactionSystem } from './interaction'
import { spawnObject, useObject } from './objects'

const idle = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))
const interactCmd = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), interact: true }]])
const settle = (e: Entity): void => {
  e.prevPos.x = e.pos.x
  e.prevPos.y = e.pos.y
}

/** A sealed biolock hatch at a tile centre, within reach of a player at (20,20). */
const biolock = (w: World, kind: 'keycard' | 'power', opts: { keyId?: string; wing?: string }): Entity => {
  const e = addEntity(w, makeEntity('door', 'door', 20.8, 20, 0.5))
  e.door = { open: false, locked: true, lockLevel: 2, sealKind: kind, ...opts }
  e.interact = { verb: 'open', range: 1.3 }
  return e
}

describe('keycard biolock', () => {
  it('the RIGHT card in hand pops it instantly — no stand-still channel', () => {
    const w = createWorld(1, 1, 'normal', false)
    const p = spawnPlayer(w, 0, 20, 20)
    const door = biolock(w, 'keycard', { keyId: 'keycard.wingA', wing: 'wingA' })
    p.playerCtl!.inventory.push({ itemId: 'keycard.wingA', qty: 1 })
    settle(p)
    interactionSystem(w, interactCmd())
    expect(door.door!.open).toBe(true)
    expect(door.door!.locked).toBe(false)
    expect(p.playerCtl!.channel).toBeUndefined() // NOT a lockpick channel
    expect(w.events.some((e) => e.type === 'sealOpen' && e.via === 'keycard')).toBe(true)
  })

  it('the WRONG card (or no card) is refused — the hatch stays sealed', () => {
    for (const card of [undefined, 'keycard.wingB']) {
      const w = createWorld(1, 1, 'normal', false)
      const p = spawnPlayer(w, 0, 20, 20)
      const door = biolock(w, 'keycard', { keyId: 'keycard.wingA', wing: 'wingA' })
      if (card) p.playerCtl!.inventory.push({ itemId: card, qty: 1 })
      settle(p)
      interactionSystem(w, interactCmd())
      expect(door.door!.open).toBe(false)
      expect(door.door!.locked).toBe(true)
      expect(w.events.some((e) => e.type === 'sealDenied' && e.sealKind === 'keycard')).toBe(true)
    }
  })

  it('a keycard is a key-class item: it survives a down and rides across floors', async () => {
    const { itemClass } = await import('../data/items')
    expect(itemClass('keycard.wingA')).toBe('key')
    expect(itemClass('keycard')).toBe('key')
  })
})

describe('power biolock', () => {
  it('a bare press on a POWERED wing is refused; cutting the wing auto-unseals it', () => {
    const w = createWorld(2, 1, 'normal', false)
    const p = spawnPlayer(w, 0, 20, 20)
    const door = biolock(w, 'power', { wing: 'wingA' })
    settle(p)
    interactionSystem(w, interactCmd())
    expect(door.door!.locked).toBe(true)
    expect(w.events.some((e) => e.type === 'sealDenied' && e.sealKind === 'power')).toBe(true)

    // Cut the wing → sealSystem unseals it → the next press opens it.
    w.powerCut.wingA = true
    settle(p)
    interactionSystem(w, idle(0)) // sealSystem runs first
    expect(door.door!.locked).toBe(false)
    settle(p)
    interactionSystem(w, interactCmd())
    expect(door.door!.open).toBe(true)
  })

  it('power RESTORED while the hatch is still shut re-engages the seal', () => {
    const w = createWorld(2, 1, 'normal', false)
    const door = biolock(w, 'power', { wing: 'wingA' })
    w.powerCut.wingA = true
    interactionSystem(w, idle())
    expect(door.door!.locked).toBe(false)
    w.powerCut.wingA = false
    interactionSystem(w, idle())
    expect(door.door!.locked).toBe(true)
  })
})

describe('hacking a generator cuts power — with a cost', () => {
  it('sets powerCut[wing], raises the alarm, wakes sleepers, and emits powerCut', () => {
    const w = createWorld(3, 1, 'normal', false)
    const p = spawnPlayer(w, 0, 20, 20)
    const gen = spawnObject(w, 'generator', 22, 20)
    gen.wing = 'wingA'
    const sleeper = spawnNpc(w, 'robot', 25, 20)
    sleeper.status!.sleep = 300
    const alarmBefore = w.alarm

    expect(useObject(w, p, gen)).toBe(true)
    expect(w.powerCut.wingA).toBe(true)
    expect(w.alarm).toBe(Math.min(3, alarmBefore + 1))
    expect(sleeper.status!.sleep).toBe(0) // the outage powered it back on
    expect(w.events.some((e) => e.type === 'powerCut' && e.wing === 'wingA')).toBe(true)
    // Hacking is once-only.
    expect(useObject(w, p, gen)).toBe(false)
  })

  it('COST: a Derelict Unit that ignores you on a powered station turns hostile once power is cut', () => {
    const build = (cut: boolean): { w: World; robot: Entity; p: Entity } => {
      const w = createWorld(4, 1, 'normal', false) // NON-hostile world
      const robot = spawnNpc(w, 'robot', w.level.spawn.x, w.level.spawn.y)
      robot.ai!.sightRange = 12
      const p = spawnPlayer(w, 0, w.level.spawn.x + 1, w.level.spawn.y)
      if (cut) w.powerCut.wingA = true
      return { w, robot, p }
    }
    // Powered: the robot has no quarrel — arbitration never targets the player.
    const powered = build(false)
    expect(arbitrateGoal(powered.w, powered.robot).target).not.toBe(powered.p.id)
    // Power cut: the same robot now aggros the player.
    const dark = build(true)
    expect(arbitrateGoal(dark.w, dark.robot).target).toBe(dark.p.id)
  })
})

describe('breach: the loud, universal fallback', () => {
  it('blasting a biolock opens it AND raises the alarm and is heard', () => {
    const w = createWorld(5, 1, 'normal', false)
    const door = biolock(w, 'power', { wing: 'wingA' })
    const alarmBefore = w.alarm
    const noisesBefore = w.noises.length
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, 1)
    expect(door.door!.open).toBe(true)
    expect(w.events.some((e) => e.type === 'doorBreach' && e.entityId === door.id)).toBe(true)
    expect(w.alarm).toBe(alarmBefore + 1)
    expect(w.noises.length).toBeGreaterThan(noisesBefore)
  })
})

describe('NO DEAD-END: access is always achievable', () => {
  it('keycard lost forever → the POWER path still opens the wing', () => {
    // The card carrier died in a hazard and the card is gone; a generator for the
    // same wing is the guaranteed second key.
    const w = createWorld(6, 1, 'normal', false)
    const p = spawnPlayer(w, 0, 20, 20)
    // Two hatches on the same wing: a keycard biolock (card unobtainable) and a
    // power biolock. Cutting the wing at its generator opens the power hatch.
    const powerDoor = biolock(w, 'power', { wing: 'wingA' })
    const gen = spawnObject(w, 'generator', 24, 20)
    gen.wing = 'wingA'
    expect(useObject(w, p, gen)).toBe(true)
    interactionSystem(w, idle(0))
    expect(powerDoor.door!.locked).toBe(false) // the wing is open — run continues
  })

  it('a keycard biolock with NO card and NO generator still yields to a breach', () => {
    const w = createWorld(6, 1, 'normal', false)
    const door = biolock(w, 'keycard', { keyId: 'keycard.gone', wing: 'wingA' })
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, 1)
    expect(door.door!.open).toBe(true)
  })
})

describe('serialize: powerCut round-trips (default omitted)', () => {
  it('a fully-powered world omits the field; a cut wing round-trips byte-for-byte', () => {
    const clean = serializeWorld(createWorld(9, 1))
    expect('powerCut' in clean).toBe(false) // default fully powered → omitted

    const w = createWorld(9, 1)
    w.powerCut.wingA = true
    const j = serializeWorld(w)
    expect(j.powerCut).toEqual({ wingA: true })
    const w2 = deserializeWorld(j)
    expect(w2.powerCut.wingA).toBe(true)
    expect(serializeWorld(w2)).toEqual(j) // byte-for-byte
    tickWorld(w2, idle())
    expect(w2.powerCut.wingA).toBe(true) // and it persists through a tick
  })
})
