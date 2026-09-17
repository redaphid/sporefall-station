// §4.2 ECHO — adversarial TDD for the boss whose verb is "never hit it the same
// way twice".
//
// Exact world state, the REAL systems via `tickWorld`, assertions on the fight's
// actual contract. The order of this file is the order of the risks:
//
//   1. THE FREEZE-SHATTER HOLE. An adaptive `resist` map is one careless line
//      away from re-opening the one-button boss execute the foundation branch
//      just closed. That is not a balance concern, it is a "the whole fight can
//      be skipped" concern, so it is the first describe block and it is tested
//      from five directions — structurally, through the API, and through a real
//      freeze ray fired by a real player at a boss that has already eaten every
//      damage kind it can adapt to.
//   2. NEVER FULLY IMMUNE. The opposite failure: a cap that lets the resistance
//      reach zero damage makes a pistol-only party's run unwinnable rather than
//      slow. Asserted by actually killing it with nothing but the starting gun.
//   3. The design itself — the cliff, the decay, and the rotation loop.

import { describe, expect, it } from 'vitest'
import { BOSSES } from '../data/bosses'
import { ELEMENTS } from '../data/elements'
import { NPCS } from '../data/npcs'
import { resistMult, type Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { arm } from '../testkit'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'
import {
  ECHO_ADAPT_KINDS,
  ECHO_BASE_RESIST,
  ECHO_KIND_TAG,
  ECHO_METER_MAX_TEXT,
  ECHO_MIN_MULT,
  echoAdaptable,
  echoRecordDamage,
  echoSystem,
} from './echo'
import { addStatus, hasStatus, IMMOBILIZE_STATUSES } from './statusFx'

/** A carved-out room to fight in. Floor 2, because Echo's `minFloor` is 2 and
 * floor 1 is byte-frozen. */
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

/**
 * A world whose LEVEL IS UNTOUCHED, for the serialization tests.
 *
 * `arena()` carves floor tiles, which moves the level checksum — and
 * `deserializeWorld` regenerates the level from seed+floor and REFUSES to load a
 * snapshot whose checksum drifted. So a carved arena can never round-trip. Echo
 * does not need to walk anywhere to adapt, so these tests do not need one.
 */
const pristine = (): { w: World; x: number; y: number } => {
  const w = createWorld(1, 2, 'normal', true)
  return { w, x: w.level.spawn.x, y: w.level.spawn.y }
}

/** A REVEALED Echo, pinned in place. Most tests here are about the resist map,
 * not the chase, so they skip the entrance the way boss.test.ts does (the gate
 * has its own suite below) and zero its speed so it stays in the line of fire.
 * `speed = 0` is a SETUP choice, not a behaviour change: nothing in echo.ts
 * reads speed. */
const echo = (w: World, x: number, y: number): Entity => {
  const e = spawnNpc(w, 'echo', x, y)
  e.speed = 0
  w.mission.bossRevealed = true
  return e
}

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])
const run = (w: World, n: number, input: Map<number, InputCmd> = idle()): void => {
  for (let i = 0; i < n; i++) tickWorld(w, input)
}

/** Land one impact blow and report the hp it actually removed. Clears i-frames
 * first so a test can measure back-to-back blows without the 5-tick gate. */
const hit = (w: World, e: Entity, amount: number): number => {
  e.health!.iframes = 0
  const before = e.health!.hp
  applyDamage(w, e, amount, e.pos.x + 1, e.pos.y, 0, 999)
  return before - e.health!.hp
}

/** Top it back up to full. The resist-measurement tests deliver far more damage
 * than its health bar holds; healing between blows keeps the ADAPTATION the only
 * variable under test instead of the fight ending halfway through the measure. */
const pin = (e: Entity): void => {
  e.health!.hp = e.health!.max
}

/** Hammer one kind of impact damage in, `blows` times, folding the ledger
 * through the real `tickWorld` between each. Returns hp removed in total. */
const hammer = (w: World, e: Entity, blows: number, amount: number, gapTicks = 1): number => {
  let removed = 0
  for (let i = 0; i < blows; i++) {
    removed += hit(w, e, amount)
    pin(e)
    run(w, gapTicks)
  }
  return removed
}

