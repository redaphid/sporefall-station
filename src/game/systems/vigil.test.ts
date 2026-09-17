// §4.1 THE VIGIL — adversarial TDD for the boss whose verb is "be quiet".
//
// Exact world state, the REAL systems via tickWorld, assertions on the fight's
// actual contract. The design doc names three risks that could each sink this
// boss, and the first one is a genuine self-contradiction rather than a bug to
// find later — so it is the first test in the file.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm } from '../testkit'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, emitNoise, tickWorld, type World } from '../world'
import { applyDamage, detonate } from './combat'
import { igniteCell } from './fire'
import {
  VIGIL_ASLEEP_RESIST,
  VIGIL_AWAKE_RESIST,
  VIGIL_WAKE_TICKS,
  vigilAwake,
  wakeThreshold,
} from './vigil'

const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 2, 'normal', true)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 14; y <= cy + 14; y++)
    for (let x = cx - 14; x <= cx + 14; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}

/** A REVEALED Vigil. Most tests are about the noise budget, not the entrance,
 * so they skip it the way boss.test.ts does — the entrance has its own suite at
 * the foot of this file. */
const vigil = (w: World, x: number, y: number) => {
  const v = spawnNpc(w, 'vigil', x, y)
  w.mission.bossRevealed = true
  return v
}

/**
 * A world whose LEVEL IS UNTOUCHED, for the serialization tests.
 *
 * `arena()` carves floor tiles to make room to fight in, which changes the level
 * checksum — and `deserializeWorld` regenerates the level from seed+floor and
 * REFUSES to load a snapshot whose checksum drifted (the sim never mutates tiles
 * at runtime, by design). So a carved arena can never round-trip. The Vigil does
 * not need to walk anywhere to accumulate noise, so these tests do not need one.
 */
const pristine = (): { w: World; x: number; y: number } => {
  const w = createWorld(1, 2, 'normal', true)
  return { w, x: w.level.spawn.x, y: w.level.spawn.y }
}

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const run = (w: World, n: number, input: Map<number, InputCmd> = idle()): void => {
  for (let i = 0; i < n; i++) tickWorld(w, input)
}
/** Tick until the Vigil wakes, up to `limit`; returns the tick count or -1. */
const ticksToWake = (w: World, v: ReturnType<typeof vigil>, limit: number): number => {
  for (let t = 0; t < limit; t++) {
    tickWorld(w, idle())
    if (vigilAwake(v)) return t
  }
  return -1
}

