// #84 — the floor draft wired into floor progression. Every test sets the world
// exactly (a real populated floor, round-tripped through serialize/deserialize),
// walks a player onto the exit through the real `tickWorld`, and asserts on what
// the systems did with the hand.

import { describe, expect, it } from 'vitest'
import { SPAWN_GRACE_TICKS, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { populateWorld } from '../populate'
import { applyScenario } from '../scenarios'
import { deserializeWorld, serializeWorld } from '../serialize'
import { playerSpawnPoint } from '../spawnPlacement'
import { expectWorldEqual, runTicks } from '../testkit'
import { emptyInput, type InputCmd, type SimEvent } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'
import { weaponStack } from './inventory'
import { dealFloorDraft, DRAFT_TICKS, draftSystem, floorDraftOffer, floorTraitOffer, handCards } from './draft'
import { nextFloor, setupFloor } from './missions'

const SEED = 7

/** A real floor-1 run with `players` players, rehydrated from its snapshot. */
const run = (players = 1, seed = SEED): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  for (let i = 0; i < players; i++) {
    const at = playerSpawnPoint(w.level, i)
    spawnPlayer(w, i, at.x, at.y)
  }
  return deserializeWorld(serializeWorld(w))
}

const player = (w: World, id = 0): Entity => w.entities.find((e) => e.playerCtl?.playerId === id)!

/** Stand player `id` on the unlocked exit and run one tick: the real floor advance. */
const takeExit = (w: World, id = 0): SimEvent[] => {
  w.mission.exitUnlocked = true
  const p = player(w, id)
  p.pos.x = p.prevPos.x = w.level.exit.x + 0.5
  p.pos.y = p.prevPos.y = w.level.exit.y + 0.5
  tickWorld(w, new Map())
  return [...w.events]
}

const step = (w: World, cmds: Record<number, Partial<InputCmd>> = {}): SimEvent[] => {
  tickWorld(w, new Map(Object.entries(cmds).map(([k, c]) => [Number(k), { ...emptyInput(), ...c }])))
  return [...w.events]
}

const picks = (events: SimEvent[]) => events.filter((e) => e.type === 'draftPick')
const traitPicks = (events: SimEvent[]) => events.filter((e) => e.type === 'traitPick')
const anyPicks = (events: SimEvent[]) => events.filter((e) => e.type === 'draftPick' || e.type === 'traitPick')
const modsOf = (p: Entity) => weaponStack(p)?.mods ?? []

