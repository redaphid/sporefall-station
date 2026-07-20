// Increment B — "The Living Seal". Overgrown hatches, the Spore Node, the spore
// element, and the `contain` mission's soft-fail bloom. Every case sets EXACT
// state (no reliance on generation dice) and runs the REAL systems, matching the
// adversarial-TDD discipline of interaction.adversarial.test.ts.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { detonate } from './combat'
import { interactionSystem } from './interaction'
import { igniteCell } from './fire'
import { spawnObject } from './objects'
import { spawnSporeBurst, sporeAt } from './spore'
import { missionSystem } from './missions'

const idle = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))
const interactCmd = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), interact: true }]])

/** An overgrown hatch at a tile centre, optionally fed by a live Spore Node. */
const overgrownHatch = (w: World, tx: number, ty: number, growthHp = 6, nodeId?: number): Entity => {
  const e = addEntity(w, makeEntity('door', 'door', tx + 0.5, ty + 0.5, 0.5))
  e.door = { open: false, locked: true, lockLevel: 1, overgrown: true, growthHp, nodeId }
  e.flammable = true
  e.interact = { verb: 'open', range: 1.3 }
  return e
}

const settle = (e: Entity): void => {
  e.prevPos.x = e.pos.x
  e.prevPos.y = e.pos.y
}

describe('overgrown hatch — the bog seal', () => {
  it('an unarmed press cannot open it (sealDenied overgrown, stays sealed)', () => {
    const w = createWorld(1, 1, 'normal', false)
    const node = spawnObject(w, 'sporeNode', 40, 40)
    const p = spawnPlayer(w, 0, 20, 20)
    const door = overgrownHatch(w, 20, 21, 6, node.id)
    settle(p)
    door.pos = { x: 20.8, y: 20 } // put it in reach of the player
    interactionSystem(w, interactCmd())
    expect(door.door!.overgrown).toBe(true)
    expect(door.door!.open).toBe(false)
    expect(w.events.some((e) => e.type === 'sealDenied' && e.sealKind === 'overgrown')).toBe(true)
  })

  it('FIRE erodes the growth to 0 and unseals it (sealOpen via fire)', () => {
    const w = createWorld(2, 1, 'normal', false)
    const node = spawnObject(w, 'sporeNode', 40, 40) // kept alive & far from the fire
    const door = overgrownHatch(w, 20, 20, 4, node.id)
    igniteCell(w, 20, 20) // a molotov splash on the hatch cell
    let cleared = false
    for (let t = 0; t < 60 && !cleared; t++) {
      tickWorld(w, idle())
      cleared = door.door!.overgrown === false
    }
    expect(door.door!.overgrown).toBe(false)
    expect(door.door!.locked).toBe(false)
    expect(door.door!.open).toBe(true)
  })

  it('killing the linked Spore Node unseals every hatch that references it', () => {
    const w = createWorld(3, 1, 'normal', false)
    const node = spawnObject(w, 'sporeNode', 30, 30)
    const a = overgrownHatch(w, 20, 20, 99, node.id)
    const b = overgrownHatch(w, 22, 20, 99, node.id)
    node.dead = true // shot / burned / blasted down
    interactionSystem(w, idle())
    for (const d of [a, b]) {
      expect(d.door!.overgrown).toBe(false)
      expect(d.door!.locked).toBe(false)
    }
    expect(w.events.filter((e) => e.type === 'sealOpen' && e.via === 'node')).toHaveLength(2)
  })

  it('BREACH ruptures the spore-sac: unseals AND floods the breach with spreading spores', () => {
    const w = createWorld(4, 1, 'normal', false)
    const node = spawnObject(w, 'sporeNode', 40, 40)
    const door = overgrownHatch(w, 20, 20, 6, node.id)
    const alarmBefore = w.alarm
    detonate(w, 20.5, 20.5, 1.8, 40, 1)
    expect(door.door!.overgrown).toBe(false)
    expect(door.door!.open).toBe(true)
    expect(w.events.some((e) => e.type === 'doorBreach' && e.entityId === door.id)).toBe(true)
    expect(w.events.some((e) => e.type === 'sealOpen' && e.via === 'breach')).toBe(true)
    expect(w.alarm).toBe(alarmBefore + 1) // a breached seal is LOUD
    expect(w.entities.some((e) => e.spore)).toBe(true) // spore-sac ruptured
  })
})

describe('spore element — the choking damage-over-time', () => {
  it('a body standing in a spore cloud takes the spore DOT and carries the status out', () => {
    const w = createWorld(5, 1, 'normal', false)
    const npc = addEntity(w, makeEntity('npc', 'civilian', 20.5, 20.5, 0.35))
    npc.health = { hp: 20, max: 20, iframes: 0 }
    npc.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    spawnSporeBurst(w, 20, 20)
    for (let t = 0; t < 24; t++) tickWorld(w, idle())
    expect(npc.health!.hp).toBeLessThan(20) // spore dot gnawed it
    expect(npc.fx?.spore).toBeDefined() // and the status rides on the body
  })
})

describe('contain mission — bloom is a SOFT-fail, never a loss', () => {
  const containWorld = (): { w: World; node: Entity } => {
    const w = createWorld(6, 1, 'normal', false)
    const node = spawnObject(w, 'sporeNode', 20, 20)
    spawnPlayer(w, 0, 40, 40)
    w.mission = {
      template: 'contain',
      targetEntityId: node.id,
      targetBuilding: 0,
      complete: false,
      exitUnlocked: false,
      description: 'Destroy the Spore Node',
      bloomTick: w.tick + 5,
    }
    return { w, node }
  }

  it('letting the node live past its bloom tick floods the room with spores but does NOT end the run', () => {
    const { w, node } = containWorld()
    let bloomEvents = 0
    for (let t = 0; t < 10; t++) {
      tickWorld(w, idle(0))
      bloomEvents += w.events.filter((e) => e.type === 'bloom').length // events reset per tick
    }
    expect(w.mission.bloomed).toBe(true)
    expect(w.gameOver).toBe(false)
    expect(w.mission.complete).toBe(false) // still the same objective, just harder
    expect(bloomEvents).toBe(1)
    expect(sporeAt(w, Math.floor(node.pos.x), Math.floor(node.pos.y))).toBe(true)
  })

  it('destroying the node completes the mission (bloomed or not) and unlocks the exit', () => {
    const { w, node } = containWorld()
    node.dead = true
    missionSystem(w)
    expect(w.mission.complete).toBe(true)
    expect(w.mission.exitUnlocked).toBe(true)
  })

  it('the bloom latches once — a second pass does not re-emit or re-burst', () => {
    const { w } = containWorld()
    for (let t = 0; t < 10; t++) tickWorld(w, idle(0))
    w.events.length = 0
    missionSystem(w)
    expect(w.events.some((e) => e.type === 'bloom')).toBe(false)
  })
})

describe('serialize: an overgrown hatch mid-erosion round-trips', () => {
  it('survives a snapshot with its growthHp, nodeId and flags intact', () => {
    const w = createWorld(7, 1, 'normal', false)
    const node = spawnObject(w, 'sporeNode', 30, 30)
    overgrownHatch(w, 20, 20, 5, node.id)
    const j = serializeWorld(w)
    const w2 = deserializeWorld(j)
    expect(serializeWorld(w2)).toEqual(j)
    const door2 = w2.entities.find((e) => e.door)!
    expect(door2.door!.overgrown).toBe(true)
    expect(door2.door!.growthHp).toBe(5)
    expect(door2.door!.nodeId).toBe(node.id)
  })
})