// ───────────────────────────────────────────────────────────────────────────
describe('THE CONTRADICTION: hitting it must NOT wake it', () => {
  // dormancy.ts wakes a sleeper on `'damage'` — any hit within 20 ticks. A boss
  // that is "vulnerable only while dormant" would therefore wake on the first
  // shot and never be beatable the intended way. The Vigil resolves this by
  // carrying no `wakeOn` at all. THIS IS THE TEST THE DESIGN SAID TO WRITE FIRST.
  it('stays dormant through a sustained beating — damage is SILENT to it', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    for (let t = 0; t < 120; t++) {
      v.health!.iframes = 0
      applyDamage(w, v, 3, cx + 1, cy, 0, 999)
      tickWorld(w, idle())
    }
    expect(v.ai!.dormant).toBe(true)
    expect(vigilAwake(v)).toBe(false)
    expect(v.health!.hp).toBeLessThan(v.health!.max) // it really was being hurt
  })

  it('carries no dormancy wake triggers at all, so awakeningSystem cannot touch it', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    // The data row's absence IS the mechanism — pinned so a well-meaning later
    // edit adding `wakeOn: ['damage']` fails here rather than in playtest.
    expect(v.ai!.wakeOn).toBeUndefined()
  })

  it('is SOFTER asleep than awake — the whole reason to keep it sleeping', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const asleep = (): number => {
      const before = v.health!.hp
      v.health!.iframes = 0
      applyDamage(w, v, 100, cx + 1, cy, 0, 999)
      return before - v.health!.hp
    }
    expect(asleep()).toBe(100 * VIGIL_ASLEEP_RESIST) // 150

    // Wake it the honest way, then measure again.
    emitNoise(w, cx, cy)
    expect(ticksToWake(w, v, 120)).toBeGreaterThanOrEqual(0)
    const before = v.health!.hp
    v.health!.iframes = 0
    applyDamage(w, v, 100, cx + 1, cy, 0, 999)
    expect(before - v.health!.hp).toBe(Math.round(100 * VIGIL_AWAKE_RESIST)) // 15
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('every loud tool wakes it', () => {
  it('a GRENADE wakes it — through the real detonate path', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    // `combat.detonate` is what the player special calls, and it emits noise.
    detonate(w, cx + 2, cy, 2, 10, 999)
    expect(ticksToWake(w, v, 120)).toBeGreaterThanOrEqual(0)
  })

  it('FIRE wakes it, and faster than a plain noise (it is a brighter stimulus)', () => {
    const fire = arena()
    const vf = vigil(fire.w, fire.cx, fire.cy)
    igniteCell(fire.w, Math.floor(fire.cx) + 2, Math.floor(fire.cy))
    const fireTicks = ticksToWake(fire.w, vf, 200)

    const noise = arena()
    const vn = vigil(noise.w, noise.cx, noise.cy)
    emitNoise(noise.w, noise.cx + 2, noise.cy)
    const noiseTicks = ticksToWake(noise.w, vn, 200)

    expect(fireTicks).toBeGreaterThanOrEqual(0)
    expect(noiseTicks).toBeGreaterThanOrEqual(0)
    expect(fireTicks).toBeLessThan(noiseTicks)
  })

  it('GUNFIRE wakes it — a real player really shooting, through tickWorld', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 5, cy)
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    arm(p, 'machinegun')
    p.facing = 0 // aimed at the Vigil
    const firing = new Map([[0, { ...emptyInput(), attack: true }]])
    let woke = -1
    for (let t = 0; t < 200 && woke < 0; t++) {
      tickWorld(w, firing)
      if (vigilAwake(v)) woke = t
    }
    expect(woke).toBeGreaterThanOrEqual(0)
  })

  it('a distant noise is quieter than a near one (distance falloff is honoured)', () => {
    const near = arena()
    const vn = vigil(near.w, near.cx, near.cy)
    emitNoise(near.w, near.cx, near.cy)
    const nearTicks = ticksToWake(near.w, vn, 300)

    const far = arena()
    const vf = vigil(far.w, far.cx, far.cy)
    emitNoise(far.w, far.cx + 7, far.cy) // still in earshot, but far
    const farTicks = ticksToWake(far.w, vf, 300)

    expect(nearTicks).toBeGreaterThanOrEqual(0)
    expect(farTicks).toBeGreaterThan(nearTicks)
  })

  it('noise OUT OF EARSHOT never wakes it, however long it goes on', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    for (let t = 0; t < 200; t++) {
      emitNoise(w, cx + 13, cy) // well past VIGIL_HEARING
      tickWorld(w, idle())
    }
    expect(vigilAwake(v)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('the quiet kill — solo must stay winnable', () => {
  it('a solo player hitting it with a KNIFE forever never wakes it', () => {
    // The fight's promise. Melee emits no noise and spawns no projectile, so a
    // patient solo player can work it down in silence.
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 0.9, cy)
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    arm(p, 'knife')
    p.facing = 0
    const attacking = new Map([[0, { ...emptyInput(), attack: true }]])
    const before = v.health!.hp
    for (let t = 0; t < 600; t++) {
      p.facing = 0
      v.health!.iframes = 0
      tickWorld(w, attacking)
    }
    expect(vigilAwake(v)).toBe(false)
    expect(v.ai!.dormant).toBe(true)
    expect(v.health!.hp).toBeLessThan(before) // real, silent progress
  })

  it('the meter DECAYS when the room goes quiet — backing off actually buys you it', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    // A brief clatter: short enough that it cannot reach the threshold on its
    // own, which is the whole point — one dropped crate must be survivable.
    emitNoise(w, cx, cy, 8)
    run(w, 8)
    const peak = v.ai!.noise ?? 0
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(wakeThreshold(w))
    run(w, 40) // silence
    expect(v.ai!.noise ?? 0).toBeLessThan(peak)
    expect(vigilAwake(v)).toBe(false)
  })

  it('a bigger party gets a bigger budget, so co-op is not decided by headcount', () => {
    const { w, cx, cy } = arena()
    const solo = wakeThreshold(w)
    spawnPlayer(w, 0, cx - 3, cy).health = { hp: 100, max: 100, iframes: 0 }
    const one = wakeThreshold(w)
    spawnPlayer(w, 1, cx - 4, cy).health = { hp: 100, max: 100, iframes: 0 }
    const two = wakeThreshold(w)
    expect(one).toBe(solo) // one player IS the solo baseline
    expect(two).toBeGreaterThan(one)
  })

  it('a DOWNED teammate stops counting toward the budget', () => {
    const { w, cx, cy } = arena()
    const a = spawnPlayer(w, 0, cx - 3, cy)
    const b = spawnPlayer(w, 1, cx - 4, cy)
    a.health = { hp: 100, max: 100, iframes: 0 }
    b.health = { hp: 100, max: 100, iframes: 0 }
    const both = wakeThreshold(w)
    b.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    expect(wakeThreshold(w)).toBeLessThan(both)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('escalation — each wake is longer, and the last never ends', () => {
  it('wake durations follow the table, then become permanent', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)

    const wakeIt = (): void => {
      emitNoise(w, cx, cy)
      expect(ticksToWake(w, v, 200)).toBeGreaterThanOrEqual(0)
    }
    const settleIt = (limit: number): boolean => {
      w.noises.length = 0 // silence, so it is not immediately re-woken
      for (let t = 0; t < limit; t++) {
        w.noises.length = 0
        tickWorld(w, idle())
        if (!vigilAwake(v)) return true
      }
      return false
    }

    wakeIt()
    expect(v.ai!.wakes).toBe(1)
    expect(settleIt(VIGIL_WAKE_TICKS[0] + 30)).toBe(true) // first wake ends

    wakeIt()
    expect(v.ai!.wakes).toBe(2)
    // The second wake outlasts the first — it must NOT have settled by then.
    w.noises.length = 0
    run(w, VIGIL_WAKE_TICKS[0] + 5)
    expect(vigilAwake(v)).toBe(true)
    expect(settleIt(VIGIL_WAKE_TICKS[1] + 30)).toBe(true)

    wakeIt()
    expect(v.ai!.wakes).toBe(3)
    // THE THIRD DOES NOT END. Well past the longest tabled duration, still awake.
    expect(settleIt(VIGIL_WAKE_TICKS[1] * 2 + 120)).toBe(false)
    expect(vigilAwake(v)).toBe(true)
  })

  it('settling restores the soft, dormant body (the swap goes BOTH ways)', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    emitNoise(w, cx, cy)
    expect(ticksToWake(w, v, 200)).toBeGreaterThanOrEqual(0)
    expect(v.resist!.physical).toBe(VIGIL_AWAKE_RESIST)

    for (let t = 0; t < VIGIL_WAKE_TICKS[0] + 30 && vigilAwake(v); t++) {
      w.noises.length = 0
      tickWorld(w, idle())
    }
    expect(vigilAwake(v)).toBe(false)
    expect(v.ai!.dormant).toBe(true)
    expect(v.resist!.physical).toBe(VIGIL_ASLEEP_RESIST)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('the entrance, feedback, and snapshot hygiene', () => {
  it('does NOTHING until a player has witnessed it — no budget spent on an empty room', () => {
    // The Mireclaw once burned its whole brood cap before anyone opened the
    // door. The Vigil would otherwise burn its escalating wakes the same way.
    const { w, cx, cy } = arena()
    const v = spawnNpc(w, 'vigil', cx, cy) // NOT revealed
    for (let t = 0; t < 120; t++) {
      emitNoise(w, cx, cy)
      tickWorld(w, idle())
    }
    expect(w.mission.bossRevealed).toBeFalsy()
    expect(vigilAwake(v)).toBe(false)
    expect(v.ai!.noise).toBeUndefined() // not even accumulating
  })

  it('announces itself once a live player can see it, and pins a meter', () => {
    const { w, cx, cy } = arena()
    const v = spawnNpc(w, 'vigil', cx, cy)
    const p = spawnPlayer(w, 0, cx + 3, cy)
    p.health = { hp: 100, max: 100, iframes: 0 }
    run(w, 3)
    expect(w.mission.bossRevealed).toBe(true)
    // Stealth without feedback is unfair: the meter is on screen from the off.
    const meter = w.annotations.find((a) => a.id === `vigil:${v.id}`)
    expect(meter).toBeDefined()
    expect(meter!.text).toContain('ASLEEP')
    expect(meter!.targetId).toBe(v.id)
  })

  it('the meter reads AWAKE once it is up, and fills as the room gets loud', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const text = (): string => w.annotations.find((a) => a.id === `vigil:${v.id}`)!.text!
    emitNoise(w, cx, cy)
    run(w, 6)
    expect(text()).toContain('ASLEEP')
    expect(text()).toContain('|') // the budget is visibly filling
    expect(ticksToWake(w, v, 200)).toBeGreaterThanOrEqual(0)
    expect(text()).toBe('AWAKE — BACK OFF')
  })

  it('an untouched Vigil carries NO extra fields, so snapshots round-trip clean', () => {
    const { w, x, y } = pristine()
    const v = vigil(w, x, y)
    run(w, 30) // quiet room
    // The three Vigil fields are all optional and DELETED at rest, so a Vigil
    // nobody has been loud near serializes exactly as it spawned.
    expect(v.ai!.noise).toBeUndefined()
    expect(v.ai!.wakeUntil).toBeUndefined()
    expect(v.ai!.wakes).toBeUndefined()
    const restored = deserializeWorld(serializeWorld(w))
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })

  it('survives a mid-fight snapshot byte-identically, meter and all', () => {
    const { w, x, y } = pristine()
    const v = vigil(w, x, y)
    emitNoise(w, x, y)
    run(w, 10)
    expect(v.ai!.noise).toBeGreaterThan(0) // captured mid-accumulation
    const a = deserializeWorld(serializeWorld(w))
    const b = deserializeWorld(serializeWorld(w))
    for (let t = 0; t < 60; t++) {
      tickWorld(a, idle())
      tickWorld(b, idle())
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('takes its meter with it when it dies', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    run(w, 2)
    expect(w.annotations.some((a) => a.id === `vigil:${v.id}`)).toBe(true)
    v.health!.hp = 0
    v.dead = true
    tickWorld(w, idle())
    expect(w.annotations.some((a) => a.id === `vigil:${v.id}`)).toBe(false)
  })
})