// ───────────────────────────────────────────────────────────────────────────
describe('⚠️ THE FREEZE-SHATTER HOLE — an adaptive resist map must never re-open it', () => {
  // `combat.applyDamage` EXECUTES any frozen NPC outright via `shatter()`,
  // ignoring hp, and `freezeRay` applies `frozen` for 120 ticks while dealing 0
  // damage. `resist.frozen === 0` is the only thing stopping one tap deleting
  // the fight, and it only works because `statusFx.applyImmobilize` treats 0 as
  // genuine immunity. A boss that MUTATES its own resist map is the one boss
  // that can undo that by accident.

  it('keeps ECHO_ADAPT_KINDS disjoint from IMMOBILIZE_STATUSES — the structural guard', () => {
    // Guard 1+2, asserted against the engine's OWN definition of an immobilize
    // status rather than a copy of the list. If a third immobilize kind is ever
    // added to statusFx, this fails the moment someone puts it in the
    // allow-list — which is the point.
    for (const kind of ECHO_ADAPT_KINDS) {
      expect(IMMOBILIZE_STATUSES.has(kind), `${kind} must not be adaptable`).toBe(false)
    }
    expect(echoAdaptable('frozen')).toBe(false)
    expect(echoAdaptable('electrified')).toBe(false)
    // …and the allow-list really is an allow-list, not a deny-list: an element
    // nobody has thought about is refused by default.
    expect(echoAdaptable('wet')).toBe(false)
    expect(echoAdaptable('no.such.kind')).toBe(false)
  })

  it('refuses an immobilize kind even when the tap is called with one directly', () => {
    // Guard 3: the single resist writer. Someone bypassing the damage sites and
    // calling the tap by hand still cannot move `frozen`.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    echoRecordDamage(e, 'frozen', 500)
    echoRecordDamage(e, 'electrified', 500)
    run(w, 5)
    expect(e.resist!.frozen).toBe(0)
    expect(e.resist!.electrified).toBeUndefined()
    expect(e.ai!.echoHits).toBeUndefined() // the ledger never even accepted them
  })

  it('a FULLY ADAPTED Echo still cannot be frozen, so the execute never arms', () => {
    // The headline. Teach it everything it can learn, from every direction, then
    // try the exploit.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    for (let round = 0; round < 40; round++) {
      hit(w, e, 20) // physical
      addStatus(w, e, 'burning', 60)
      addStatus(w, e, 'spore', 60)
      addStatus(w, e, 'poisoned', 60)
      pin(e)
      run(w, 10)
    }
    // It really did learn (otherwise this test proves nothing).
    expect(resistMult(e, 'physical')).toBeLessThan(1)
    // And the immunity survived every bit of it, exactly.
    expect(e.resist!.frozen).toBe(0)

    // THE EXPLOIT, step 1: the freeze must not land.
    addStatus(w, e, 'frozen', 120)
    expect(hasStatus(e, 'frozen')).toBe(false)

    // THE EXPLOIT, step 2: therefore one tap is just a tap.
    pin(e)
    const removed = hit(w, e, 1)
    expect(e.dead).toBeFalsy()
    expect(e.shattered).toBeUndefined()
    expect(e.health!.hp).toBeGreaterThan(0)
    expect(removed).toBeLessThan(e.health!.max) // emphatically NOT the whole bar
  })

  it('a real player, a real freeze ray and a real bullet cannot delete it', () => {
    // Same exploit, driven end-to-end through tickWorld rather than through the
    // status API — this is the sequence a player actually performs.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    const p = spawnPlayer(w, 0, cx - 3, cy)
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    arm(p, 'freezeRay')
    const firing = new Map([[0, { ...emptyInput(), attack: true }]])
    for (let t = 0; t < 300; t++) {
      p.facing = 0 // held on the boss
      tickWorld(w, firing)
      expect(hasStatus(e, 'frozen'), `frozen at tick ${t}`).toBe(false)
    }
    // The ray really CONNECTED — otherwise "never frozen" would be vacuously
    // true and this test would prove nothing. `applyDamage` stamps lastHurtTick
    // on every landed blow, including a 0-damage utility one like this.
    expect(e.health!.lastHurtTick, 'the freeze ray never actually hit').toBeGreaterThan(0)
    expect(e.dead).toBeFalsy()
    // Now the follow-up tap that would have shattered it.
    const hpBefore = e.health!.hp
    hit(w, e, 14)
    expect(e.dead).toBeFalsy()
    expect(e.shattered).toBeUndefined()
    expect(e.health!.hp).toBeGreaterThan(hpBefore - e.health!.max)
  })

  it('never grows an electrified key, so the stun gun keeps working on it', () => {
    // The Alpha deliberately does NOT take `electrified: 0` — that status has no
    // execute rule, so blanket immobilize immunity would delete a whole weapon
    // class to fix a bug that only ever involved frost. Echo inherits that
    // choice, and adaptation must not quietly reverse it by inventing the key.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    hammer(w, e, 60, 20, 3)
    expect(e.resist!.electrified).toBeUndefined()
    expect(resistMult(e, 'electrified')).toBe(1)
    addStatus(w, e, 'electrified', 45)
    expect(hasStatus(e, 'electrified')).toBe(true) // the stun still lands
  })

  it('leaves every non-adaptable resist key byte-identical after a long fight', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    const before = { ...e.resist }
    hammer(w, e, 80, 25, 4)
    for (const key of Object.keys(before)) {
      if (ECHO_ADAPT_KINDS.includes(key)) continue
      expect(e.resist![key], `non-adaptable key ${key} moved`).toBe(before[key])
    }
    // No key was invented either — the map's shape is stable.
    expect(Object.keys(e.resist!).sort()).toEqual(Object.keys(before).sort())
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('NEVER FULLY IMMUNE — a pistol-only party must still be able to win', () => {
  it('no multiplier ever falls below the floor, however much it eats', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    hammer(w, e, 200, 40, 1)
    for (const kind of ECHO_ADAPT_KINDS) {
      expect(resistMult(e, kind), `${kind} under floor`).toBeGreaterThanOrEqual(ECHO_MIN_MULT)
    }
  })

  it('every landed blow still removes at least 1 hp at maximum adaptation', () => {
    // THE REASON THE FLOOR IS 0.25 AND NOT 0.2. Both damage sites round, so at
    // 0.2 a 2-damage blow lands `round(0.4) = 0` — a weapon the boss is
    // genuinely immune to. At 0.25 it lands `round(0.5) = 1`.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    hammer(w, e, 200, 40, 1)
    expect(resistMult(e, 'physical')).toBe(ECHO_MIN_MULT) // pinned at the floor
    pin(e)
    expect(hit(w, e, 2)).toBeGreaterThanOrEqual(1) // the weakest thing that hits
    pin(e)
    expect(hit(w, e, 14)).toBeGreaterThanOrEqual(1) // the starting pistol
  })

  it('DIES to a solo player carrying nothing but the starting pistol', () => {
    // The adversarial test the design asked for by name. No mods, no elements,
    // no grenades — the worst loadout in the game, driven through the real fire
    // site and the real projectile system. Slowly is fine. Impossible is not.
    const { w, cx, cy } = arena()
    // A MOBILE Echo — the only test here that lets it walk, and it has to.
    // Pinning it at speed 0 (as the resist-measurement tests do) turns the
    // pistol's knockback into a one-way conveyor: ~3 knockback per hit walked it
    // from 3 tiles to 10.5 tiles in 600 ticks, past the pistol's own 10-tile
    // range, where it sat forever while its resistance decayed back to 1.0. That
    // is a stalemate manufactured by the test rig, not by the boss. A real Echo
    // closes the distance, which is what makes the fight a fight.
    const e = spawnNpc(w, 'echo', cx, cy)
    w.mission.bossRevealed = true
    const p = spawnPlayer(w, 0, cx - 3, cy)
    p.health = { hp: 1e6, max: 1e6, iframes: 0 }
    arm(p, 'pistol') // PLAYER_START_WEAPON — exactly what a run begins with
    const firing = new Map([[0, { ...emptyInput(), attack: true }]])
    let killedAt = -1
    for (let t = 0; t < 6000 && killedAt < 0; t++) {
      p.facing = 0
      tickWorld(w, firing)
      if (e.dead || e.health!.hp <= 0) killedAt = t
    }
    expect(killedAt, 'pistol-only party could not kill Echo in 200s').toBeGreaterThanOrEqual(0)
    // …and it was a real fight, not a pushover: it took meaningfully longer than
    // the same pistol would need against an unadapting body of the same size.
    expect(killedAt).toBeGreaterThan((e.health!.max / 14) * 18)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('it LEARNS — hold one trigger and the damage falls off a cliff', () => {
  it('the thirtieth identical blow lands a fraction of the first', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    const first = hit(w, e, 8)
    pin(e)
    run(w, 1)
    let last = first
    for (let i = 0; i < 30; i++) {
      last = hit(w, e, 8)
      pin(e)
      run(w, 1)
    }
    expect(first).toBe(8) // opens at parity — the first clip feels normal
    expect(last).toBeLessThan(first / 2) // and the thirtieth does not
  })

  it('learns from damage DEALT, not damage intended — so it cannot run away with itself', () => {
    // Adaptation scaled by the attacker's raw number would accelerate as the
    // boss got tougher and there would be no equilibrium for decay to hold
    // against. Two identical Echoes, one hit with blows that are mostly
    // absorbed: the one taking less actual damage must learn less.
    const { w, cx, cy } = arena()
    const hard = echo(w, cx, cy)
    const soft = echo(w, cx + 4, cy)
    soft.resist!.physical = 0.25 // already absorbing — so it DEALS far less
    for (let i = 0; i < 20; i++) {
      hit(w, hard, 20)
      hit(w, soft, 20)
      pin(hard)
      pin(soft)
      run(w, 1)
    }
    // `soft` took a quarter of the hp, so it moved far less from where it began.
    expect(1 - resistMult(hard, 'physical')).toBeGreaterThan(0.25 - resistMult(soft, 'physical'))
  })

  it('a 0-damage utility hit teaches it nothing at all', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    for (let i = 0; i < 40; i++) {
      hit(w, e, 0)
      run(w, 1)
    }
    expect(resistMult(e, 'physical')).toBe(ECHO_BASE_RESIST.physical)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('it FORGETS — decay is what makes rotation pay and stops the stall', () => {
  it('a kind left alone climbs back to its baseline — and stops exactly there', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    hammer(w, e, 40, 20, 1)
    const floored = resistMult(e, 'physical')
    expect(floored).toBeLessThan(0.5)

    run(w, 200) // back off
    const partway = resistMult(e, 'physical')
    expect(partway).toBeGreaterThan(floored) // it is genuinely forgetting

    run(w, 1200) // back off for a long time
    // Clamped AT the baseline, never above it: an Echo left alone for an hour
    // must not become progressively more fragile than one freshly spawned.
    expect(resistMult(e, 'physical')).toBe(ECHO_BASE_RESIST.physical)
  })

  it('using a kind half as often leaves it strictly higher after the same window', () => {
    // The mechanical core of "rotate and it never adapts": the SAME weapon,
    // fired at half the cadence for the same wall-time, is resisted less.
    const fast = arena()
    const eFast = echo(fast.w, fast.cx, fast.cy)
    for (let t = 0; t < 900; t++) {
      if (t % 6 === 0) {
        hit(fast.w, eFast, 14)
        pin(eFast)
      }
      run(fast.w, 1)
    }

    const slow = arena()
    const eSlow = echo(slow.w, slow.cx, slow.cy)
    for (let t = 0; t < 900; t++) {
      if (t % 18 === 0) {
        hit(slow.w, eSlow, 14)
        pin(eSlow)
      }
      run(slow.w, 1)
    }

    expect(resistMult(eSlow, 'physical')).toBeGreaterThan(resistMult(eFast, 'physical'))
  })

  it('cannot be stalled into an unwinnable wall — the ratchet only goes one way with pressure', () => {
    // Without decay the resist map would be a one-way ratchet and a long fight
    // would always end at the floor regardless of play. Prove the floor is not
    // sticky: reach it, stop, and it fully recovers.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    hammer(w, e, 200, 40, 1)
    expect(resistMult(e, 'physical')).toBe(ECHO_MIN_MULT)
    run(w, 1500)
    expect(resistMult(e, 'physical')).toBe(ECHO_BASE_RESIST.physical)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('THE ROTATION LOOP — the whole design, end to end, through tickWorld', () => {
  it('shoot until it adapts · burn while it forgets · shoot again', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)

    // ── Phase 1: hammer one kind. It learns that kind and ONLY that kind. ──
    hammer(w, e, 40, 14, 6)
    const adaptedPhysical = resistMult(e, 'physical')
    expect(adaptedPhysical).toBeLessThan(0.6)
    // The tracks are independent: bullets taught it nothing about fire. This is
    // the payoff moment — switch weapons and the new one lands in FULL.
    expect(resistMult(e, 'burning')).toBe(ECHO_BASE_RESIST.burning)

    // ── Phase 2: switch to fire. Burning damage lands unresisted, and the
    //    physical track recovers while it goes unused. ──
    const burnBefore = e.health!.hp
    addStatus(w, e, 'burning', 600)
    run(w, 400)
    expect(e.health!.hp).toBeLessThan(burnBefore) // fire really is hurting it
    // Fire never taught it about bullets…
    expect(resistMult(e, 'physical')).toBeGreaterThan(adaptedPhysical)

    // ── Phase 3: …so switching back finds the gun working again. ──
    pin(e)
    const backToBullets = hit(w, e, 14)
    expect(backToBullets).toBeGreaterThan(Math.round(14 * adaptedPhysical))
  })

  it('an element track is genuinely separate — burning never moves the physical one', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    addStatus(w, e, 'burning', 600)
    for (let t = 0; t < 600; t++) {
      pin(e)
      run(w, 1)
    }
    expect(resistMult(e, 'physical')).toBe(ECHO_BASE_RESIST.physical)
    expect(resistMult(e, 'spore')).toBe(ECHO_BASE_RESIST.spore)
    expect(resistMult(e, 'poisoned')).toBe(ECHO_BASE_RESIST.poisoned)
  })

  it('CO-OP: two players on the SAME kind are together worse than one on each', () => {
    // The role split the design promises. Doubling up spends one shared
    // resistance track twice as fast; splitting across two kinds gives each
    // track its own decay to recover against.
    const same = arena()
    const eSame = echo(same.w, same.cx, same.cy)
    let removedSame = 0
    for (let t = 0; t < 900; t++) {
      if (t % 20 === 0) {
        removedSame += hit(same.w, eSame, 8) // player A: bullets
        removedSame += hit(same.w, eSame, 8) // player B: ALSO bullets
        pin(eSame)
      }
      run(same.w, 1)
    }

    const split = arena()
    const eSplit = echo(split.w, split.cx, split.cy)
    let removedSplit = 0
    addStatus(split.w, eSplit, 'burning', 1000) // player B: fire instead
    for (let t = 0; t < 900; t++) {
      if (t % 20 === 0) {
        removedSplit += hit(split.w, eSplit, 8) // player A: bullets
      }
      const before = eSplit.health!.hp
      run(split.w, 1)
      removedSplit += Math.max(0, before - eSplit.health!.hp) // fire's share
      pin(eSplit)
    }

    // Doubling up collapses the shared track hardest…
    expect(resistMult(eSame, 'physical')).toBeLessThan(resistMult(eSplit, 'physical'))
    // …and the split party simply does more damage for the same two players.
    expect(removedSplit).toBeGreaterThan(removedSame)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('the entrance gate — nothing is learned from a room nobody is in', () => {
  it('does NOT adapt before a player has witnessed it', () => {
    // A stray fire or a drifting spore cell in the boss room would otherwise
    // teach it, unopposed, for the entire approach — and the party would walk in
    // to a boss that had already learned the floor.
    const { w, cx, cy } = arena()
    const e = spawnNpc(w, 'echo', cx, cy) // NOT revealed
    e.speed = 0
    for (let i = 0; i < 40; i++) {
      hit(w, e, 20)
      pin(e)
      run(w, 2)
    }
    expect(w.mission.bossRevealed).toBeFalsy()
    expect(resistMult(e, 'physical')).toBe(ECHO_BASE_RESIST.physical)
    expect(e.ai!.echoHits).toBeUndefined() // the ledger is discarded, not banked
  })

  it('announces itself once a live player can see it, and pins a meter', () => {
    const { w, cx, cy } = arena()
    const e = spawnNpc(w, 'echo', cx, cy)
    e.speed = 0
    const p = spawnPlayer(w, 0, cx + 3, cy)
    p.health = { hp: 100, max: 100, iframes: 0 }
    run(w, 3)
    expect(w.mission.bossRevealed).toBe(true)
    const meter = w.annotations.find((a) => a.id === `echo:${e.id}`)
    expect(meter).toBeDefined()
    expect(meter!.targetId).toBe(e.id)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('legibility — "why is my gun suddenly bad" must be answerable on screen', () => {
  it('states the rule before the first hit, then names the kind it has learned', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    const text = (): string => w.annotations.find((a) => a.id === `echo:${e.id}`)!.text!
    run(w, 1)
    expect(text()).toBe('ADAPTS TO REPEATED DAMAGE')

    hammer(w, e, 30, 20, 1)
    expect(text()).toContain('ADAPTED')
    expect(text()).toContain('GUN') // the kind that actually went stale
    expect(text()).toContain('|') // …and visibly how far
    expect(text()).not.toContain('FIRE') // an untouched kind is not reported
  })

  it('NEVER exceeds the BLE annotation text cap, in any adaptation state', () => {
    // Sim-authored annotations stream to co-op clients and the wire caps their
    // text; over the cap the mark is dropped on the joiner's phone SILENTLY, so
    // the remote player would never see the one read-out that explains why their
    // gun stopped working. Asserted across every reachable combination rather
    // than trusting the character count done by hand in the comment.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    const label = (): string => w.annotations.find((x) => x.id === `echo:${e.id}`)!.text!

    run(w, 1)
    expect(label().length).toBeLessThanOrEqual(ECHO_METER_MAX_TEXT) // the opening label

    // THE WORST CASE IS SET DIRECTLY, not hammered into existence, because it is
    // not reachable through damage: an element's DOT is 1–2 hp against a decay
    // that refunds ~0.0025/tick, so burning/poisoned/spore recover faster than
    // they can ever be taught (see CORRECTIONS C5 in docs/design/boss-variety.md).
    // Driving the label through gameplay would therefore only ever light the GUN
    // bar and would quietly stop testing the widest string — which is exactly
    // the string the wire cap exists to bound. So: pin every track at the floor.
    for (const kind of ECHO_ADAPT_KINDS) e.resist![kind] = ECHO_MIN_MULT
    run(w, 1)

    const widest = label()
    // It really is the widest label — every kind reported at once, from the same
    // tag table the sim prints, so a renamed tag cannot drift under this test.
    for (const kind of ECHO_ADAPT_KINDS) expect(widest, kind).toContain(ECHO_KIND_TAG[kind])
    expect(widest.length, `over the wire cap: "${widest}"`).toBeLessThanOrEqual(ECHO_METER_MAX_TEXT)
  })

  it('rewrites the mark ONLY when the text changes, so the BLE gate keeps working', () => {
    // The co-op broadcast is change-gated: steady state costs zero bytes. A
    // label rewritten every tick would turn a free feature into constant BLE
    // traffic. The annotation object must therefore be the SAME object, with the
    // same text, across ticks where nothing meaningful moved.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    run(w, 2)
    const mark = w.annotations.find((a) => a.id === `echo:${e.id}`)!
    const before = mark.text
    run(w, 30) // quiet ticks — nothing is being learned or forgotten
    expect(w.annotations.filter((a) => a.id === `echo:${e.id}`).length).toBe(1) // never duplicated
    expect(w.annotations.find((a) => a.id === `echo:${e.id}`)).toBe(mark) // same object
    expect(mark.text).toBe(before) // …and untouched
  })

  it('the boss bar teaches the VERB, not the hp', () => {
    // A phase label that narrated hp would waste the one place the player is
    // already looking on information the bar itself already shows.
    const def = BOSSES.echo
    expect(def.phases.map((p) => p.label).join(' ')).toMatch(/ROTATE|SWITCH/)
    expect(`Purge ${def.missionName} in the cargo hold`).not.toMatch(/\bthe the\b/i)
  })

  it('takes its meter with it when it dies', () => {
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    run(w, 2)
    expect(w.annotations.some((a) => a.id === `echo:${e.id}`)).toBe(true)
    e.health!.hp = 0
    e.dead = true
    tickWorld(w, idle())
    expect(w.annotations.some((a) => a.id === `echo:${e.id}`)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('determinism and snapshot hygiene', () => {
  it('consumes NOTHING from the RNG — the stream position is untouched', () => {
    // Every frozen level checksum and pinned mission placement in the repo
    // depends on no system quietly drawing a value it did not used to.
    const { w, x, y } = pristine()
    echo(w, x, y)
    const before = w.rng.state()
    for (let i = 0; i < 50; i++) echoSystem(w)
    expect(w.rng.state()).toBe(before)
  })

  it('an untouched Echo carries NO extra fields, so snapshots round-trip clean', () => {
    const { w, x, y } = pristine()
    const e = echo(w, x, y)
    run(w, 30) // nobody shooting
    expect(e.ai!.echoHits).toBeUndefined() // the ledger is deleted, not emptied
    const restored = deserializeWorld(serializeWorld(w))
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })

  it('survives a MID-FIGHT snapshot byte-identically, adapted resistances and all', () => {
    const { w, x, y } = pristine()
    const e = echo(w, x, y)
    hammer(w, e, 25, 20, 2)
    expect(resistMult(e, 'physical')).toBeLessThan(1) // captured mid-adaptation

    const snap = serializeWorld(w)
    const restored = deserializeWorld(snap)
    expect(serializeWorld(restored)).toEqual(snap)
    // The learned state really did travel, rather than being reset on load.
    const there = restored.entities.find((x2) => x2.ai?.behavior === 'echo')!
    expect(there.resist!.physical).toBe(e.resist!.physical)
    expect(there.resist!.frozen).toBe(0)
  })

  it('two worlds restored from one mid-fight snapshot tick identically', () => {
    const { w, x, y } = pristine()
    const e = echo(w, x, y)
    hammer(w, e, 15, 20, 3)
    const a = deserializeWorld(serializeWorld(w))
    const b = deserializeWorld(serializeWorld(w))
    for (let t = 0; t < 120; t++) {
      tickWorld(a, idle())
      tickWorld(b, idle())
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('stores short, stable numbers rather than float noise', () => {
    // Drift is deterministic so this is not correctness — it keeps a snapshot
    // diff readable instead of a wall of 0.6000000000000001.
    const { w, cx, cy } = arena()
    const e = echo(w, cx, cy)
    hammer(w, e, 20, 13, 2)
    for (const kind of ECHO_ADAPT_KINDS) {
      const v = e.resist![kind]
      expect(Math.round(v * 10000) / 10000, `${kind} is not 4dp`).toBe(v)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('registry integrity — the sim and the data row must not drift', () => {
  it('NPCS.echo.resist is exactly ECHO_BASE_RESIST plus the frost immunity', () => {
    // The baseline table is duplicated (systems/echo.ts owns the adaptation
    // math, data/npcs.ts owns the spawn state). Same co-location-plus-assertion
    // idiom bosses.test.ts uses for Mireclaw's phase fractions.
    expect(NPCS.echo.resist).toEqual({ ...ECHO_BASE_RESIST, frozen: 0 })
  })

  it('every adaptable kind is a real damage kind that can actually deal damage', () => {
    // `physical` is impact; the rest must be elements with a non-zero DOT. An
    // adaptation track for a kind that removes no hp could never move, and would
    // print a permanently empty bar on the meter.
    for (const kind of ECHO_ADAPT_KINDS) {
      if (kind === 'physical') continue
      expect(ELEMENTS[kind], `${kind} is not an element`).toBeDefined()
      expect(ELEMENTS[kind].dot, `${kind} deals no damage`).toBeGreaterThan(0)
    }
  })

  it('opens at parity on every adaptable kind, so the first clip feels normal', () => {
    for (const kind of ECHO_ADAPT_KINDS) expect(ECHO_BASE_RESIST[kind]).toBe(1)
  })
})
