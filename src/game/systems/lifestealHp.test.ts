// The lifesteal fraction is hyperbolic (2 stacks = 0.3 / 1.3 = 0.2307...), so
// `dealt * lifestealFrac` is almost never whole. Every other hp write in the sim
// is an integer, so a heal must be too.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm, expectWorldEqual, runTicks } from '../testkit'
import { addEntity, createWorld, type World } from '../world'

const MAX = 240

/** A player with a lifesteal pistol at (20,20) facing a disarmed, AI-less foe at
 * (22,20) with a pool big enough that it never dies. */
const scene = (stacks: number, hp: number, physicalResist?: number): { w: World; p: Entity; foe: Entity } => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  p.health = { hp, max: MAX, iframes: 0 }
  arm(p, 'pistol').mods = [{ id: 'lifesteal', stacks }]
  const foe = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
  foe.health = { hp: 10000, max: 10000, iframes: 0 }
  if (physicalResist !== undefined) foe.resist = { physical: physicalResist }
  return { w, p, foe }
}

const FIRE = new Map([[0, { attack: true, aimX: 1, aimY: 0 }]])
const IDLE = new Map([[0, {}]])

/** Pull the trigger for one tick, then let the round fly and the pistol's 18-tick
 * cooldown run out. Returns the hp the foe lost, read off the `hit` events.
 * Regen heals a player who stands still for 75 ticks, so its clock is reset
 * every tick: every hp change here is lifesteal. */
const shootOnce = (w: World, foe: Entity): number[] => {
  const dealt: number[] = []
  for (let t = 0; t < 20; t++) {
    for (const e of w.entities) if (e.playerCtl) e.playerCtl.regenCalm = undefined
    runTicks(w, t === 0 ? FIRE : IDLE, 1)
    for (const ev of w.events) if (ev.type === 'hit' && ev.targetId === foe.id) dealt.push(ev.amount)
  }
  return dealt
}

describe('lifesteal heals whole hit points', () => {
  it('1 stack: one 14-damage hit heals 2 (14 * 0.1304 = 1.83)', () => {
    const { w, p, foe } = scene(1, 100)
    expect(shootOnce(w, foe)).toEqual([14])
    expect(p.health!.hp).toBe(102)
  })

  it('2 stacks: one 14-damage hit heals 3 (14 * 0.2307 = 3.23)', () => {
    const { w, p, foe } = scene(2, 100)
    expect(shootOnce(w, foe)).toEqual([14])
    expect(p.health!.hp).toBe(103)
  })

  it('sustained fire never leaves the shooter on a fractional hp, tick by tick', () => {
    const { w, p, foe } = scene(2, 100)
    const seen: number[] = []
    let hits = 0
    for (let t = 0; t < 60; t++) {
      runTicks(w, FIRE, 1)
      hits += w.events.filter((ev) => ev.type === 'hit' && ev.targetId === foe.id).length
      seen.push(p.health!.hp)
    }
    expect(hits).toBe(4)
    expect(seen.filter((hp) => !Number.isInteger(hp))).toEqual([])
    // 4 hits * 14 * 0.2307 = 12.92 owed, paid 3 + 3 + 4 + 3.
    expect(p.health!.hp).toBe(113)
  })

  it('a heal that would overflow max stops at exactly max', () => {
    const { w, p, foe } = scene(2, MAX - 1)
    expect(shootOnce(w, foe)).toEqual([14])
    expect(p.health!.hp).toBe(MAX)
  })

  it('heals past max are lost, not saved up for later', () => {
    // Five hits at full hp leave 0.15 owed. A carry that banked the capped
    // 16 hp would pay 19 on the next hit instead of 3.
    const { w, p, foe } = scene(2, MAX)
    for (let i = 0; i < 5; i++) expect(shootOnce(w, foe)).toEqual([14])
    expect(p.health!.hp).toBe(MAX)
    p.health!.hp = 100
    expect(shootOnce(w, foe)).toEqual([14])
    expect(p.health!.hp).toBe(103)
  })

  it('over many hits the total paid stays within half an hp of what was dealt', () => {
    // 10 hits * 14 * 0.1304 = 18.26 owed. Rounding each hit up to 2, or
    // dropping the negative carry, pays 20.
    const { w, p, foe } = scene(1, 100)
    for (let i = 0; i < 10; i++) expect(shootOnce(w, foe)).toEqual([14])
    expect(p.health!.hp).toBe(118)
  })

  it('a hit that lands but deals 0 after resist heals nothing', () => {
    const { w, p, foe } = scene(2, 100, 0)
    expect(shootOnce(w, foe)).toEqual([0])
    expect(p.health!.hp).toBe(100)
  })

  it('a hit whose heal rounds below one hp heals nothing', () => {
    // round(14 * 0.05) = 1 dealt; 1 * 0.2307 rounds to 0.
    const { w, p, foe } = scene(2, 100, 0.05)
    expect(shootOnce(w, foe)).toEqual([1])
    expect(p.health!.hp).toBe(100)
  })

  it('hits too weak to heal alone still pay out together', () => {
    // Three 1-dealt hits owe 0.69 hp between them, which rounds to 1.
    const { w, p, foe } = scene(2, 100, 0.05)
    expect([...shootOnce(w, foe), ...shootOnce(w, foe)]).toEqual([1, 1])
    expect(p.health!.hp).toBe(100)
    expect(shootOnce(w, foe)).toEqual([1])
    expect(p.health!.hp).toBe(101)
  })

  it('what lifesteal owes survives a save and load, so a replay pays the same heal', () => {
    const { w, p, foe } = scene(2, 100, 0.05)
    shootOnce(w, foe)
    shootOnce(w, foe)
    const loaded = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))
    shootOnce(w, foe)
    shootOnce(loaded, loaded.byId.get(foe.id)!)
    expect(p.health!.hp).toBe(101)
    expectWorldEqual(loaded, w)
  })
})
