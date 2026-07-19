// Stop-drop-and-roll (#roll-douses-fire): a dodge-roll's START smothers
// DOUSE_TICKS off a burning status — extinguishing it outright when less than
// that remains. Adversarial coverage: exact tick math, the same-tick damage
// rule on both sides, mid-roll ignition, re-ignition between rolls, roll-spam,
// NPC immunity (nothing without playerCtl rolls), gating (stunned can't douse),
// and byte-identical serialize round-trip mid-burn-mid-roll.

import { beforeEach, describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import { makeEntity } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd, type SimEvent } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { igniteCell } from './fire'
import { DOUSE_TICKS, ROLL_COOLDOWN, ROLL_TICKS, rollSystem } from './roll'
import { addStatus, hasStatus } from './statusFx'

/** Full roll cycle: the earliest tick after a roll start that another can start. */
const ROLL_CYCLE = ROLL_TICKS + ROLL_COOLDOWN

/** One-slot input map with `roll` pressed and an optional move vector. */
const rollCmd = (moveX = 0, moveY = 0): Map<number, InputCmd> =>
  new Map([[0, { ...emptyInput(), roll: true, moveX, moveY }]])

const noInput = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

/** A player spawned on the guaranteed-open level spawn tile, grace expired. */
const player = (w: World): Entity => {
  const s = w.level.spawn
  const p = spawnPlayer(w, 0, s.x, s.y)
  p.health!.iframes = 0
  return p
}

/** Run tickWorld once and return the events it emitted (they reset each tick). */
const tickEvents = (w: World, inputs: Map<number, InputCmd>): SimEvent[] => {
  tickWorld(w, inputs)
  return [...w.events]
}

const doused = (evs: SimEvent[]): Extract<SimEvent, { type: 'burnDoused' }>[] =>
  evs.filter((e): e is Extract<SimEvent, { type: 'burnDoused' }> => e.type === 'burnDoused')

describe('roll douses burning — exact tick math', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('sanity: the tuning this suite pins — typical weapon burn 240, douse 150', () => {
    // If either number moves, every pinned tick below moves with it — retune deliberately.
    expect(DOUSE_TICKS).toBe(150)
    expect(ELEMENTS.burning.dot).toBe(2)
    expect(ELEMENTS.burning.interval).toBe(9)
    expect(ROLL_CYCLE).toBe(36)
  })

  it('one roll start cuts exactly DOUSE_TICKS off the remaining burn', () => {
    addStatus(w, p, 'burning', 600) // until = tick + 600
    const until0 = p.fx!.burning.until
    rollSystem(w, rollCmd(1, 0))
    expect(p.fx!.burning.until).toBe(until0 - DOUSE_TICKS)
    const ev = doused(w.events)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toEqual({ type: 'burnDoused', x: p.pos.x, y: p.pos.y, entityId: p.id, remainingTicks: 450 })
  })

  it('a burn with <= DOUSE_TICKS left is extinguished outright (remainingTicks 0)', () => {
    addStatus(w, p, 'burning', DOUSE_TICKS)
    rollSystem(w, rollCmd(1, 0))
    expect(hasStatus(p, 'burning')).toBe(false)
    expect(doused(w.events)[0].remainingTicks).toBe(0)
  })

  it('a fresh 240-tick weapon burn dies in exactly two rolls, out at tick 36 not 240', () => {
    // Roll pressed EVERY tick: rollSystem itself gates re-rolls, so the second
    // roll starts on the first cooldown-clear tick — the earliest legal douse.
    addStatus(w, p, 'burning', 240)
    const events: SimEvent[] = []
    for (let i = 0; i < ROLL_CYCLE; i++) {
      expect(hasStatus(p, 'burning')).toBe(true) // still alight through tick 35
      events.push(...tickEvents(w, rollCmd(1, 0)))
    }
    // Tick 36: cooldown clears, second roll starts, remaining 90-36=54 <= 150 → out.
    events.push(...tickEvents(w, rollCmd(1, 0)))
    expect(hasStatus(p, 'burning')).toBe(false)
    const d = doused(events)
    expect(d).toHaveLength(2)
    expect(d[0].remainingTicks).toBe(90) // 240 - 150
    expect(d[1].remainingTicks).toBe(0) // 90 - 36 elapsed = 54, smothered
  })

  it('roll-spam inside one roll cycle never douses twice', () => {
    addStatus(w, p, 'burning', 1000)
    const until0 = p.fx!.burning.until
    const events: SimEvent[] = []
    for (let i = 0; i < ROLL_CYCLE; i++) events.push(...tickEvents(w, rollCmd(1, 0)))
    expect(doused(events)).toHaveLength(1)
    expect(p.fx!.burning.until).toBe(until0 - DOUSE_TICKS) // one chunk, not 36
  })
})

