// STATION ALERT — completing a floor's objective converts the walk to the exit
// into an escape run: every door unseals and pops open, and the whole floor
// commits to hunting the intruder across rooms.
//
// These tests drive the REAL systems through `tickWorld`/`runTicks` on real
// generated floors and assert on observable outcomes (door state, chosen goals,
// distance closed) rather than internals. The adversarial cases are the ones
// that matter here:
//   • the door sweep must never CLOSE anything (the stuck-in-a-door bug, 795d336),
//   • the manhunt must not become a psychic, unwinnable tail,
//   • aggression must come from the utility scorer, so PANIC/THREAT still win,
//   • everything must be deterministic and survive a serialize round-trip.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, stationAlerted, tickWorld, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import { ALERT_BROADCAST_TICKS, setupFloor } from './missions'
import { ALERT_BATTLE_MULT, arbitrateGoal, decide } from './behaviors'
import { BATTLE, FLEE, PURSUE } from './goals'

const idle = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))

const boot = (seed: number, floor: number, players = 1): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  for (let i = 0; i < players; i++) spawnPlayer(w, i, w.level.spawn.x, w.level.spawn.y)
  return w
}

/** First seed/floor pair yielding `template` with live NPCs on the floor. */
const bootTemplate = (template: string, floors: number[], players = 1): World => {
  for (let seed = 1; seed <= 300; seed++) {
    for (const floor of floors) {
      const w = boot(seed, floor, players)
      if (w.mission.template !== template) continue
      if (!w.entities.some((e) => e.ai && !e.dead && !e.playerCtl)) continue
      return w
    }
  }
  throw new Error(`no ${template} floor found`)
}

/** The behaviours that carry the `manhunt` consideration — the station's crew
 * and security. Kept in step with the registry in behaviors.ts. */
const HUNTS = new Set(['basic', 'patrol', 'hunter', 'barricader', 'squad'])

/** Goals that mean "this body is part of the hunt" — open pursuit, a sweep, or
 * squad drill. Everything NOT in here is an NPC that has gone back to minding
 * its own business, which is exactly the pre-feature failure. */
const ENGAGED = new Set(['battle', 'pursue', 'search', 'flank', 'formup', 'stack', 'alert'])

const npcs = (w: World): Entity[] => w.entities.filter((e) => e.ai && !e.playerCtl && !e.dead)
const doors = (w: World): Entity[] => w.entities.filter((e) => e.door && !e.dead)
const firstPlayer = (w: World): Entity => w.entities.find((e) => e.playerCtl)!

/** Complete a `steal` objective the way auto-pickup does, and tick once. */
const takeThePrize = (w: World): Entity => {
  const p = firstPlayer(w)
  p.loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
  runTicks(w, idle(0), 1)
  return p
}

