// §4.1 THE VIGIL — adversarial TDD for the boss whose verb is "be quiet".
//
// Exact world state, the REAL systems via tickWorld, assertions on the fight's
// actual contract. The design doc names three risks that could each sink this
// boss, and the first one is a genuine self-contradiction rather than a bug to
// find later — so it is the first test in the file.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { NPCS } from '../data/npcs'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { PLAYER_HP, PLAYER_START_WEAPON, spawnPlayer, starterLoadout } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, emitNoise, tickWorld, type World } from '../world'
import { applyDamage, detonate } from './combat'
import { igniteCell } from './fire'
import {
  VIGIL_ASLEEP_RESIST,
  VIGIL_AWAKE_RESIST,
  VIGIL_GUNSHOT_EARSHOT,
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

  it('A HELD TRIGGER wakes it — the real starter pistol, through tickWorld', () => {
    // Note what is NOT here: no `arm()`. The player fires the gun spawnPlayer
    // gave them, because that is the only gun any player will ever have.
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 5, cy)
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    p.facing = 0 // aimed at the Vigil
    const firing = new Map([[0, { ...emptyInput(), attack: true }]])
    let woke = -1
    for (let t = 0; t < 400 && woke < 0; t++) {
      p.facing = 0
      tickWorld(w, firing)
      if (vigilAwake(v)) woke = t
    }
    expect(woke).toBeGreaterThanOrEqual(0)

    // ── THE BUG THIS BOSS SHIPPED WITH, pinned as a number ──────────────────
    // The old meter billed every LIVE PROJECTILE every tick, so one pistol
    // bullet rang up 5 per tick for its whole 22-tick flight and crossed a
    // 45 threshold in ~13 ticks — sooner than a shot fired at max range takes
    // to ARRIVE. The Vigil therefore woke before the player's first bullet
    // could land, every time, and the fight was unwinnable. Waking must cost a
    // SUSTAINED trigger; it can never cost less than a bullet's time of flight.
    const flightTicks = Math.ceil((WEAPONS.pistol.range / WEAPONS.pistol.projectileSpeed!) * 30)
    expect(woke).toBeGreaterThan(flightTicks)
  })

  it('ONE POT-SHOT is free — a bullet is billed once, not once per tick of flight', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 9.5, cy) // near max range: the longest flight the pistol has
    p.facing = 0
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]])) // exactly one trigger pull
    let peak = 0
    for (let t = 0; t < 120; t++) {
      tickWorld(w, idle())
      peak = Math.max(peak, v.ai!.noise ?? 0)
    }
    expect(peak).toBeGreaterThan(0) // it DID hear the shot…
    expect(peak).toBeLessThan(wakeThreshold(w) / 4) // …and a quarter of the budget is the ceiling
    expect(vigilAwake(v)).toBe(false)
    expect(v.ai!.noise).toBeUndefined() // and the charge decayed all the way back to nothing
  })

  it('you cannot out-range its ears — it hears gunfire further than the pistol shoots', () => {
    // Otherwise the counterplay collapses into a POSITIONING puzzle: park at max
    // range, hold the trigger, win. The fight has to stay about cadence.
    expect(VIGIL_GUNSHOT_EARSHOT).toBeGreaterThan(WEAPONS.pistol.range)
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - WEAPONS.pistol.range, cy) // at its reach, PAST the 9-tile hearing
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    p.facing = 0
    const firing = new Map([[0, { ...emptyInput(), attack: true }]])
    let woke = -1
    for (let t = 0; t < 400 && woke < 0; t++) {
      p.facing = 0
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
describe('the quiet kill — solo must be winnable with the ONE weapon a player owns', () => {
  // ⚠️  READ THIS BEFORE ADDING A TEST TO THIS FILE.
  //
  // The Vigil shipped UNWINNABLE and this suite was green, because the fight's
  // counterplay was a KNIFE and both the scenario and the test wrote one into
  // `player.loadout` by hand. No player can do that:
  //   - `PLAYER_START_WEAPON` is a pistol, handed out by `starterLoadout`;
  //   - `interaction.ts` refuses EVERY melee/ranged pickup at the door;
  //   - `wearMelee` returns early for a player, so the one weapon never breaks;
  //   - "a gun always fires" — no magazine, no depletion, no dry-fire;
  //   - `InputCmd` has no drop/holster field, so you cannot even choose to be
  //     unarmed, which is why the `fists` fallbacks are unreachable for a player.
  // So the old test proved something about a world the game cannot produce, and
  // the real fight — pistol only — woke the boss before the first bullet landed.
  //
  // Every test below takes its weapon from `spawnPlayer` and NEVER assigns one.
  // If a Vigil test ever needs `arm()`, the fight has stopped being about
  // anything a player can actually do.

  /** Ticks between shots. `systems/vigil.ts` derives the break-even cadence at
   * ~38; 45 is the comfortable side of it, and the number the showcase uses. */
  const PACED = 45

  it('a fresh player carries the pistol and nothing else — there IS no silent option', () => {
    const { w, cx, cy } = arena()
    const p = spawnPlayer(w, 0, cx - 6, cy)
    expect(p.combat!.weapon).toBe(PLAYER_START_WEAPON)
    expect(p.loadout).toEqual(starterLoadout(PLAYER_START_WEAPON))
    expect(WEAPONS[p.combat!.weapon].kind).toBe('ranged')
  })

  it('KILLS IT with paced pistol fire alone — solo, through the real tickWorld', () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE SHIPPED BUG. A solo player carrying
    // exactly what the game gives them, firing the only gun they have on a
    // cadence, works a full-health Vigil all the way down without ever waking
    // it. If this cannot pass, the boss is not beatable and no amount of
    // retuning the meter is the answer.
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 6, cy) // nothing added, nothing swapped
    const pool = v.health!.max
    let peak = 0
    let everAwake = false
    let killedAt = -1
    for (let t = 0; t < 1500 && killedAt < 0; t++) {
      p.facing = 0 // standing still and aiming east; a centred stick holds facing
      tickWorld(w, new Map([[0, { ...emptyInput(), attack: t % PACED === 0 }]]))
      peak = Math.max(peak, v.ai!.noise ?? 0)
      everAwake ||= vigilAwake(v)
      if (v.dead || v.health!.hp <= 0) killedAt = t
    }
    expect(killedAt).toBeGreaterThan(0)
    expect(v.health!.hp).toBeLessThanOrEqual(0)
    // The pool it really spawns with: the shipped NPCS row (260), scaled up by
    // `spawnNpc` for the floor — 299 here. Asserted against the data row rather
    // than a literal so a rebalance moves it, but it can never quietly become
    // the showcase scenario's inflated 2000.
    expect(pool).toBeGreaterThanOrEqual(NPCS.vigil.hp)
    expect(pool).toBeLessThan(NPCS.vigil.hp * 2)
    expect(everAwake).toBe(false) // it slept through its own death
    expect(peak).toBeLessThan(wakeThreshold(w) / 4) // and was never close to waking
    // Untouched, because a dormant Vigil cannot fight back — so this is a real
    // solo win rather than a trade the player survived on scaffolded hp.
    expect(p.health!.hp).toBe(PLAYER_HP)
  })

  it('the meter returns to ZERO between paced shots — that is why it is sustainable', () => {
    const { w, cx, cy } = arena()
    const v = vigil(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 6, cy)
    let sawCharge = false
    let sawEmpty = false
    for (let t = 0; t < PACED * 4; t++) {
      p.facing = 0
      tickWorld(w, new Map([[0, { ...emptyInput(), attack: t % PACED === 0 }]]))
      if ((v.ai!.noise ?? 0) > 0) sawCharge = true
      else if (sawCharge) sawEmpty = true // it came back down again, between shots
    }
    expect(sawCharge).toBe(true)
    expect(sawEmpty).toBe(true)
    expect(vigilAwake(v)).toBe(false)
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
