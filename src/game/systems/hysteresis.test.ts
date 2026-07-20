// #62 — goal hysteresis / commitment deadband (fixes #59 battle<->flee thrash).
//
// The battle/flee scores cross at hp = max/3 (2·hp vs max−hp). A 1-hp jitter
// there — the spore DOT (1hp/12t) plus passive regen — flips the goal every
// think with ZERO deadband. Hysteresis gives the INCUMBENT goal a compare-score
// bonus so a rival must beat it by a clear margin. These tests set exact state,
// run the REAL decide()/tickWorld, and assert the flip-rate collapses — while a
// higher-tier (new, real) threat still preempts instantly.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { decide } from './behaviors'

/** A clean open arena carved centre — no levelgen crowd — so the only entities
 * are the ones a test places. Mirrors the ai-sim harness (arena.ts). */
const arena = (seed: number, hostile = true): { w: World; cx: number; cy: number } => {
  const w = createWorld(seed, 1, 'normal', hostile)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 12; y <= cy + 12; y++) {
    for (let x = cx - 12; x <= cx + 12; x++) {
      if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) {
        w.level.tiles[y * w.level.w + x] = Tile.Floor
        w.level.solid[y * w.level.w + x] = 0
      }
    }
  }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}

// gangster: hp 35 → battle/flee crossover at max/3 ≈ 11.67 (battle at 12, flee at 11).
const ABOVE = 12
const BELOW = 11

describe('#62 goal hysteresis — analytic decide() 1-hp boundary jitter', () => {
  // Feed the decided goal back as the incumbent each think (exactly as the sim
  // does) while hp oscillates across the crossover, and count reversals.
  const jitterFlips = (hysteresis: boolean): number => {
    const { w, cx, cy } = arena(1)
    const player = spawnPlayer(w, 0, cx, cy)
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const g = spawnNpc(w, 'gangster', cx + 6, cy)
    g.ai!.sightRange = 12
    w.aiFlags = { hysteresis }
    let flips = 0
    let prev: string | undefined
    for (let k = 0; k < 20; k++) {
      g.health!.hp = k % 2 === 0 ? ABOVE : BELOW
      const goal = decide(w, g).goal
      g.ai!.goal = goal.code // becomes the incumbent for the next think
      g.ai!.targetId = goal.target
      if (prev !== undefined && goal.code !== prev) flips++
      prev = goal.code
    }
    return flips
  }

  it('WITHOUT hysteresis the goal reverses on essentially every think', () => {
    expect(jitterFlips(false)).toBeGreaterThanOrEqual(16) // ~19/20
  })

  it('WITH hysteresis (shipped default) it commits — at most one crossover', () => {
    expect(jitterFlips(true)).toBeLessThanOrEqual(1)
  })

  it('hysteresis is the shipped default (undefined aiFlags behaves like on)', () => {
    const { w, cx, cy } = arena(1)
    const player = spawnPlayer(w, 0, cx, cy)
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const g = spawnNpc(w, 'gangster', cx + 6, cy)
    g.ai!.sightRange = 12
    // no aiFlags set at all
    let flips = 0
    let prev: string | undefined
    for (let k = 0; k < 20; k++) {
      g.health!.hp = k % 2 === 0 ? ABOVE : BELOW
      const goal = decide(w, g).goal
      g.ai!.goal = goal.code
      g.ai!.targetId = goal.target
      if (prev !== undefined && goal.code !== prev) flips++
      prev = goal.code
    }
    expect(flips).toBeLessThanOrEqual(1)
  })
})

describe('#62 goal hysteresis — full-sim goal-change rate collapses', () => {
  // Hold hp above/below the crossover in windows longer than the think interval
  // so consecutive thinks reliably straddle the boundary — the real DOT/regen
  // jitter, driven through the actual tickWorld pipeline.
  const runJitter = (hysteresis: boolean): { aiGoalEvents: number; goalChanges: number } => {
    const { w, cx, cy } = arena(2)
    const player = spawnPlayer(w, 0, cx, cy)
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const g = spawnNpc(w, 'gangster', cx + 6, cy)
    g.ai!.sightRange = 12
    g.speed = 0 // pin it so distance can't drift off the boundary
    w.aiFlags = { hysteresis }
    const input = new Map([[0, emptyInput()]])
    let aiGoalEvents = 0
    let goalChanges = 0
    let prev: string | undefined
    for (let t = 0; t < 160; t++) {
      g.health!.hp = Math.floor(t / 10) % 2 === 0 ? ABOVE : BELOW // 10-tick windows
      tickWorld(w, input)
      for (const ev of w.events) if (ev.type === 'aiGoal' && ev.entityId === g.id) aiGoalEvents++
      const cur = g.ai!.goal
      if (prev !== undefined && cur !== prev) goalChanges++
      prev = cur
    }
    return { aiGoalEvents, goalChanges }
  }

  it('the shipped default thrashes far less than the old zero-deadband brain', () => {
    const off = runJitter(false)
    const on = runJitter(true)
    expect(off.aiGoalEvents).toBeGreaterThanOrEqual(5) // the #59 thrash is present with the deadband off
    expect(on.aiGoalEvents).toBeLessThanOrEqual(1) // and collapses with it on
    expect(on.goalChanges * 4).toBeLessThan(off.goalChanges) // an order-of-magnitude drop
  })
})

describe('#62 goal hysteresis — a higher tier still preempts instantly', () => {
  it('a wandering NPC turns to fight a newly-perceived hostile the same think', () => {
    // Incumbent is an AMBIENT wander; hysteresis must NOT damp the THREAT-tier
    // escalation — responsiveness to a real, new threat is unchanged.
    const { w, cx, cy } = arena(3)
    const player = spawnPlayer(w, 0, cx, cy)
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const g = spawnNpc(w, 'gangster', cx + 6, cy) // full hp → wants to battle
    g.ai!.sightRange = 12
    g.ai!.goal = 'wander' // standing ambient goal (gets no cross-tier protection)
    const goal = decide(w, g).goal // shipped default: hysteresis on
    expect(goal.code).toBe('battle')
    expect(goal.target).toBe(player.id)
  })

  it('lastScores stays RAW — the "why" trail is not inflated by the bonus', () => {
    const { w, cx, cy } = arena(4)
    const player = spawnPlayer(w, 0, cx, cy)
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const g = spawnNpc(w, 'gangster', cx + 6, cy)
    g.ai!.sightRange = 12
    g.ai!.goal = 'battle'
    g.ai!.targetId = player.id
    const withHyst = decide({ ...w, aiFlags: { hysteresis: true } }, g).scores.threat
    const noHyst = decide({ ...w, aiFlags: { hysteresis: false } }, g).scores.threat
    expect(withHyst).toBe(noHyst) // the recorded score is the raw score, either way
  })
})
