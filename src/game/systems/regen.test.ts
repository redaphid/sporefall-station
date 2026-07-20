import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { expectWorldEqual, runTicks } from '../testkit'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'
import {
  REGEN_CALM_TICKS,
  REGEN_HP_PER_INTERVAL,
  REGEN_INTERVAL_TICKS,
} from './regen'

// Every test drops a single player on an open spawn tile of an otherwise EMPTY
// world (no NPCs, no hazards) so the ONLY thing that can change their HP is the
// passive regen system under test — a clean, deterministic isolation.
const solo = (seed: number): { w: World; p: ReturnType<typeof spawnPlayer> } => {
  const w = createWorld(seed, 1)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  p.health!.iframes = 0 // shed spawn grace so damage tests can actually land hits
  return { w, p }
}

const idle = new Map<number, Partial<InputCmd>>([[0, {}]])
const moving = new Map<number, Partial<InputCmd>>([[0, { moveX: 1 }]])

describe('passive rest regen', () => {
  it('a still, unharmed player heals only AFTER the calm window, then at the defined cadence', () => {
    const { w, p } = solo(1)
    p.health!.hp = 40

    // One tick short of the window: no heal yet.
    runTicks(w, idle, REGEN_CALM_TICKS - 1)
    expect(p.health!.hp).toBe(40)

    // The window elapses → the first heal lands exactly on tick REGEN_CALM_TICKS.
    runTicks(w, idle, 1)
    expect(p.health!.hp).toBe(40 + REGEN_HP_PER_INTERVAL)

    // Then one more heal every REGEN_INTERVAL_TICKS.
    runTicks(w, idle, REGEN_INTERVAL_TICKS)
    expect(p.health!.hp).toBe(40 + 2 * REGEN_HP_PER_INTERVAL)
  })

  it('never regenerates while moving every tick', () => {
    const { w, p } = solo(2)
    p.health!.hp = 40
    runTicks(w, moving, REGEN_CALM_TICKS * 3)
    expect(p.health!.hp).toBe(40)
    expect(p.playerCtl!.regenCalm).toBeUndefined()
  })

  it('degenerate: a nudge every few ticks keeps resetting the streak — no regen ever', () => {
    const { w, p } = solo(3)
    p.health!.hp = 40
    // Move for one tick, idle for three, forever: the streak never reaches the
    // window because the move keeps knocking regenCalm back to absent.
    for (let i = 0; i < 40; i++) {
      runTicks(w, moving, 1)
      runTicks(w, idle, 3)
    }
    expect(p.health!.hp).toBe(40)
  })

  it('taking a hit interrupts regen and restarts the whole wait', () => {
    const { w, p } = solo(4)
    p.health!.hp = 100

    // Almost through the first calm window...
    runTicks(w, idle, REGEN_CALM_TICKS - 1)
    expect(p.health!.hp).toBe(100)

    // ...then a hit lands (knockback 0 so the body stays perfectly still — this
    // isolates the DAMAGE interrupt from the incidental movement interrupt).
    applyDamage(w, p, 10, p.pos.x + 1, p.pos.y, 0, 999)
    expect(p.health!.hp).toBe(90)

    // The hit resets the clock: even a FULL window of stillness right after only
    // just re-earns the first heal — no regen during the wait.
    runTicks(w, idle, REGEN_CALM_TICKS)
    expect(p.health!.hp).toBe(90)
    runTicks(w, idle, 1)
    expect(p.health!.hp).toBe(90 + REGEN_HP_PER_INTERVAL)
  })

  it('caps at health.max and stops (never overheals)', () => {
    const { w, p } = solo(5)
    p.health!.hp = p.health!.max - 1 // one below full
    runTicks(w, idle, REGEN_CALM_TICKS + REGEN_INTERVAL_TICKS * 5)
    expect(p.health!.hp).toBe(p.health!.max)
  })

  it('a full-HP player resting is a no-op on health', () => {
    const { w, p } = solo(6)
    expect(p.health!.hp).toBe(p.health!.max)
    runTicks(w, idle, REGEN_CALM_TICKS * 2)
    expect(p.health!.hp).toBe(p.health!.max)
  })

  it('co-op: a still player regenerates while a moving partner does not', () => {
    const w = createWorld(7, 1)
    const rester = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    // Second player a couple tiles over so they never collide/push each other.
    const runner = spawnPlayer(w, 1, w.level.spawn.x + 2, w.level.spawn.y)
    rester.health!.iframes = 0
    runner.health!.iframes = 0
    rester.health!.hp = 50
    runner.health!.hp = 50

    const inputs = new Map<number, Partial<InputCmd>>([
      [0, {}], // player 0 holds still
      [1, { moveX: 1 }], // player 1 walks AWAY (never shoves the rester off its spot)
    ])
    runTicks(w, inputs, REGEN_CALM_TICKS + 1)

    expect(rester.health!.hp).toBe(50 + REGEN_HP_PER_INTERVAL) // healed
    expect(runner.health!.hp).toBe(50) // never rested → never healed
  })

  it('is deterministic: same seed + inputs → byte-identical worlds', () => {
    const build = (): World => {
      const w = createWorld(11, 1)
      const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
      p.health!.iframes = 0
      p.health!.hp = 30
      return w
    }
    const a = build()
    const b = build()
    runTicks(a, idle, REGEN_CALM_TICKS + REGEN_INTERVAL_TICKS * 3)
    runTicks(b, idle, REGEN_CALM_TICKS + REGEN_INTERVAL_TICKS * 3)
    // Canonical snapshot equality (includes hp AND the regenCalm counter).
    expectWorldEqual(a, b)
    expect(a.entities[0].health!.hp).toBeGreaterThan(30)
  })

  it('regenCalm is absent (byte-stable) whenever the streak is broken', () => {
    const { w, p } = solo(9)
    // Fresh: never rested → field absent.
    expect(p.playerCtl!.regenCalm).toBeUndefined()
    tickWorld(w, new Map([[0, { ...emptyInput(), moveX: 1 }]]))
    expect(p.playerCtl!.regenCalm).toBeUndefined()
    // Rest a bit → it appears and counts up.
    runTicks(w, idle, 5)
    expect(p.playerCtl!.regenCalm).toBe(5)
    // Move once → back to absent, not 0.
    tickWorld(w, new Map([[0, { ...emptyInput(), moveX: 1 }]]))
    expect(p.playerCtl!.regenCalm).toBeUndefined()
  })
})