describe('floor draft — dealt on floor advance', () => {
  it('taking the exit hands every player the deterministic hand for the floor just cleared', () => {
    const w = run(2)
    const events = takeExit(w)
    expect(w.floor).toBe(2)
    expect(events.some((e) => e.type === 'floorChange')).toBe(true)
    const offer = floorDraftOffer(SEED, 1)
    const trait = floorTraitOffer(SEED, 1)!
    expect(offer).toHaveLength(2)
    expect(trait).toBeDefined()
    for (const id of [0, 1]) {
      expect(player(w, id).playerCtl!.draft).toEqual({ offer, trait, cursor: 0, until: w.tick - 1 + DRAFT_TICKS, held: 7 })
    }
  })

  it('every hand is two gun cards then exactly one YOU card, and the gun cards are the ones main dealt', () => {
    for (const seed of [1, 7, 42, 1234, 0xdeadbeef]) {
      const w = run(1, seed)
      takeExit(w)
      const cards = handCards(player(w).playerCtl!.draft!)
      expect(cards.map((c) => c.kind), `seed ${seed}`).toEqual(['mod', 'mod', 'trait'])
      // The gun cards are the first two of the three-card offer main dealt for this floor.
      expect(cards.slice(0, 2).map((c) => c.id)).toEqual(floorDraftOffer(seed, 1, 3).slice(0, 2))
    }
  })

  it('perturbs nothing else: same world as a bare nextFloor apart from the hands', () => {
    const a = run(2)
    const b = run(2)
    takeExit(a)
    b.mission.exitUnlocked = true
    const p = player(b)
    p.pos.x = p.prevPos.x = b.level.exit.x + 0.5
    p.pos.y = p.prevPos.y = b.level.exit.y + 0.5
    tickWorld(b, new Map()) // b is the same tick; strip the hands and compare
    for (const e of a.entities) delete e.playerCtl?.draft
    for (const e of b.entities) delete e.playerCtl?.draft
    expectWorldEqual(a, b)
    expect(a.rng.state()).toBe(b.rng.state())
    expect(a.baseRng.state()).toBe(b.baseRng.state())
  })

  it('does not draw from the sim RNG: the stream position after the deal equals a deal-free advance', () => {
    const a = run()
    const b = run()
    nextFloor(a)
    nextFloor(b)
    dealFloorDraft(a, 1)
    expect(a.rng.state()).toBe(b.rng.state())
    for (const e of a.entities) delete e.playerCtl?.draft
    expectWorldEqual(a, b)
  })

  it("a scenario's floor jump opens no hand (only the exit deals)", () => {
    const w = run()
    expect(applyScenario(w, 'stairs-demo', { floor: 3 })).toBe(true)
    expect(w.floor).toBe(3)
    expect(w.entities.some((e) => e.playerCtl?.draft)).toBe(false)
  })

  it('a floor with nobody on it deals to nobody and does not throw', () => {
    const w = run(0)
    nextFloor(w)
    expect(() => dealFloorDraft(w, 1)).not.toThrow()
    w.entities = []
    w.byId.clear()
    expect(() => dealFloorDraft(w, 1)).not.toThrow()
    expect(() => step(w, { 0: { draftPick: 0 } })).not.toThrow()
  })
})