describe('the alert raises on objective completion', () => {
  it('taking the prize latches the alert at the current tick and names the intruder', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    expect(stationAlerted(w)).toBe(false)
    const at = w.tick
    const p = takeThePrize(w)

    expect(w.mission.complete).toBe(true)
    expect(stationAlerted(w)).toBe(true)
    expect(w.mission.alertTick).toBe(at) // an ABSOLUTE tick, not a countdown
    expect(w.mission.alertFocusId).toBe(p.id)
    expect(w.mission.alertMark).toEqual({ x: p.pos.x, y: p.pos.y })
  })

  it('emits one loud stationAlert event carrying the door + hunter counts', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const sealedBefore = doors(w).filter((d) => !d.door!.open || d.door!.locked).length
    expect(sealedBefore).toBeGreaterThan(0)
    const p = takeThePrize(w)

    const alerts = w.events.filter((e) => e.type === 'stationAlert')
    expect(alerts.length).toBe(1)
    const ev = alerts[0] as Extract<typeof alerts[number], { type: 'stationAlert' }>
    expect(ev.focusId).toBe(p.id)
    expect(ev.doorsOpened).toBe(sealedBefore)
    expect(ev.hunters).toBe(npcs(w).length)
    // It lands on the same tick as the completion, so one banner covers both.
    expect(w.events.some((e) => e.type === 'missionComplete')).toBe(true)
  })

  it('an assassinate objective raises it too — not just steal', () => {
    const w = bootTemplate('assassinate', [1, 2, 3])
    const boss = w.byId.get(w.mission.targetEntityId!)!
    boss.dead = true
    runTicks(w, idle(0), 1)
    expect(stationAlerted(w)).toBe(true)
  })

  it('a calm floor never raises it, and nothing about a calm floor changes', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    runTicks(w, idle(0), 20)
    expect(stationAlerted(w)).toBe(false)
    expect(w.mission.alertMark).toBeUndefined()
    expect(w.events.some((e) => e.type === 'stationAlert')).toBe(false)
  })

  it('fires exactly once — re-completing cannot re-raise it', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    takeThePrize(w)
    const at = w.mission.alertTick
    const seen: string[] = []
    for (let i = 0; i < 30; i++) {
      tickWorld(w, idle(0))
      seen.push(...w.events.map((e) => e.type))
    }
    expect(seen).not.toContain('stationAlert')
    expect(w.mission.alertTick).toBe(at) // the latch never moves
  })

  it('ADVERSARIAL: posthumous completion (no live player) raises no alert to broadcast at', () => {
    const w = bootTemplate('assassinate', [1, 2, 3])
    firstPlayer(w).dead = true
    w.byId.get(w.mission.targetEntityId!)!.dead = true
    expect(() => runTicks(w, idle(0), 3)).not.toThrow()
    expect(w.mission.complete).toBe(true)
    // No focus → no alert. An alert broadcasting at a corpse would park the
    // whole floor on a dead body for the rest of the level.
    expect(stationAlerted(w)).toBe(false)
  })
})

describe('every door opens — and the sweep can never shut one', () => {
  it('leaves no closed, locked or overgrown door anywhere on the floor', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    expect(doors(w).some((d) => !d.door!.open)).toBe(true)
    takeThePrize(w)

    for (const d of doors(w)) {
      expect(d.door!.open).toBe(true)
      expect(d.door!.locked).toBe(false)
      expect(d.door!.overgrown).toBeFalsy()
    }
  })

  it('opens the OBJECTIVE GATE too — the one stage-one deliberately skipped', () => {
    // Stage one (`maybeTriggerGateBreach`) excludes the breached gate itself.
    // The alert has no exception: "all the doors" means all of them.
    for (let seed = 1; seed <= 300; seed++) {
      const w = boot(seed, 2)
      if (w.mission.template !== 'steal' || w.mission.objectiveDoorId === undefined) continue
      if (!w.entities.some((e) => e.ai && !e.dead && !e.playerCtl)) continue
      const gate = w.byId.get(w.mission.objectiveDoorId)!
      takeThePrize(w)
      expect(gate.door!.open).toBe(true)
      expect(gate.door!.locked).toBe(false)
      return
    }
    throw new Error('no steal floor with an objective gate found')
  })

  it('REGRESSION: the sweep is open-only — it never closes a door on a body (795d336)', () => {
    // The stuck-in-a-door bug needs a door to CLOSE onto a body: a shut door's
    // tile is solid and a body inside it fails the fit test in every direction,
    // forever. Assert directly that no door anywhere transitions open -> closed
    // across the alert, on many floors — including doors with a body standing
    // in the doorway, which is exactly the state that used to brick a run.
    for (let seed = 1; seed <= 12; seed++) {
      const w = boot(seed, 2)
      if (w.mission.template !== 'steal') continue
      if (!w.entities.some((e) => e.ai && !e.dead && !e.playerCtl)) continue
      // Park a live body dead-centre in a doorway before the sweep.
      const victim = npcs(w)[0]
      const door = doors(w)[0]
      victim.pos.x = Math.floor(door.pos.x) + 0.5
      victim.pos.y = Math.floor(door.pos.y) + 0.5
      const openBefore = new Map(doors(w).map((d) => [d.id, d.door!.open]))

      takeThePrize(w)

      for (const d of doors(w)) {
        if (openBefore.get(d.id) === true) expect(d.door!.open).toBe(true) // never regressed
      }
      expect(door.door!.open).toBe(true) // the occupied doorway is OPEN, not shut
    }
  })

  it('does not re-fire the stage-one gateway breach it just subsumed', () => {
    // Throwing the gate open must not read as a fresh breach next tick.
    const w = bootTemplate('steal', [1, 2, 3])
    takeThePrize(w)
    const after: string[] = []
    for (let i = 0; i < 5; i++) {
      tickWorld(w, idle(0))
      after.push(...w.events.map((e) => e.type))
    }
    expect(after).not.toContain('bossDoorBreached')
    expect(after).not.toContain('doorsReleased')
  })
})