describe('roll douses burning — the same-tick damage rule', () => {
  // elementSystem lands burn damage when tick % interval === 0. rollSystem runs
  // FIRST in tickWorld, so the rule is: an EXTINGUISHING douse also cancels that
  // tick's fire damage (the status is gone before elementSystem looks); a douse
  // that merely shortens the burn leaves the damage tick intact.
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
    w.tick = ELEMENTS.burning.interval * 4 // a damage-interval tick (36 % 9 === 0)
  })

  it('control: on a damage tick with no roll, the burn bites', () => {
    addStatus(w, p, 'burning', 100)
    const hp = p.health!.hp
    tickWorld(w, noInput())
    expect(p.health!.hp).toBe(hp - ELEMENTS.burning.dot)
  })

  it('an extinguishing douse cancels the same-tick fire damage', () => {
    addStatus(w, p, 'burning', 100) // 100 <= DOUSE_TICKS → extinguish
    const hp = p.health!.hp
    tickWorld(w, rollCmd(1, 0))
    expect(hasStatus(p, 'burning')).toBe(false)
    expect(p.health!.hp).toBe(hp)
  })

  it('a merely-shortening douse still takes the same-tick damage', () => {
    addStatus(w, p, 'burning', 600)
    const hp = p.health!.hp
    tickWorld(w, rollCmd(1, 0))
    expect(hasStatus(p, 'burning')).toBe(true)
    expect(p.health!.hp).toBe(hp - ELEMENTS.burning.dot)
  })
})