describe('floor draft — choosing', () => {
  it('a stick press moves the cursor once per press, wraps both ways, and a held stick does not repeat', () => {
    const w = run()
    takeExit(w)
    const hand = () => player(w).playerCtl!.draft!
    step(w) // release everything held at the deal
    step(w, { 0: { moveX: 1 } })
    expect(hand().cursor).toBe(1)
    for (let i = 0; i < 20; i++) step(w, { 0: { moveX: 1 } })
    expect(hand().cursor).toBe(1)
    step(w)
    step(w, { 0: { moveX: 1 } })
    step(w)
    step(w, { 0: { moveY: 1 } })
    expect(hand().cursor).toBe(0) // 1 → 2 → wrap to 0
    step(w)
    step(w, { 0: { moveX: -1 } })
    expect(hand().cursor).toBe(2)
    expect(picks(w.events)).toEqual([])
  })

  it('a stick or trigger held from walking onto the exit does nothing until released', () => {
    const w = run()
    takeExit(w)
    for (let i = 0; i < 10; i++) step(w, { 0: { moveX: 1, attack: true } })
    expect(player(w).playerCtl!.draft!.cursor).toBe(0)
    expect(modsOf(player(w))).toEqual([])
  })

  it('a fresh A press takes the card under the cursor onto the gun, with a landing grace', () => {
    const w = run()
    takeExit(w)
    const offer = player(w).playerCtl!.draft!.offer
    step(w)
    step(w, { 0: { moveX: 1 } })
    step(w)
    const events = step(w, { 0: { attack: true } })
    const p = player(w)
    expect(p.playerCtl!.draft).toBeUndefined()
    expect(modsOf(p)).toEqual([{ id: offer[1], stacks: 1 }])
    expect(picks(events)).toEqual([
      { type: 'draftPick', byId: p.id, modId: offer[1], weapon: weaponStack(p)!.itemId, maxed: false, timedOut: false },
    ])
    expect(p.health!.iframes).toBeGreaterThanOrEqual(SPAWN_GRACE_TICKS - 1)
    // The confirm press is swallowed: no shot left the gun on the pick tick.
    expect(w.entities.some((e) => e.projectile?.ownerId === p.id)).toBe(false)
  })

  it('interact (keyboard E, pad B) also takes the card', () => {
    const w = run()
    takeExit(w)
    const offer = player(w).playerCtl!.draft!.offer
    step(w)
    step(w, { 0: { interact: true } })
    expect(modsOf(player(w))).toEqual([{ id: offer[0], stacks: 1 }])
  })

  it('a tapped card (draftPick) takes that card even while the stick is held', () => {
    const w = run()
    takeExit(w)
    const offer = player(w).playerCtl!.draft!.offer
    step(w, { 0: { draftPick: 1, moveX: 1, attack: true } })
    expect(modsOf(player(w))).toEqual([{ id: offer[1], stacks: 1 }])
    expect(player(w).playerCtl!.traits).toBeUndefined()
  })

  it('the YOU card puts a trait on the player and leaves the gun alone', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    const trait = p.playerCtl!.draft!.trait!
    const events = step(w, { 0: { draftPick: 2 } })
    expect(p.playerCtl!.draft).toBeUndefined()
    expect(p.playerCtl!.traits).toEqual([{ id: trait, stacks: 1 }])
    expect(modsOf(p)).toEqual([])
    expect(traitPicks(events)).toEqual([{ type: 'traitPick', byId: p.id, traitId: trait, stacks: 1, maxed: false, timedOut: false }])
    expect(picks(events)).toEqual([])
    expect(p.health!.iframes).toBeGreaterThanOrEqual(SPAWN_GRACE_TICKS - 1)
  })

  it('two local players pick different cards from the same hand: one a gun card, one the YOU card', () => {
    const w = run(2)
    takeExit(w)
    const { offer, trait } = player(w, 0).playerCtl!.draft!
    step(w)
    step(w, { 0: { moveX: -1 }, 1: { moveX: 1 } }) // P1 wraps to the YOU card, P2 steps to gun card 1
    step(w, { 0: {}, 1: {} })
    const events = step(w, { 0: { attack: true }, 1: { interact: true } })
    expect(traitPicks(events)).toEqual([expect.objectContaining({ byId: player(w, 0).id, traitId: trait })])
    expect(picks(events)).toEqual([expect.objectContaining({ byId: player(w, 1).id, modId: offer[1] })])
    expect(player(w, 0).playerCtl!.traits).toEqual([{ id: trait, stacks: 1 }])
    expect(modsOf(player(w, 0))).toEqual([])
    expect(player(w, 1).playerCtl!.traits).toBeUndefined()
    expect(modsOf(player(w, 1))).toEqual([{ id: offer[1], stacks: 1 }])
  })

  it('a YOU card already held at its cap is a spent pick: reported maxed, nothing stacks', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    const trait = p.playerCtl!.draft!.trait!
    p.playerCtl!.traits = [{ id: trait, stacks: 99 }]
    const events = step(w, { 0: { draftPick: 2 } })
    expect(traitPicks(events)[0]).toMatchObject({ traitId: trait, maxed: true, stacks: 99 })
    expect(p.playerCtl!.traits).toEqual([{ id: trait, stacks: 99 }])
  })

  it('a YOU card naming a trait this build does not know closes the hand without a crash', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    p.playerCtl!.draft!.trait = 'no-such-trait'
    const events = step(w, { 0: { draftPick: 2 } })
    expect(p.playerCtl!.draft).toBeUndefined()
    expect(p.playerCtl!.traits).toBeUndefined()
    expect(traitPicks(events)[0]).toMatchObject({ traitId: 'no-such-trait', maxed: true, stacks: 0 })
  })

  it('ignores a bogus draftPick: out of range, negative, fractional, NaN', () => {
    const w = run()
    takeExit(w)
    for (const bad of [3, 255, -1, 0.5, NaN, Infinity]) step(w, { 0: { draftPick: bad } })
    expect(player(w).playerCtl!.draft).toBeDefined()
    expect(modsOf(player(w))).toEqual([])
    expect(player(w).playerCtl!.traits).toBeUndefined()
  })

  it('stacks onto a mod the gun already has, and reports a maxed one', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    const offer = p.playerCtl!.draft!.offer
    weaponStack(p)!.mods = [{ id: offer[0], stacks: 99 }]
    const events = step(w, { 0: { draftPick: 0 } })
    expect(picks(events)[0]).toMatchObject({ modId: offer[0], maxed: true })
    expect(weaponStack(p)!.mods).toHaveLength(1)
  })

  it('a gunless player still closes the hand (weapon "none") rather than hanging on it', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    p.loadout = { inventory: [], activeSlot: -1 }
    p.combat = { weapon: 'fists', cooldown: 0 }
    const events = step(w, { 0: { draftPick: 1 } })
    expect(p.playerCtl!.draft).toBeUndefined()
    expect(picks(events)[0]).toMatchObject({ weapon: 'none' })
  })
})