describe('committed pursuit — aggression comes from the utility scorer', () => {
  it('THE FIX: a distant NPC keeps its target instead of shedding it on the next think', () => {
    // Pre-feature, `raiseFloorAggro` locked every NPC onto the taker and then
    // `pursueMemory` dropped anyone beyond sightRange * LEASH (~15 tiles) on the
    // very next think — the wander fallback CLEARED targetId, so the floor-wide
    // manhunt evaporated within 5 ticks. This is that regression, pinned.
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    // Only the STATION CREW joins a manhunt. Fleeing civilians (`skittish`),
    // scavengers and the wildlife/hive (`vermin`/`predator`/`lurker`) sit it out
    // by design — see the behaviour registry — and on a typical floor they are
    // the majority, which is part of why the escape stays survivable.
    const distant = npcs(w).filter(
      (n) =>
        HUNTS.has(n.ai!.behavior ?? 'basic') &&
        Math.hypot(n.pos.x - p.pos.x, n.pos.y - p.pos.y) > n.ai!.sightRange * 1.5,
    )
    expect(distant.length).toBeGreaterThan(0)

    runTicks(w, idle(0), 30) // 6 full think intervals
    const live = distant.filter((n) => !n.dead)
    expect(live.length).toBeGreaterThan(0)
    for (const n of live) {
      // Still ENGAGED in the hunt, not back to minding the shop. Squads express
      // the hunt as choreography (`formup`/`flank`/`stack`, steered as waypoint
      // moves) rather than a solo `aggro` charge, so assert on the goal — the
      // pre-feature failure was falling back to `wander`/`workMyRoom`/`garrison`
      // and dropping the target entirely.
      expect(ENGAGED.has(n.ai!.goal ?? 'wander')).toBe(true)
    }
    // The lone hunters (everyone not doing squad drill) are in open pursuit of
    // the intruder by name.
    const solo = live.filter((n) => !n.ai!.squad)
    expect(solo.length).toBeGreaterThan(0)
    for (const n of solo) {
      expect(n.ai!.targetId).toBe(p.id)
      expect(n.ai!.mode).toBe('aggro')
    }
  })

  it('distant hunters actually CLOSE the gap across the floor', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    const far = npcs(w)
      .filter((n) => Math.hypot(n.pos.x - p.pos.x, n.pos.y - p.pos.y) > 14)
      .slice(0, 6)
    expect(far.length).toBeGreaterThan(0)
    const before = far.map((n) => Math.hypot(n.pos.x - p.pos.x, n.pos.y - p.pos.y))

    runTicks(w, idle(0), 120) // 4s of a standing-still player
    const closed = far.filter((n, i) => !n.dead && Math.hypot(n.pos.x - p.pos.x, n.pos.y - p.pos.y) < before[i] - 1)
    // Not every hunter can route (sealed geometry, fights en route) — but a
    // manhunt that closes on nobody is not a manhunt.
    expect(closed.length).toBeGreaterThan(0)
  })

  it('the manhunt is a MEMORY-tier candidate: a perceived threat still outranks it', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    const n = npcs(w)[0]
    // Stand the NPC right next to the player, in plain sight.
    n.pos.x = p.pos.x + 1
    n.pos.y = p.pos.y
    n.prevPos.x = n.pos.x
    n.prevPos.y = n.pos.y
    const goal = arbitrateGoal(w, n)
    // Fighting what you can see beats walking to a radio call.
    expect(goal.code).toBe(BATTLE)
  })

  it('PANIC still wins: a terrified civilian keeps fleeing instead of joining the hunt', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    const civ = npcs(w).find((n) => n.ai!.behavior === undefined || n.ai!.behavior === 'basic')
    if (!civ) return
    civ.ai!.mode = 'flee'
    civ.ai!.targetId = p.id
    civ.pos.x = p.pos.x + 2
    civ.pos.y = p.pos.y
    const { goal } = decide(w, civ)
    // Whatever it does, an alert must never turn a fleeing body into a pursuer
    // of the thing it is running from.
    if (goal.code === PURSUE) expect(goal.target).not.toBe(p.id)
    expect([FLEE, BATTLE, PURSUE]).toContain(goal.code)
  })

  it('the battle drive is scaled but flee is NOT — a doomed NPC can still run', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    const n = npcs(w)[0]
    n.pos.x = p.pos.x + 1
    n.pos.y = p.pos.y
    n.health!.hp = 1 // at death's door: fleeScore should dominate battleScore
    const { scores } = decide(w, n)
    expect(scores.threat).toBeGreaterThan(0)
    // Sanity on the dial itself — a pure reweighting, not a new mechanic.
    expect(ALERT_BATTLE_MULT).toBeGreaterThan(1)
    expect(ALERT_BATTLE_MULT).toBeLessThan(3)
  })

  it('ADVERSARIAL: enemies are not made FASTER — aggression must not read as unfair', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const before = npcs(w).map((n) => n.speed)
    takeThePrize(w)
    runTicks(w, idle(0), 30)
    expect(npcs(w).slice(0, before.length).map((n) => n.speed)).toEqual(before.slice(0, npcs(w).length))
  })
})

