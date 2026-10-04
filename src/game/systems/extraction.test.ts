// `extraction` missions (#85): grab the prize → station alert → get back out
// the way you came. Covers the RNG-stream guarantee (an extraction world is the
// same world with its extraction roll denied, apart from the mission rules),
// the full loop, carrier loss in solo and co-op, a mid-floor late join, and the
// empty floor.

import { describe, expect, it } from 'vitest'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, stationAlerted, tickWorld, worldFromState, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, loadFixture, runTicks } from '../testkit'
import type { Entity } from '../entity'
import { extractionView, setupFloor } from './missions'

const boot = (seed: number, floor: number): World => setUp(createWorld(seed, floor))

const setUp = (w: World): World => {
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return w
}

const idle = (...slots: number[]): Map<number, Partial<InputCmd>> => new Map(slots.map((s) => [s, emptyInput()]))

/** A world on an authored level (one of the frozen fixtures' maps). */
const authoredAt = (fixture: string, seed: number, floor: number): World =>
  worldFromState({ level: loadFixture(fixture).level, seed, floor })

/** `setUp`, with the extraction roll denied: the world as it was before
 * extraction missions existed. */
const setUpWithoutExtraction = (w: World): World => {
  const fork = w.rng.fork
  w.rng.fork = (label) => (label === 'extraction' ? { ...fork(label), chance: () => false } : fork(label))
  setUp(w)
  w.rng.fork = fork
  return w
}

/** First seed whose floor-2 mission rolled an extraction. */
const extractionSeed = (() => {
  for (let seed = 1; seed < 200; seed++) {
    const w = createWorld(seed, 2)
    populateWorld(w)
    setupFloor(w)
    if (w.mission.template === 'extraction') return seed
  }
  throw new Error('no extraction seed')
})()

const player = (w: World, slot = 0): Entity => w.entities.find((e) => e.playerCtl?.playerId === slot)!
const prize = (w: World): Entity => w.byId.get(w.mission.targetEntityId!)!
const place = (e: Entity, x: number, y: number): void => {
  e.pos.x = e.prevPos.x = x
  e.pos.y = e.prevPos.y = y
  e.vel.x = e.vel.y = 0
}
const holds = (e: Entity): boolean => (e.loadout?.inventory ?? []).some((s) => s.itemId === 'canister')
/** A fresh world rebuilt from its own JSON: every scenario below runs on state set exactly. */
const exact = (w: World): World => deserializeWorld(serializeWorld(w))
const grab = (w: World, slot = 0): void => {
  const it = prize(w)
  place(player(w, slot), it.pos.x, it.pos.y)
  runTicks(w, idle(...w.entities.filter((e) => e.playerCtl).map((e) => e.playerCtl!.playerId)), 1)
}

describe('adding extraction leaves the RNG stream alone', () => {
  /** Build a world twice, rolled and with the extraction roll denied, and
   * assert they differ only in the mission rules. True if it rolled one. */
  const expectOnlyRulesDiffer = (make: () => World, ctx: string): boolean => {
    const rolled = runTicks(setUp(make()), idle(0), 30)
    const denied = runTicks(setUpWithoutExtraction(make()), idle(0), 30)
    const converted = rolled.mission.template === 'extraction'
    if (converted) {
      expect(denied.mission.template, ctx).toBe('steal')
      const wing = /in the (.+), then get out/.exec(rolled.mission.description)![1]
      rolled.mission.template = 'steal'
      rolled.mission.description = `Extract the specimen canister from the ${wing}`
      delete rolled.mission.extractPoint
    }
    expect(serializeWorld(rolled), ctx).toEqual(serializeWorld(denied))
    return converted
  }

  it('an extraction world is the same world with the roll denied, apart from its mission rules', () => {
    let converted = 0
    let kept = 0
    for (const fixture of ['frozen-1-3', 'frozen-2-4', 'frozen-42-5', 'frozen-9-4']) {
      for (let seed = 1; seed <= 6; seed++) {
        for (const floor of [2, 3, 5]) {
          if (expectOnlyRulesDiffer(() => authoredAt(fixture, seed, floor), `${fixture} seed ${seed} floor ${floor}`)) converted++
          else kept++
        }
      }
    }
    expect(converted).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(0)
  })

  // The generator is the subject here, so these worlds come from the seed.
  it('the same holds on generated floors 2-5, seeds 1-12', () => {
    let converted = 0
    let kept = 0
    for (let seed = 1; seed <= 12; seed++) {
      for (let floor = 2; floor <= 5; floor++) {
        if (expectOnlyRulesDiffer(() => createWorld(seed, floor), `seed ${seed} floor ${floor}`)) converted++
        else kept++
      }
    }
    expect(converted).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(0)
  })

  it('floor 1 never rolls an extraction, and the roll is a pure function of seed+floor', () => {
    for (let seed = 1; seed <= 40; seed++) expect(boot(seed, 1).mission.template).not.toBe('extraction')
    for (let seed = 1; seed <= 20; seed++) expect(boot(seed, 3).mission).toEqual(boot(seed, 3).mission)
  })

  it('both steal and extraction still appear past floor 1', () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) for (const floor of [2, 3, 4]) seen.add(boot(seed, floor).mission.template)
    expect(seen.has('steal')).toBe(true)
    expect(seen.has('extraction')).toBe(true)
  })
})

