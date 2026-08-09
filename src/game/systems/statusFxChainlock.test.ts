// Adversarial coverage for the immobilize anti-chain-lock (statusFx.ts).
//
// The bug: `stunGun` fires every 24 ticks and applies `electrified` for 45 ticks.
// Naive refresh-on-reapply reset the expiry 21 ticks early, forever → the victim
// was immobilized on EVERY tick (zero counterplay). These tests pin the fix down
// to exact, deterministic tick math: a single lock still bites for its full first
// duration, but sustained pressure can never hold the victim indefinitely.

import { describe, expect, it, beforeEach } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { serializeWorld, deserializeWorld } from '../serialize'
import { runTicks, expectWorldEqual } from '../testkit'
import {
  addStatus,
  applyStatus,
  hasStatus,
  isImmobilized,
  statusFxSystem,
  IMMOBILIZE_IMMUNE_TICKS,
} from './statusFx'

const STUN_GUN_BASE = 45 // stunGun onHit ticks
const STUN_GUN_CADENCE = 24 // stunGun cooldownTicks
const FREEZE_BASE = 120 // freezeRay / freezeGrenade ticks

const victim = (w: World, x = 20, y = 20): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

/** Replay a chain-lock attack deterministically: land `base` of `kind` on `e`
 * every `cadence` ticks for `totalTicks`, running the REAL end-of-tick expiry
 * (`statusFxSystem`) each tick — exactly what `tickWorld` does. Returns, per tick,
 * whether the victim was immobilized as movement/ai/combat would read it (the
 * state carried INTO the tick, i.e. before that tick's fresh hit), plus the ordered
 * list of fresh lock durations granted. */
const replayChainLock = (
  w: World,
  e: Entity,
  kind: string,
  base: number,
  cadence: number,
  totalTicks: number,
  source?: number,
): { immobilizedPerTick: boolean[]; lockDurations: number[] } => {
  const immobilizedPerTick: boolean[] = []
  const lockDurations: number[] = []
  for (let t = 0; t < totalTicks; t++) {
    immobilizedPerTick.push(isImmobilized(e)) // as read at the top of the tick
    if (w.tick % cadence === 0) {
      const before = e.fx?.[kind]?.until ?? -1
      addStatus(w, e, kind, base, source)
      const after = e.fx?.[kind]?.until ?? -1
      if (after !== before && after > w.tick) lockDurations.push(after - w.tick)
    }
    statusFxSystem(w)
    w.tick++
  }
  return { immobilizedPerTick, lockDurations }
}

