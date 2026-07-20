// #69 Mireclaw Alpha — the phased boss brain. Per-phase fixtures set the boss to
// each HP band and run the REAL tickWorld/decide: phase 1 summons brood on
// schedule; phase 2 steers to and regenerates in the spore cloud, and STOPS when
// the cloud is set on fire; phase 3 enrages and never flees.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { decide } from './behaviors'
import { igniteCell } from './fire'
import { SUMMON_COUNT, SUMMON_INTERVAL } from './mireclaw'
import { seedSpore } from './spore'

const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1, 'normal', true)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 14; y <= cy + 14; y++)
    for (let x = cx - 14; x <= cx + 14; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}
const boss = (w: World, x: number, y: number, hpFrac = 1) => {
  const b = spawnNpc(w, 'boss', x, y)
  b.ai!.sightRange = 14
  b.health = { hp: Math.round(b.health!.max * hpFrac), max: b.health!.max, iframes: 0 }
  return b
}
const sporelings = (w: World): number => w.entities.filter((e) => e.archetype === 'sporeling' && !e.dead).length
const patch = (w: World, cx: number, cy: number, r = 2): void => {
  for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) seedSpore(w, Math.floor(cx) + x, Math.floor(cy) + y)
}

describe('#69 Mireclaw — phase 1 (healthy): pressure + summon brood', () => {
  it('summons brood on a schedule while at full health', () => {
    const { w, cx, cy } = arena()
    const b = boss(w, cx, cy)
    const p = spawnPlayer(w, 0, cx + 3, cy)
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const input = new Map([[0, emptyInput()]])
    expect(sporelings(w)).toBe(0)
    for (let t = 0; t < SUMMON_INTERVAL + 5; t++) tickWorld(w, input)
    expect(sporelings(w)).toBeGreaterThanOrEqual(SUMMON_COUNT) // a wave hatched on schedule
    // …and it's pressuring the player, not fleeing.
    expect(['battle', 'pursue']).toContain(decide(w, b).goal.code)
  })
})

describe('#69 Mireclaw — phase 2 (wounded): retreat to spore and regenerate', () => {
  it('steers to the cloud and heals there — until the players burn it out', () => {
    const { w, cx, cy } = arena()
    const b = boss(w, cx, cy, 0.4) // phase-2 band
    patch(w, cx + 6, cy) // a spore cloud off to the side
    // It chooses to RETREAT toward the cloud rather than flee or fight.
    expect(decide(w, b).goal.code).toBe('retreat')

    const input = new Map([[0, emptyInput()]])
    const hp0 = b.health!.hp
    for (let t = 0; t < 120; t++) tickWorld(w, input)
    const hpHealed = b.health!.hp
    expect(hpHealed).toBeGreaterThan(hp0) // it reached the cloud and regenerated

    // Players set the cloud alight → the regen is DENIED.
    for (let t = 0; t < 60; t++) {
      igniteCell(w, Math.floor(b.pos.x), Math.floor(b.pos.y))
      tickWorld(w, input)
    }
    const hpBurned = b.health!.hp
    // burning halted (and reversed) the heal — it did not keep climbing.
    expect(hpBurned).toBeLessThanOrEqual(hpHealed)
  })
})

describe('#69 Mireclaw — phase 3 (<20%): enrage, never flee', () => {
  it('enrages — faster, and charges instead of breaking off', () => {
    const { w, cx, cy } = arena()
    const b = boss(w, cx, cy, 0.15)
    const baseSpeed = b.speed
    const p = spawnPlayer(w, 0, cx + 2, cy) // right on top of it — a full-HP boss might flee at 15%
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const input = new Map([[0, emptyInput()]])
    let everFled = false
    for (let t = 0; t < 40; t++) {
      tickWorld(w, input)
      if (b.ai!.mode === 'flee') everFled = true
    }
    expect(b.ai!.enraged).toBe(true)
    expect(b.speed).toBeGreaterThan(baseSpeed) // enrage speed burst
    expect(everFled).toBe(false) // self-preservation dropped
    const goal = decide(w, b).goal
    expect(['battle', 'pursue']).toContain(goal.code)
    expect(goal.target).toBe(p.id)
  })
})
