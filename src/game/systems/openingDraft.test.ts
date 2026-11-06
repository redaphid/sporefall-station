// The run's opening hand: dealt at the landing of floor 1, tick 0. Every test
// sets the world exactly (a real populated floor round-tripped through
// serialize/deserialize), calls the real dealer, and runs the real systems.

import { describe, expect, it } from 'vitest'
import { MODS } from '../data/mods'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { populateWorld } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { playerSpawnPoint } from '../spawnPlacement'
import { expectWorldEqual, runTicks } from '../testkit'
import { createWorld, type World } from '../world'
import { dealFloorDraft, dealOpeningDraft, dealOpeningHand, DRAFT_TICKS, floorDraftOffer, OPENING_DRAFT_STREAM } from './draft'
import { setupFloor } from './missions'

const SEED = 7

const landing = (players = 1, seed = SEED, floor = 1): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  for (let i = 0; i < players; i++) {
    const at = playerSpawnPoint(w.level, i)
    spawnPlayer(w, i, at.x, at.y)
  }
  return deserializeWorld(serializeWorld(w))
}

const player = (w: World, id = 0): Entity => w.entities.find((e) => e.playerCtl?.playerId === id)!

describe('dealOpeningDraft', () => {
  it('deals every live player the same opening hand, closing at DRAFT_TICKS', () => {
    const w = landing(3)
    dealOpeningDraft(w)
    for (let i = 0; i < 3; i++) {
      const hand = player(w, i).playerCtl!.draft!
      expect(hand.opening).toBe(true)
      expect(hand.offer).toEqual(floorDraftOffer(SEED, OPENING_DRAFT_STREAM))
      expect(hand.offer).toHaveLength(3)
      expect(hand.until).toBe(DRAFT_TICKS)
      expect(hand.cursor).toBe(0)
    }
  })

  it('does not collide with the floor-1 exit hand', () => {
    expect(floorDraftOffer(SEED, OPENING_DRAFT_STREAM)).not.toEqual(floorDraftOffer(SEED, 1))
  })

  it('skips a dead player', () => {
    const w = landing(2)
    player(w, 1).dead = true
    dealOpeningDraft(w)
    expect(player(w, 0).playerCtl!.draft).toBeDefined()
    expect(player(w, 1).playerCtl!.draft).toBeUndefined()
  })

  it('is a no-op on a repeat call (hand untouched, no second hand after a pick)', () => {
    const w = landing()
    dealOpeningDraft(w)
    player(w).playerCtl!.draft!.cursor = 2
    dealOpeningDraft(w)
    expect(player(w).playerCtl!.draft!.cursor).toBe(2)
    // Release first (a held button does nothing), then confirm; a repeat once ticking deals nothing.
    runTicks(w, new Map(), 2)
    runTicks(w, new Map([[0, { attack: true }]]), 3)
    expect(player(w).playerCtl!.draft).toBeUndefined()
    dealOpeningDraft(w)
    expect(player(w).playerCtl!.draft).toBeUndefined()
  })

  it('only on floor 1', () => {
    const w = landing(1, SEED, 2)
    dealOpeningDraft(w)
    expect(player(w).playerCtl!.draft).toBeUndefined()
    expect(dealOpeningHand(w, player(w))).toBe(false)
  })

  it('not once the run is under way (tick > 0)', () => {
    const w = landing()
    runTicks(w, new Map(), 1)
    dealOpeningDraft(w)
    expect(player(w).playerCtl!.draft).toBeUndefined()
  })

  it('late join: a player spawned mid-opening gets the hand with the shared deadline', () => {
    const w = landing()
    dealOpeningDraft(w)
    runTicks(w, new Map(), 30)
    const at = playerSpawnPoint(w.level, 1)
    const late = spawnPlayer(w, 1, at.x, at.y)
    expect(dealOpeningHand(w, late)).toBe(true)
    expect(late.playerCtl!.draft).toMatchObject({ opening: true, until: DRAFT_TICKS })
    expect(late.playerCtl!.draft!.offer).toEqual(player(w, 0).playerCtl!.draft!.offer)
  })

  it('late join after the deadline lands with no hand', () => {
    const w = landing()
    w.tick = DRAFT_TICKS
    const at = playerSpawnPoint(w.level, 1)
    const late = spawnPlayer(w, 1, at.x, at.y)
    expect(dealOpeningHand(w, late)).toBe(false)
    expect(late.playerCtl!.draft).toBeUndefined()
  })

  it('never deals to a non-player or a dead entity', () => {
    const w = landing()
    const npc = w.entities.find((e) => !e.playerCtl)!
    expect(dealOpeningHand(w, npc)).toBe(false)
    player(w).dead = true
    expect(dealOpeningHand(w, player(w))).toBe(false)
  })

  it('an empty offer deals nothing', () => {
    const w = landing()
    const saved = { ...MODS }
    for (const k of Object.keys(MODS)) delete (MODS as Record<string, unknown>)[k]
    try {
      dealOpeningDraft(w)
      expect(player(w).playerCtl!.draft).toBeUndefined()
    } finally {
      Object.assign(MODS, saved)
    }
  })

  it('reads no w.rng: the PRNG stream is where it was', () => {
    const w = landing()
    const before = serializeWorld(w).rng
    dealOpeningDraft(w)
    expect(serializeWorld(w).rng).toEqual(before)
  })

  it('a held stick/trigger at landing does not instantly confirm', () => {
    const w = landing()
    dealOpeningDraft(w)
    runTicks(w, new Map([[0, { attack: true }]]), 3)
    expect(player(w).playerCtl!.draft).toBeDefined()
  })

  it('times out to the cursor card and the player proceeds', () => {
    const w = landing()
    dealOpeningDraft(w)
    const offer = player(w).playerCtl!.draft!.offer
    runTicks(w, new Map(), DRAFT_TICKS + 2)
    expect(player(w).playerCtl!.draft).toBeUndefined()
    const mods = player(w).loadout!.inventory.flatMap((s) => s.mods ?? [])
    expect(mods.map((m) => m.id)).toContain(offer[0])
  })

  it('serialize round-trips an open opening hand and replays byte-identically', () => {
    const a = landing(2)
    dealOpeningDraft(a)
    runTicks(a, new Map(), 10)
    const b = deserializeWorld(serializeWorld(a))
    expect(player(b).playerCtl!.draft!.opening).toBe(true)
    expectWorldEqual(a, b)
    runTicks(a, new Map([[1, { attack: true }]]), 40)
    runTicks(b, new Map([[1, { attack: true }]]), 40)
    expectWorldEqual(a, b)
    expect(serializeWorld(a).rng).toEqual(serializeWorld(b).rng)
  })

  it('a floor-exit deal replaces nothing marked opening on the next hand', () => {
    const w = landing()
    dealOpeningDraft(w)
    dealFloorDraft(w, 1)
    expect(player(w).playerCtl!.draft!.opening).toBeUndefined()
  })
})