describe('extraction loop', () => {
  it('generates a prize in the target building and an extraction point on the entry', () => {
    const w = boot(extractionSeed, 2)
    expect(w.mission.extractPoint).toEqual({ x: Math.floor(w.level.spawn.x), y: Math.floor(w.level.spawn.y) })
    expect(prize(w).pickup?.itemId).toBe('canister')
    expect(extractionView(w)).toEqual({ ...w.mission.extractPoint, held: false })
    expect(stationAlerted(w)).toBe(false)
  })

  it('pickup raises the alert but does not complete; the entry completes and leaves the floor', () => {
    const w = exact(boot(extractionSeed, 2))
    grab(w)
    const p = player(w)
    expect(holds(p)).toBe(true)
    expect(stationAlerted(w)).toBe(true)
    expect(w.mission.alertFocusId).toBe(p.id)
    expect(w.mission.complete).toBe(false)
    expect(w.mission.exitUnlocked).toBe(false)
    expect(extractionView(w)?.held).toBe(true)

    // The Launch Bay stays shut: standing on it with the prize goes nowhere.
    place(p, w.level.exit.x + 0.5, w.level.exit.y + 0.5)
    runTicks(w, idle(0), 3)
    expect(w.floor).toBe(2)
    expect(w.mission.complete).toBe(false)

    const at = w.mission.extractPoint!
    place(p, at.x + 0.5, at.y + 0.5)
    tickWorld(w, new Map([[0, emptyInput()]]))
    const types = w.events.map((e) => e.type)
    expect(types).toContain('missionComplete')
    expect(types).toContain('floorChange')
    expect(types.filter((t) => t === 'stationAlert')).toHaveLength(0) // latched at pickup, never re-fired
    expect(w.floor).toBe(3)
    expect(holds(p)).toBe(false)
  })

  it('a mid-escape snapshot resumes byte-identically', () => {
    const a = exact(boot(extractionSeed, 2))
    grab(a)
    runTicks(a, idle(0), 20)
    const b = exact(a)
    runTicks(a, idle(0), 90)
    runTicks(b, idle(0), 90)
    expectWorldEqual(a, b)
  })

  it('a solo carrier who goes down drops the prize where they fell, and re-grabs it on their feet', () => {
    const w = exact(boot(extractionSeed, 2))
    grab(w)
    const p = player(w)
    const oldPrizeId = w.mission.targetEntityId
    place(p, p.pos.x + 0.2, p.pos.y) // nudge off the old pickup spot
    const fell = { x: p.pos.x, y: p.pos.y }
    p.playerCtl!.downed = { bleedTicks: 90, reviveProgress: 0 }
    tickWorld(w, idle(0) as Map<number, InputCmd>)
    expect(holds(p)).toBe(false)
    const dropped = prize(w)
    expect(w.mission.targetEntityId).not.toBe(oldPrizeId)
    expect(dropped.dead).toBeFalsy()
    expect(dropped.pos).toEqual(fell)
    expect(w.events.some((e) => e.type === 'prizeDropped' && e.entityId === dropped.id && e.byId === p.id)).toBe(true)
    expect(extractionView(w)?.held).toBe(false)
    expect(w.mission.complete).toBe(false)

    // Standing on the entry while downed does nothing either.
    const at = w.mission.extractPoint!
    place(p, at.x + 0.5, at.y + 0.5)
    runTicks(w, idle(0), 3)
    expect(w.floor).toBe(2)

    // Back on their feet at the drop, they pick it up again.
    p.playerCtl!.downed = undefined
    place(p, dropped.pos.x, dropped.pos.y)
    runTicks(w, idle(0), 1)
    expect(holds(p)).toBe(true)
    expect(extractionView(w)?.held).toBe(true)
  })

  it('co-op: a dead carrier drops the prize, a teammate carries it out, and the alert fires once', () => {
    const w = boot(extractionSeed, 2)
    spawnPlayer(w, 1, w.level.spawn.x, w.level.spawn.y)
    const s = exact(w)
    grab(s, 0)
    const a = player(s, 0)
    const b = player(s, 1)
    a.dead = true
    runTicks(s, idle(0, 1), 1)
    expect(holds(a)).toBe(false)
    const dropped = prize(s)
    expect(dropped.pos).toEqual(a.pos)

    place(b, dropped.pos.x, dropped.pos.y)
    runTicks(s, idle(0, 1), 1)
    expect(holds(b)).toBe(true)
    expect(s.events.some((e) => e.type === 'stationAlert')).toBe(false)

    const at = s.mission.extractPoint!
    place(b, at.x + 0.5, at.y + 0.5)
    runTicks(s, idle(0, 1), 1)
    expect(s.floor).toBe(3)
  })

  it('co-op: a teammate standing on the entry without the prize does not extract', () => {
    const w = boot(extractionSeed, 2)
    spawnPlayer(w, 1, w.level.spawn.x, w.level.spawn.y)
    const s = exact(w)
    grab(s, 0) // player 0 holds it deep in the building; player 1 idles on the entry
    const at = s.mission.extractPoint!
    place(player(s, 1), at.x + 0.5, at.y + 0.5)
    runTicks(s, idle(0, 1), 10)
    expect(s.floor).toBe(2)
    expect(s.mission.complete).toBe(false)
  })

  it('a mid-floor late joiner lands on the entry without extracting, and can carry the prize out', () => {
    const w = exact(boot(extractionSeed, 2))
    grab(w, 0)
    player(w, 0).playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 } // solo death would end the run
    runTicks(w, idle(0), 1) // prize dropped deep in the building
    const late = spawnPlayer(w, 1, w.level.spawn.x, w.level.spawn.y)
    runTicks(w, idle(0, 1), 5)
    expect(w.floor).toBe(2)
    place(late, prize(w).pos.x, prize(w).pos.y)
    runTicks(w, idle(0, 1), 1)
    expect(holds(late)).toBe(true)
    const at = w.mission.extractPoint!
    place(late, at.x + 0.5, at.y + 0.5)
    runTicks(w, idle(0, 1), 1)
    expect(w.floor).toBe(3)
  })

  it('dropping keeps the active slot on the same stack', () => {
    const w = exact(boot(extractionSeed, 2))
    grab(w)
    const p = player(w)
    const ld = p.loadout!
    ld.inventory = [{ itemId: 'canister', qty: 1 }, ...ld.inventory.filter((s) => s.itemId !== 'canister')]
    ld.activeSlot = ld.inventory.length - 1
    const active = ld.inventory[ld.activeSlot]
    p.playerCtl!.downed = { bleedTicks: 90, reviveProgress: 0 }
    runTicks(w, idle(0), 1)
    expect(ld.inventory[ld.activeSlot]).toBe(active)
  })

  it('an empty floor (no buildings) stays a plain reach with no extraction view', () => {
    const w = createWorld(extractionSeed, 2)
    w.level.buildings = []
    delete w.level.complex
    populateWorld(w)
    setupFloor(w)
    expect(w.mission.template).toBe('reach')
    expect(extractionView(w)).toBeUndefined()
  })
})