describe('roll douses burning — edges and adversaries', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('rolling while NOT burning changes nothing — no event, fx never created', () => {
    rollSystem(w, rollCmd(1, 0))
    expect(p.playerCtl!.roll).toBeDefined() // the roll itself still happens
    expect(p.fx).toBeUndefined() // douse must not conjure an fx bag
    expect(doused(w.events)).toHaveLength(0)
  })

  it('other statuses are untouched — only burning is smotherable', () => {
    addStatus(w, p, 'wet', 100)
    addStatus(w, p, 'poisoned', 100)
    const wet = p.fx!.wet.until
    const poison = p.fx!.poisoned.until
    rollSystem(w, rollCmd(1, 0))
    expect(p.fx!.wet.until).toBe(wet)
    expect(p.fx!.poisoned.until).toBe(poison)
    expect(doused(w.events)).toHaveLength(0)
  })

  it('a burn caught MID-roll sticks: dousing is an instant at roll start, not an aura', () => {
    tickWorld(w, rollCmd(1, 0)) // roll starts (no burn yet)
    addStatus(w, p, 'burning', 240) // ignited mid-tumble
    const until0 = p.fx!.burning.until
    const events: SimEvent[] = []
    // Ride out the rest of the roll + cooldown pressing roll the whole way —
    // nothing may douse until the NEXT roll actually starts.
    for (let i = 1; i < ROLL_CYCLE; i++) events.push(...tickEvents(w, rollCmd(1, 0)))
    expect(doused(events)).toHaveLength(0)
    expect(p.fx!.burning.until).toBe(until0)
    tickWorld(w, rollCmd(1, 0)) // the next roll finally smothers it
    expect(doused(w.events)).toHaveLength(1)
  })

  it('re-ignition between rolls refreshes the clock — the douse is not immunity', () => {
    addStatus(w, p, 'burning', 240)
    tickWorld(w, rollCmd(1, 0)) // roll 1: 240 → 90 left
    addStatus(w, p, 'burning', 240) // molotov'd again: refreshed to a full 240
    for (let i = 1; i < ROLL_CYCLE; i++) tickWorld(w, noInput())
    tickWorld(w, rollCmd(1, 0)) // roll 2 at tick 36
    // Refreshed at tick 1 → until = 241; at tick 36 remaining 205 → douse → 55 left.
    expect(hasStatus(p, 'burning')).toBe(true)
    expect(doused(w.events)[0].remainingTicks).toBe(240 - (ROLL_CYCLE - 1) - DOUSE_TICKS)
  })

  it('rolling INSIDE the flames re-ignites the same tick — roll OUT or keep burning', () => {
    // Park the player dead-centre of a lit cell; a +x roll moves ~0.4 tiles this
    // tick, staying inside the cell, so fireSystem re-applies after the douse.
    const tx = Math.floor(p.pos.x)
    const ty = Math.floor(p.pos.y)
    p.pos.x = tx + 0.5
    p.pos.y = ty + 0.5
    p.flammable = true // fire only ignites flammables; opt this player in
    igniteCell(w, tx, ty)
    addStatus(w, p, 'burning', 100) // small burn: the douse alone would end it
    tickWorld(w, rollCmd(1, 0))
    expect(doused(w.events)).toHaveLength(1) // the douse DID land…
    expect(hasStatus(p, 'burning')).toBe(true) // …but the flames re-lit them
    expect(p.fx!.burning.until).toBe(w.tick - 1 + ELEMENTS.burning.durationTicks) // fresh full clock
  })

  it('a stunned player cannot roll, so cannot douse', () => {
    addStatus(w, p, 'burning', 100)
    p.status!.stun = 10
    const until0 = p.fx!.burning.until
    rollSystem(w, rollCmd(1, 0))
    expect(p.fx!.burning.until).toBe(until0)
    expect(doused(w.events)).toHaveLength(0)
  })

  it('a burning NPC is untouched — nothing without playerCtl rolls', () => {
    const npc = addEntity(w, makeEntity('npc', 'thug', p.pos.x + 3, p.pos.y))
    npc.health = { hp: 30, max: 30, iframes: 0 }
    addStatus(w, npc, 'burning', 600)
    const until0 = npc.fx!.burning.until
    rollSystem(w, rollCmd(1, 0)) // the player rolls right next to it
    expect(npc.fx!.burning.until).toBe(until0)
    const d = doused(w.events)
    expect(d.every((e) => e.entityId !== npc.id)).toBe(true)
  })
})

describe('roll douses burning — serialization & determinism', () => {
  it('mid-burn-mid-roll round-trips byte-identical and continues identically', () => {
    const w = createWorld(7, 1)
    const p = player(w)
    addStatus(w, p, 'burning', 240)
    tickWorld(w, rollCmd(1, 0)) // mid-roll AND mid-(shortened)-burn
    tickWorld(w, rollCmd(0, 1))

    const json = serializeWorld(w)
    const restored = deserializeWorld(JSON.parse(JSON.stringify(json)))
    expect(JSON.stringify(serializeWorld(restored))).toBe(JSON.stringify(json))

    // Same inputs from here — including the second, extinguishing roll — must
    // produce byte-identical worlds (burn state, hp, events, PRNG stream).
    const script = (t: number): Map<number, InputCmd> => (t % ROLL_CYCLE === 0 ? rollCmd(1, 0) : noInput())
    for (let i = 0; i < 80; i++) {
      tickWorld(w, script(i))
      tickWorld(restored, script(i))
    }
    expect(JSON.stringify(serializeWorld(restored))).toBe(JSON.stringify(serializeWorld(w)))
    const rp = restored.entities.find((e) => e.playerCtl)!
    expect(hasStatus(rp, 'burning')).toBe(false) // and the mechanic actually resolved
  })
})