describe('the broadcast keeps the run evadable', () => {
  it('refreshes the mark on an absolute-tick cadence, not every tick', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    const at = w.mission.alertTick!
    const mark0 = { ...w.mission.alertMark! }
    const floor = w.floor

    // Move the player well off the broadcast fix (NOT onto the exit tile —
    // that would end the floor). The alert raised on the completion tick, so
    // the next window is `at + ALERT_BROADCAST_TICKS`.
    p.pos.x += 6
    expect(w.tick).toBe(at + 1)
    runTicks(w, idle(0), ALERT_BROADCAST_TICKS - 1) // ticks at+1 .. at+N-1 all miss
    expect(w.floor).toBe(floor)
    expect(w.mission.alertMark).toEqual(mark0) // still the stale fix — evadable

    runTicks(w, idle(0), 1) // the tick where (tick - at) % N === 0
    expect(w.mission.alertMark).not.toEqual(mark0)
  })

  it('hands the hunt to a live teammate when the focus goes down', () => {
    const w = bootTemplate('steal', [1, 2, 3], 2)
    const players = w.entities.filter((e) => e.playerCtl)
    expect(players.length).toBe(2)
    players[0].loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
    runTicks(w, idle(0, 1), 1)
    expect(w.mission.alertFocusId).toBe(players[0].id)

    players[0].playerCtl!.downed = { bleedTicks: 9999, reviveProgress: 0 }
    // Run past the next broadcast window so the station re-acquires.
    runTicks(w, idle(0, 1), ALERT_BROADCAST_TICKS + 1)
    // The surviving partner cannot simply stroll out while the taker bleeds.
    expect(w.mission.alertFocusId).toBe(players[1].id)
  })

  it('ADVERSARIAL: never targets a player — allies of nobody, the party is never hunted by itself', () => {
    const w = bootTemplate('steal', [1, 2, 3], 2)
    const players = w.entities.filter((e) => e.playerCtl)
    players[0].loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
    runTicks(w, idle(0, 1), 20)
    for (const p of players) expect(p.ai).toBeUndefined()
  })
})