describe('immobilize anti-chain-lock', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a stunGun hitting every 24 ticks no longer perma-locks the victim', () => {
    const e = victim(w)
    const { immobilizedPerTick } = replayChainLock(w, e, 'electrified', STUN_GUN_BASE, STUN_GUN_CADENCE, 300)
    const freeTicks = immobilizedPerTick.filter((im) => !im).length
    // Before the fix this was exactly 0. The fix must leave real counterplay.
    expect(freeTicks).toBeGreaterThan(0)
    expect(freeTicks).toBeGreaterThanOrEqual(120) // ≥40% of the window is actionable
  })

  it('leaves a run of free ticks after the very first lock (immunity window)', () => {
    const e = victim(w)
    const { immobilizedPerTick } = replayChainLock(w, e, 'electrified', STUN_GUN_BASE, STUN_GUN_CADENCE, 120)
    // First lock: hit at tick 0 → immobilized ticks 1..45. Then a guaranteed free
    // block before any re-lock can start.
    const firstFree = immobilizedPerTick.indexOf(false, 1)
    expect(firstFree).toBe(46) // free again once the first 45-tick lock expires
    // At least the immunity window's worth of consecutive free ticks follow.
    let run = 0
    for (let t = firstFree; t < immobilizedPerTick.length && !immobilizedPerTick[t]; t++) run++
    expect(run).toBeGreaterThanOrEqual(IMMOBILIZE_IMMUNE_TICKS)
  })

  it('diminishes successive locks by tier: 45 → 22 → 11 → 5 → 2 → 1 → 0', () => {
    const e = victim(w)
    const { lockDurations } = replayChainLock(w, e, 'electrified', STUN_GUN_BASE, STUN_GUN_CADENCE, 400)
    // Halving per tier, floored. Once a grant floors to 0 no further lock lands.
    expect(lockDurations).toEqual([45, 22, 11, 5, 2, 1])
  })

  it('a single, isolated application still immobilizes for its full first duration', () => {
    const e = victim(w) // w.tick === 0
    addStatus(w, e, 'electrified', STUN_GUN_BASE)
    expect(e.fx!.electrified.until).toBe(STUN_GUN_BASE) // full 45, not diminished
    // Locked right up to the tick before expiry…
    w.tick = STUN_GUN_BASE - 1
    statusFxSystem(w)
    expect(isImmobilized(e)).toBe(true)
    // …and released exactly when world.tick reaches `until`.
    w.tick = STUN_GUN_BASE
    statusFxSystem(w)
    expect(isImmobilized(e)).toBe(false)
    expect(hasStatus(e, 'electrified')).toBe(false)
  })

  it('frozen gets the same treatment — a freeze ray spammer cannot perma-freeze', () => {
    const e = victim(w)
    // Freeze every 24 ticks (freezeRay cooldown 22-ish); base 120.
    const { immobilizedPerTick, lockDurations } = replayChainLock(w, e, 'frozen', FREEZE_BASE, 24, 500)
    expect(immobilizedPerTick.filter((im) => !im).length).toBeGreaterThan(0)
    expect(lockDurations[0]).toBe(120) // first freeze is full length
    expect(lockDurations[1]).toBe(60) // then halved
    expect(lockDurations.at(-1)).toBeLessThanOrEqual(2) // converges toward nothing
  })

  it('two stunGun attackers on offset cadences still leave counterplay', () => {
    const e = victim(w)
    let free = 0
    for (let t = 0; t < 300; t++) {
      const immobilized = isImmobilized(e)
      if (!immobilized) free++
      if (w.tick % 24 === 0) addStatus(w, e, 'electrified', STUN_GUN_BASE, 101)
      if (w.tick % 24 === 12) addStatus(w, e, 'electrified', STUN_GUN_BASE, 102) // second attacker, offset
      statusFxSystem(w)
      w.tick++
    }
    // Immunity is per-victim-per-kind, so a second source cannot re-lock during the
    // window either: the victim still gets free ticks.
    expect(free).toBeGreaterThan(0)
  })

  // This test used to assert that stun/sleep create NO lockout tracker, which
  // documented the HOLE rather than a feature: those two immobilize as totally
  // as `frozen` but were a flat overwrite, so any two attackers landing hits
  // closer together than the duration reset the timer forever. A sledgehammer is
  // 20 ticks on a 28-tick swing and is NOT archetype-locked — it is in
  // NPC_ARSENAL, so ordinary mobs roll it. They now ride the same guard, on
  // their own independent tracks.
  it('legacy stun/sleep keep their own counters but DO get a lockout tracker now', () => {
    const e = victim(w)
    applyStatus(w, e, 'stun', 20)
    expect(e.status!.stun).toBe(20)
    expect(e.fx?.electrified).toBeUndefined() // still counter-based, not an fx entry
    expect(e.lockout!.stun).toBeDefined()
    applyStatus(w, e, 'sleep', 150)
    expect(e.status!.sleep).toBe(150)
    expect(e.lockout!.sleep).toBeDefined()
    expect(e.lockout!.stun).toBeDefined() // independent tracks, not shared
  })

  it('a second attacker cannot refresh a running stun — the perma-lock is closed', () => {
    const e = victim(w)
    applyStatus(w, e, 'stun', 20) // attacker A
    e.status!.stun = 6 // most of it has ticked away
    w.tick += 14
    applyStatus(w, e, 'stun', 20) // attacker B lands mid-lock
    expect(e.status!.stun).toBe(6) // NOT re-armed to 20
  })

  it('does NOT catch non-immobilize statuses — DOTs still refresh on reapply', () => {
    const e = victim(w)
    addStatus(w, e, 'poisoned', 100) // until = 100
    w.tick = 50
    addStatus(w, e, 'poisoned', 100) // refreshes to 150
    expect(e.fx!.poisoned.until).toBe(150)
    expect(e.lockout).toBeUndefined() // poisoned is a DOT, not an immobilize
  })

  it('the lockout tracker round-trips through serialize (byte-identical replay)', () => {
    const e = victim(w)
    addStatus(w, e, 'electrified', STUN_GUN_BASE, 7)
    statusFxSystem(w)
    w.tick++
    // Mid-lock: both the active fx entry and the anti-chain-lock tracker exist.
    expect(isImmobilized(e)).toBe(true)
    const json = serializeWorld(w)
    const dumped = JSON.parse(JSON.stringify(json)) as typeof json
    const savedEntity = dumped.entities.find((x) => x.id === e.id) as Record<string, unknown>
    expect(savedEntity.lockout).toBeDefined() // tracker is captured in the snapshot

    // Two worlds restored from the same snapshot, driven identically, stay equal —
    // and equal to the live world — proving the tracker replays deterministically.
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    runTicks(a, new Map(), 60)
    runTicks(b, new Map(), 60)
    expectWorldEqual(a, b)
    runTicks(w, new Map(), 60)
    expectWorldEqual(w, a)
  })

  it('drives the real tickWorld: the victim is move-gated while locked, free after', () => {
    const e = victim(w)
    e.speed = 4
    e.intent = { x: 1, y: 0 }
    addStatus(w, e, 'electrified', STUN_GUN_BASE)
    const startX = e.pos.x
    runTicks(w, new Map(), 10) // deep inside the 45-tick lock
    expect(isImmobilized(e)).toBe(true)
    expect(e.pos.x).toBeCloseTo(startX) // movementSystem gated on isImmobilize → no drift
    runTicks(w, new Map(), 60) // well past the lock + immunity
    expect(isImmobilized(e)).toBe(false)
  })
})
