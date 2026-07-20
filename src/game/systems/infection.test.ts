// #64 — spore contagion → Infected hosts. The feature ships behind a toggle
// (INFECTION_ENABLED, default off); these tests force it per-world via
// `w.aiFlags.infection` and assert: exposed crew TURN at the threshold, fire is
// a real counterplay (cures before the turn), the outbreak spreads by contact
// while a caged clean NPC stays clean, the Infected and the uninfected are
// mutual enemies, and — critically — with the feature OFF nothing turns (the
// shipped path is untouched).

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { decide } from './behaviors'
import { INFECT_THRESHOLD } from './infection'
import { spawnSporeBurst } from './spore'
import { addStatus } from './statusFx'

const arena = (seed: number, infection: boolean): { w: World; cx: number; cy: number } => {
  const w = createWorld(seed, 1, 'normal', false) // peaceful — hostility must come from infection alone
  if (infection) w.aiFlags = { infection: true }
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 12; y <= cy + 12; y++)
    for (let x = cx - 12; x <= cx + 12; x++)
      if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) {
        w.level.tiles[y * w.level.w + x] = Tile.Floor
        w.level.solid[y * w.level.w + x] = 0
      }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}

const tough = (e: ReturnType<typeof spawnNpc>): void => {
  e.health = { hp: 1e6, max: 1e6, iframes: 0 } // survive the DOT so we measure turning, not death
}

describe('#64 infection — exposure turns crew at the threshold', () => {
  it('a crew member held in spore turns into an Infected host', () => {
    const { w, cx, cy } = arena(1, true)
    const e = spawnNpc(w, 'civilian', cx, cy)
    tough(e)
    const input = new Map([[0, emptyInput()]])
    // Keep it dosed every tick; it should turn at ~INFECT_THRESHOLD.
    let turnedAt = -1
    for (let t = 0; t < INFECT_THRESHOLD + 40; t++) {
      addStatus(w, e, 'spore', 30)
      tickWorld(w, input)
      if (e.infected && turnedAt < 0) turnedAt = t
    }
    expect(e.infected).toBe(true)
    expect(turnedAt).toBeGreaterThanOrEqual(INFECT_THRESHOLD - 2)
    expect(turnedAt).toBeLessThanOrEqual(INFECT_THRESHOLD + 5)
    expect(e.ai!.behavior).toBe('infected')
    expect(e.ai!.mode).toBe('aggro')
  })

  it('FIRE is the counterplay: a burning body sheds spore and never turns', () => {
    const { w, cx, cy } = arena(2, true)
    const e = spawnNpc(w, 'civilian', cx, cy)
    tough(e)
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < INFECT_THRESHOLD + 60; t++) {
      addStatus(w, e, 'spore', 30) // drenched in spore…
      addStatus(w, e, 'burning', 30) // …but on fire the whole time
      tickWorld(w, input)
    }
    expect(e.infected).toBeFalsy()
    expect(e.sporeLoad ?? 0).toBe(0) // the load is burned back to zero every tick
  })
})

describe('#64 infection — with the feature OFF nothing turns (shipped path)', () => {
  it('the same exposure accrues no load and never converts when disabled', () => {
    const { w, cx, cy } = arena(1, false) // infection NOT enabled
    const e = spawnNpc(w, 'civilian', cx, cy)
    tough(e)
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < INFECT_THRESHOLD + 40; t++) {
      addStatus(w, e, 'spore', 30)
      tickWorld(w, input)
    }
    expect(e.infected).toBeFalsy()
    expect(e.sporeLoad).toBeUndefined() // the system never even ran
  })
})

describe('#64 infection — spreads by contact; the caged stay clean', () => {
  it('a bloom in a crew cluster converts the exposed; a caged NPC outside never turns', () => {
    const { w, cx, cy } = arena(7, true)
    // A 3x3 of crew around the bloom point.
    const cluster: ReturnType<typeof spawnNpc>[] = []
    for (let gy = -1; gy <= 1; gy++)
      for (let gx = -1; gx <= 1; gx++) {
        const e = spawnNpc(w, 'civilian', cx + gx * 1.2, cy + gy * 1.2, undefined)
        tough(e)
        cluster.push(e)
      }
    // A clean control, caged far outside the cloud + contact range.
    const caged = spawnNpc(w, 'civilian', cx + 10, cy + 10)
    tough(caged)
    caged.speed = 0 // pinned, so it can never wander into the bloom

    spawnSporeBurst(w, Math.floor(cx), Math.floor(cy))
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 300; t++) tickWorld(w, input)

    const turned = cluster.filter((e) => e.infected).length
    expect(turned).toBeGreaterThanOrEqual(3) // the outbreak took hold
    expect(caged.infected).toBeFalsy() // the isolated body is spared
  })
})

describe('#64 infection — host and clean are mutual enemies', () => {
  it('the Infected hunts a clean body and the clean fights back, ignoring faction', () => {
    const { w, cx, cy } = arena(3, true)
    const host = spawnNpc(w, 'civilian', cx, cy)
    host.infected = true
    host.ai!.behavior = 'infected'
    host.ai!.sightRange = 14
    const prey = spawnNpc(w, 'civilian', cx + 4, cy) // same faction — infection overrides it
    prey.ai!.sightRange = 14
    const other = spawnNpc(w, 'civilian', cx + 6, cy)
    other.infected = true // another host — the first must NOT target it

    expect(['battle', 'pursue']).toContain(decide(w, host).goal.code)
    expect(decide(w, host).goal.target).toBe(prey.id) // hunts the clean, not the fellow host
    // The clean crew now sees the Infected as enemies despite sharing a faction
    // (it engages the nearest host — here `other`).
    const preyGoal = decide(w, prey).goal
    expect(['battle', 'pursue', 'flee']).toContain(preyGoal.code)
    expect(w.byId.get(preyGoal.target!)?.infected).toBe(true)
  })
})