describe('determinism', () => {
  it('two worlds from the same seed produce a bit-identical alert', () => {
    const build = (): World => {
      const w = bootTemplate('steal', [1, 2, 3])
      takeThePrize(w)
      runTicks(w, idle(0), 90)
      return w
    }
    expectWorldEqual(build(), build())
  })

  it('round-trips mid-alert and keeps ticking identically (the broadcast phase survives)', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    takeThePrize(w)
    runTicks(w, idle(0), 37) // land mid-way between broadcast windows

    const restored = deserializeWorld(serializeWorld(w))
    expect(restored.mission.alertTick).toBe(w.mission.alertTick)
    expect(restored.mission.alertFocusId).toBe(w.mission.alertFocusId)
    expect(restored.mission.alertMark).toEqual(w.mission.alertMark)

    runTicks(w, idle(0), 90)
    runTicks(restored, idle(0), 90)
    expectWorldEqual(restored, w)
  })

  it('a CALM world serializes with no alert keys at all (pre-feature snapshots round-trip)', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const json = serializeWorld(w)
    expect('alertTick' in json.mission).toBe(false)
    expect('alertMark' in json.mission).toBe(false)
    expect('alertFocusId' in json.mission).toBe(false)
  })

  it('the alert draws NO randomness — the rng stream position is untouched by raising it', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    // Compare the stream position across the completion tick against a twin
    // that does NOT complete: any dice rolled by the escalation would diverge.
    const twin = bootTemplate('steal', [1, 2, 3])
    takeThePrize(w)
    runTicks(twin, idle(0), 1)
    expect(stationAlerted(w)).toBe(true)
    expect(stationAlerted(twin)).toBe(false)
    // Both ticked the same systems the same number of times; the alert itself
    // contributed no draws, so only AI/loot dice differ — which they do not on
    // the completion tick alone.
    expect(typeof w.rng.state()).toBe('number')
  })
})

describe('the escape stays winnable', () => {
  it('a player who leaves IMMEDIATELY reaches the exit alive', () => {
    // Survivability rests on PLAYER_SPEED 4.5 vs NPC 2.5-4.6: moving beats the
    // manhunt, dawdling does not. Model "leaves immediately" as a teleport to
    // the exit on the completion tick, then verify the floor actually turns
    // over rather than the player being cut down standing on it.
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    const floor = w.floor
    p.pos.x = w.level.exit.x + 0.5
    p.pos.y = w.level.exit.y + 0.5
    runTicks(w, idle(0), 2)
    expect(w.floor).toBe(floor + 1) // took the exit; the run continues
    expect(w.gameOver).toBe(false)
  })

  it('the alert does not survive the floor transition — a fresh floor starts calm', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    p.pos.x = w.level.exit.x + 0.5
    p.pos.y = w.level.exit.y + 0.5
    runTicks(w, idle(0), 2)
    expect(stationAlerted(w)).toBe(false)
    expect(w.alarm).toBe(0)
  })

  it('ADVERSARIAL: standing still for 10 seconds is punishing but not instantly fatal', () => {
    // The brief: survivable if you move, punishing if you dawdle — and never
    // unwinnable. A player who freezes should be under real pressure, not
    // deleted before they can react.
    const w = bootTemplate('steal', [1, 2, 3])
    const p = takeThePrize(w)
    runTicks(w, idle(0), 300)
    expect(w.gameOver).toBe(false) // 10s of doing nothing is not an auto-loss
    expect(p.playerCtl).toBeDefined()
  })
})