describe('floor draft — while a player is choosing', () => {
  it('the drafter stands still, cannot fire, and cannot be hurt', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    const at = { ...p.pos }
    // The trigger is held from the moment of the deal, so it never becomes a confirm press.
    for (let i = 0; i < 60; i++) step(w, { 0: { moveX: 0.3, moveY: 0.3, attack: true, special: true, roll: true, throwItem: true } })
    expect(p.playerCtl!.draft).toBeDefined()
    expect(p.pos).toEqual(at)
    expect(w.entities.some((e) => e.projectile?.ownerId === p.id)).toBe(false)
    const hp = p.health!.hp
    p.health!.iframes = 0 // spawn grace long gone: the hand alone must protect them
    step(w)
    expect(applyDamage(w, p, 50, p.pos.x + 1, p.pos.y, 0, 0)).toBeNull()
    expect(p.health!.hp).toBe(hp)
  })

  it('the rest of the party is never stalled: a player who has picked walks while the other still chooses', () => {
    const w = run(2)
    takeExit(w)
    const tick = w.tick
    step(w, { 0: { draftPick: 0 } })
    const walker = player(w, 0)
    const chooser = player(w, 1)
    const from = { ...walker.pos }
    const still = { ...chooser.pos }
    runTicks(w, new Map([[0, { moveX: 1 }], [1, { moveX: 1 }]]), 30)
    expect(w.tick).toBe(tick + 31)
    expect(Math.hypot(walker.pos.x - from.x, walker.pos.y - from.y)).toBeGreaterThan(0.5)
    // nextFloor lands everyone on the one spawn point, so the walker's body may
    // nudge the chooser aside; the chooser's own stick moves nothing.
    expect(Math.hypot(chooser.pos.x - still.x, chooser.pos.y - still.y)).toBeLessThan(0.5)
    expect(chooser.playerCtl!.draft).toBeDefined()
  })

  it('co-op players choose independently: separate cursors, separate cards', () => {
    const w = run(2)
    takeExit(w)
    const offer = player(w).playerCtl!.draft!.offer
    step(w)
    step(w, { 1: { moveX: 1 } })
    step(w, { 1: { moveX: 1 }, 0: { attack: true } })
    step(w, { 1: {} })
    step(w, { 1: { interact: true } })
    expect(modsOf(player(w, 0))).toEqual([{ id: offer[0], stacks: 1 }])
    expect(modsOf(player(w, 1))).toEqual([{ id: offer[1], stacks: 1 }])
  })

  it('an unanswered hand takes the highlighted card at the deadline, exactly then', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    const { trait, until } = p.playerCtl!.draft!
    step(w)
    step(w, { 0: { moveX: -1 } }) // cursor → 2, the YOU card
    while (w.tick < until) expect(anyPicks(step(w))).toEqual([])
    const events = step(w)
    expect(anyPicks(events)).toEqual([expect.objectContaining({ type: 'traitPick', traitId: trait, timedOut: true })])
    expect(p.playerCtl!.draft).toBeUndefined()
    expect(p.playerCtl!.traits).toEqual([{ id: trait, stacks: 1 }])
  })

  it('a teammate taking the next exit before you chose keeps the card you were on, then deals the new hand', () => {
    const w = run(2)
    takeExit(w)
    const first = player(w, 1).playerCtl!.draft!.offer
    step(w, { 0: { draftPick: 0 } })
    step(w, { 1: { moveX: 1 } })
    const events = takeExit(w, 0)
    expect(w.floor).toBe(3)
    expect(picks(events)).toEqual([expect.objectContaining({ byId: player(w, 1).id, modId: first[1], timedOut: true })])
    expect(player(w, 1).playerCtl!.draft!.offer).toEqual(floorDraftOffer(SEED, 2))
    expect(player(w, 0).playerCtl!.draft!.offer).toEqual(floorDraftOffer(SEED, 2))
  })

  it('a dead player with a hand is skipped: no pick, no crash, no input rewrite', () => {
    const w = run(2)
    takeExit(w)
    const dead = player(w, 1)
    dead.dead = true
    const inputs = new Map([[1, { ...emptyInput(), moveX: 1 }]])
    const seen = draftSystem(w, inputs)
    expect(seen.get(1)).toBe(inputs.get(1))
    expect(dead.playerCtl!.draft).toBeDefined()
    // and a dead player at the deal gets no hand
    delete dead.playerCtl!.draft
    dealFloorDraft(w, 2)
    expect(dead.playerCtl!.draft).toBeUndefined()
  })

  it('a player who joins mid-floor gets no hand now, and one at the next exit', () => {
    const w = run(1)
    takeExit(w)
    step(w, { 0: { draftPick: 0 } })
    const at = playerSpawnPoint(w.level, 1)
    const late = spawnPlayer(w, 1, at.x, at.y)
    step(w, { 1: { moveX: 1 } })
    expect(late.playerCtl!.draft).toBeUndefined()
    takeExit(w, 0)
    expect(late.playerCtl!.draft!.offer).toEqual(floorDraftOffer(SEED, 2))
    expect(late.playerCtl!.draft!.trait).toBe(floorTraitOffer(SEED, 2))
  })

  it('survives a corrupted hand: an empty offer closes, an out-of-range cursor resets', () => {
    const w = run()
    takeExit(w)
    const p = player(w)
    p.playerCtl!.draft!.cursor = 99
    step(w)
    expect(p.playerCtl!.draft!.cursor).toBe(0)
    p.playerCtl!.draft!.offer = []
    delete p.playerCtl!.draft!.trait
    expect(() => step(w, { 0: { attack: true } })).not.toThrow()
    expect(p.playerCtl!.draft).toBeUndefined()
    expect(modsOf(p)).toEqual([])
    expect(p.playerCtl!.traits).toBeUndefined()
  })
})

describe('floor draft — replay', () => {
  it('a mid-draft snapshot resumes byte-identically under the same inputs', () => {
    const w = run(2)
    takeExit(w)
    step(w, { 1: { moveX: 1 } })
    const copy = deserializeWorld(serializeWorld(w))
    expectWorldEqual(w, copy)
    const script: Record<number, Partial<InputCmd>>[] = [{}, { 0: { moveX: 1 } }, { 0: {}, 1: {} }, { 0: { attack: true }, 1: { draftPick: 2 } }, { 0: { moveX: 1 } }]
    for (const cmds of script) {
      step(w, cmds)
      step(copy, cmds)
    }
    runTicks(w, new Map([[0, { moveX: 1, attack: true }]]), 40)
    runTicks(copy, new Map([[0, { moveX: 1, attack: true }]]), 40)
    expectWorldEqual(w, copy)
    expect(w.entities.filter((e) => e.playerCtl?.draft)).toHaveLength(0)
  })
})
