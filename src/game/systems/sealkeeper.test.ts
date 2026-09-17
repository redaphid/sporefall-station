// §4.3 THE SEALKEEPER — adversarial TDD for the boss whose verb is "demolish".
//
// Exact world state, the REAL systems via tickWorld, assertions on the fight's
// actual contract. Two of this boss's failure modes are not balance problems but
// RUN-ENDING BUGS, so they lead the file and are tested from the player's side
// rather than the boss's:
//
//   1. ENTOMBMENT. A door shut on a body makes that body permanently immobile —
//      moveAndCollide only commits a position whose whole circle fits, and every
//      direction out of a closed door's tile fails that test. The player path has
//      refused this since the door-stuck bug; an NPC that skips the check bricks
//      a character with no input able to free them.
//   2. SOFTLOCK. A party sealed in with no grenades and no pickable door. Tested
//      with an EMPTY INVENTORY throughout, never a full one — a test that hands
//      the player a grenade proves nothing about the party that has none.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd, type SimEvent } from '../types'
import { addEntity, anyPowerCut, createWorld, isBlocked, tickWorld, type World } from '../world'
import { PICK_TICKS_BY_LEVEL, pickTicks } from './interaction'
import {
  SEALKEEPER_GRID_FRAC,
  SEAL_INTERVAL,
  SEAL_LOCK_LEVEL,
  SEAL_STANDOFF,
  isSealable,
} from './sealkeeper'

const idle = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

const run = (w: World, n: number, input: Map<number, InputCmd> = idle()): SimEvent[] => {
  const seen: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    tickWorld(w, input)
    seen.push(...w.events)
  }
  return seen
}

/** A carved open arena. Mirrors vigil.test/boss.test — the level is mutated, so
 * these worlds can never round-trip (see `pristine` below for those tests). */
const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 2, 'normal', true)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 14; y <= cy + 14; y++)
    for (let x = cx - 14; x <= cx + 14; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx, cy }
}

/** A plain, OPEN door on tile (tx,ty), exactly as `missions.spawnDoors` builds
 * one. `extra` dresses it as a biolock/bog hatch for the refusal tests. */
const door = (w: World, tx: number, ty: number, extra: Partial<NonNullable<Entity['door']>> = {}): Entity => {
  const e = makeEntity('door', 'door', tx + 0.5, ty + 0.5, 0.5)
  e.door = { open: true, locked: false, lockLevel: 0, ...extra }
  e.interact = { verb: 'open', range: 1.3 }
  return addEntity(w, e)
}

/**
 * A REVEALED Sealkeeper, PLANTED (speed 0).
 *
 * Most tests here are about the seal ACT, not about the walk to it, so they pin
 * the body and let `sealkeeperSystem` run — the same way boss.test.ts skips the
 * entrance. The steering is exercised for real in "the retreat" below, and the
 * entrance has its own suite at the foot of the file.
 */
const sealkeeper = (w: World, x: number, y: number, hpFrac = 1): Entity => {
  const b = spawnNpc(w, 'sealkeeper', x, y)
  b.speed = 0
  b.health = { hp: Math.round(b.health!.max * hpFrac), max: b.health!.max, iframes: 0 }
  w.mission.bossRevealed = true
  return b
}

/** A player carrying NOTHING — no grenade, no keycard, no starter gun. The only
 * party the softlock tests are allowed to use. */
const pauper = (w: World, x: number, y: number): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.health = { hp: 100, max: 100, iframes: 0 }
  p.loadout = { inventory: [], activeSlot: -1 }
  if (p.combat) p.combat.weapon = 'fists'
  return p
}

/** A world whose LEVEL IS UNTOUCHED, for the serialization tests: `arena()`
 * carves tiles, which moves the level checksum, and `deserializeWorld` refuses a
 * snapshot whose checksum drifted. */
const pristine = (): { w: World; x: number; y: number } => {
  const w = createWorld(1, 2, 'normal', true)
  return { w, x: w.level.spawn.x, y: w.level.spawn.y }
}

// ───────────────────────────────────────────────────────────────────────────
describe('THE SAFETY CASE: it must never entomb a body in a doorway', () => {
  // This is the bug that bricks a character for the rest of the run. It is
  // first because it is the one the design doc says to write first.
  const staged = (): { w: World; d: Entity; cx: number; cy: number } => {
    const { w, cx, cy } = arena()
    const d = door(w, cx, cy)
    // The boss stands off on the +x side, within SEAL_REACH of the door.
    const boss = sealkeeper(w, cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    // DISARMED to `fists`, whose reach (0.9 + body 0.35) cannot span the 1.5
    // stand-off. Not cosmetic: with its native `claws` the boss BATTERS the
    // player standing in the doorway, and the knockback shoves them clear — so
    // the door then seals on an empty frame and the test passes or fails on
    // melee range rather than on the safety case it is supposed to be pinning.
    // (The downed-player and NPC-body cases below never saw this, because
    // neither is a legal melee target.) This isolates the seal from the shove.
    boss.combat!.weapon = 'fists'
    return { w, d, cx, cy }
  }

  it('REFUSES to shut the door on a player standing in it, and says why', () => {
    const { w, d, cx, cy } = staged()
    pauper(w, cx + 0.5, cy + 0.5) // dead centre of the doorway
    const events = run(w, 60)
    expect(d.door!.open).toBe(true) // never shut
    expect(events.some((e) => e.type === 'doorBlocked' && e.entityId === d.id)).toBe(true)
  })

  it('the player it refused is still FREE TO MOVE — the entombment never happens', () => {
    // The real assertion behind the refusal. A body sealed into a door tile
    // fails moveAndCollide's fit test in every direction, so it would sit at the
    // same position forever however hard it pushed.
    const { w, cx, cy } = staged()
    const p = pauper(w, cx + 0.5, cy + 0.5)
    run(w, 60)
    // WHILE the body is in the frame, the doorway must never have become a wall.
    // (Checked here, not after the walk below: once the player steps clear the
    // boss seals it for real — that is the design, and the test above pins it.)
    expect(isBlocked(w, cx, cy)).toBe(false)
    const before = { x: p.pos.x, y: p.pos.y }
    run(w, 30, new Map([[0, { ...emptyInput(), moveX: -1 }]])) // walk back out, westward
    // The entombment signature is a body that cannot move in ANY direction.
    expect(p.pos.x).toBeLessThan(before.x - 0.5)
  })

  it('seals the instant the doorway CLEARS — the refusal is a wait, not a give-up', () => {
    const { w, d, cx, cy } = staged()
    const p = pauper(w, cx + 0.5, cy + 0.5)
    run(w, 30)
    expect(d.door!.open).toBe(true)
    p.pos = { x: cx + 0.5 - 3, y: cy + 0.5 } // step well clear
    p.prevPos = { x: p.pos.x, y: p.pos.y }
    run(w, 30)
    expect(d.door!.open).toBe(false)
    expect(d.door!.locked).toBe(true)
  })

  it('refuses for a DOWNED player too — a body that cannot walk away still counts', () => {
    const { w, d, cx, cy } = staged()
    const p = pauper(w, cx + 0.5, cy + 0.5)
    p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    run(w, 60)
    expect(d.door!.open).toBe(true)
  })

  it('refuses for an NPC body as well — the predicate is about bodies, not players', () => {
    const { w, d, cx, cy } = staged()
    spawnNpc(w, 'thug', cx + 0.5, cy + 0.5)
    run(w, 60)
    expect(d.door!.open).toBe(true)
  })

  it('does not count ITSELF as the occupant — it can always shut a clear door', () => {
    // The silent failure mode: a stand-off that let the boss's own circle clip
    // the door tile would make it its own blocker and it would never seal at all.
    const { w, d } = staged()
    run(w, 30)
    expect(d.door!.open).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('THE SOFTLOCK RULE: every seal leaves a breach path (EMPTY inventory)', () => {
  /** A real 5x5 closet with ONE doorway — a party genuinely shut in. */
  const closet = (): { w: World; d: Entity; dx: number; dy: number; inside: { x: number; y: number } } => {
    const { w, cx, cy } = arena()
    const solid = (x: number, y: number): void => {
      w.level.tiles[y * w.level.w + x] = Tile.Wall
      w.level.solid[y * w.level.w + x] = 1
    }
    // Shell 0..6 around (cx,cy); interior cx-2..cx+2. Doorway on the east face.
    for (let x = cx - 3; x <= cx + 3; x++) {
      solid(x, cy - 3)
      solid(x, cy + 3)
    }
    for (let y = cy - 3; y <= cy + 3; y++) {
      solid(cx - 3, y)
      solid(cx + 3, y)
    }
    w.level.tiles[cy * w.level.w + (cx + 3)] = Tile.Floor
    w.level.solid[cy * w.level.w + (cx + 3)] = 0
    const d = door(w, cx + 3, cy)
    return { w, d, dx: cx + 3, dy: cy, inside: { x: cx + 0.5, y: cy + 0.5 } }
  }

  it('a solo player with NOTHING picks open the door it sealed, and walks out', () => {
    // THE HEADLINE TEST. No grenade, no keycard, no gun — the party the design
    // doc says to test with. The boss seals them in, then leaves.
    const { w, d, dx, dy, inside } = closet()
    // Boss just outside the doorway, seals it shut behind itself.
    const boss = sealkeeper(w, dx + 0.5 + SEAL_STANDOFF, dy + 0.5)
    const p = pauper(w, inside.x, inside.y)
    expect(p.loadout!.inventory).toHaveLength(0) // genuinely empty
    run(w, 30)
    expect(d.door!.open).toBe(false)
    expect(d.door!.locked).toBe(true)
    expect(isBlocked(w, dx, dy)).toBe(true) // really sealed in
    boss.dead = true // it locks up and leaves; the party is alone with the door
    run(w, 2)

    // Now the whole counterplay, through the REAL interaction system: walk to
    // the door and hold the pick channel. No item is used, because there is none.
    p.pos = { x: dx + 0.5 - 1, y: dy + 0.5 }
    p.prevPos = { x: p.pos.x, y: p.pos.y }
    const pressing = new Map([[0, { ...emptyInput(), interact: true }]])
    run(w, pickTicks(SEAL_LOCK_LEVEL) + 20, pressing)
    expect(d.door!.locked).toBe(false)
    expect(d.door!.open).toBe(true)
    expect(isBlocked(w, dx, dy)).toBe(false) // the way out is open again
  })

  it('the lock it applies is ON the pick table — never an unpickable level', () => {
    // One assignment in sealkeeper.ts is the difference between "cost you time"
    // and "ended the run". Pinned so a later tweak has to come through here.
    expect(SEAL_LOCK_LEVEL).toBeLessThanOrEqual(PICK_TICKS_BY_LEVEL.length - 1)
    expect(pickTicks(SEAL_LOCK_LEVEL)).toBeGreaterThan(0)
    expect(pickTicks(SEAL_LOCK_LEVEL)).toBeLessThanOrEqual(PICK_TICKS_BY_LEVEL[PICK_TICKS_BY_LEVEL.length - 1])

    const { w, d, dx, dy } = closet()
    sealkeeper(w, dx + 0.5 + SEAL_STANDOFF, dy + 0.5)
    run(w, 30)
    expect(d.door!.open).toBe(false)
    expect(d.door!.lockLevel).toBe(SEAL_LOCK_LEVEL)
    expect(d.door!.sealKind).toBeUndefined() // still a MUNDANE lock, not a biolock
  })

  it.each([
    ['keycard biolock', { sealKind: 'keycard' as const, keyId: 'keycard.wing0', locked: false }],
    ['power biolock', { sealKind: 'power' as const, wing: 'wing0', locked: false }],
    ['overgrown hatch', { overgrown: true, growthHp: 12 }],
  ])('REFUSES to touch a %s — re-locking one could demand a key the party spent', (_label, extra) => {
    const { w, cx, cy } = arena()
    const d = door(w, cx, cy, extra)
    sealkeeper(w, cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    expect(isSealable(d)).toBe(false)
    run(w, 120)
    expect(d.door!.open).toBe(true) // left exactly as it found it
  })

  it('NEVER touches level.solid — BFS reachability is structurally intact', () => {
    // The sim never mutates tiles, and the whole spatial kit here (doors,
    // barricades) is entity-based for that reason. A single solid write would
    // move the level checksum and break every frozen fixture.
    const { w, cx, cy } = arena()
    door(w, cx, cy)
    sealkeeper(w, cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    const before = Uint8Array.from(w.level.solid)
    run(w, 200)
    expect(Uint8Array.from(w.level.solid)).toEqual(before)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('the seal loop', () => {
  it('shuts AND re-locks — an unlocked shut door would be no obstacle at all', () => {
    const { w, cx, cy } = arena()
    const d = door(w, cx, cy)
    sealkeeper(w, cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    run(w, 30)
    expect(d.door!.open).toBe(false)
    expect(d.door!.locked).toBe(true)
  })

  it('THROTTLES: two doorways in reach are not both slammed on the same tick', () => {
    const { w, cx, cy } = arena()
    const a = door(w, cx, cy)
    const b = door(w, cx, cy + 1)
    // Stand it between the two so both are inside SEAL_REACH.
    sealkeeper(w, cx + 0.5 + 1.2, cy + 1)
    run(w, 3)
    const shutEarly = [a, b].filter((e) => !e.door!.open).length
    expect(shutEarly).toBe(1) // one per throttle window, never both at once
    run(w, SEAL_INTERVAL + 10)
    expect([a, b].filter((e) => !e.door!.open).length).toBe(2) // the second follows
  })

  it('ignores a door that is already shut — no pointless re-sealing', () => {
    const { w, cx, cy } = arena()
    const d = door(w, cx, cy, { open: false })
    const boss = sealkeeper(w, cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    run(w, 90)
    expect(boss.ai!.sealed).toBeUndefined() // it never counted a seal
    expect(d.door!.open).toBe(false) // and left the shut door exactly as it was
    expect(d.door!.lockLevel).toBe(0) // in particular it did NOT re-lock it
  })

  it('THE RETREAT: it really walks to the doorway between it and the party', () => {
    // The steering, unpinned and through the real AI — the one new
    // consideration this boss needed (behaviors.sealLane).
    const { w, cx, cy } = arena()
    const d = door(w, cx, cy)
    const boss = spawnNpc(w, 'sealkeeper', cx + 0.5 + 4, cy + 0.5) // out past the door
    w.mission.bossRevealed = true
    pauper(w, cx + 0.5 - 4, cy + 0.5) // party on the FAR side of the doorway
    run(w, 200)
    expect(d.door!.open).toBe(false) // it closed the lane between them
    expect(boss.ai!.sealed).toBeGreaterThanOrEqual(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('the grid cut — the wounded boss kills the wing', () => {
  const wingWorld = (hpFrac: number): { w: World; boss: Entity } => {
    const { w, cx, cy } = arena()
    // Put a building under the boss so it can claim a wing (fortify + the grid
    // cut both key off `ai.zone`, which spawnNpc does not stamp).
    w.level.buildings.length = 0
    w.level.buildings.push({
      rect: { x: cx - 5, y: cy - 5, w: 11, h: 11 },
      rooms: [{ x: cx - 4, y: cy - 4, w: 9, h: 9 }],
      doors: [{ x: cx - 5, y: cy }],
      role: 'warehouse',
    })
    const boss = sealkeeper(w, cx + 0.5, cy + 0.5, hpFrac)
    return { w, boss }
  }

  it('cuts the grid once wounded past the threshold — ONCE, and evented', () => {
    const { w, boss } = wingWorld(SEALKEEPER_GRID_FRAC - 0.05)
    const events = run(w, 60)
    const cuts = events.filter((e) => e.type === 'powerCut')
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toMatchObject({ type: 'powerCut', byId: boss.id })
    expect(boss.ai!.gridCut).toBe(true)
    // Latched: it never fires a second time however long the fight runs.
    expect(run(w, 300).filter((e) => e.type === 'powerCut')).toHaveLength(0)
  })

  it('does NOT cut while healthy — the outage is a wounded animal’s move', () => {
    const { w, boss } = wingWorld(1)
    const events = run(w, 120)
    expect(events.some((e) => e.type === 'powerCut')).toBe(false)
    expect(boss.ai!.gridCut).toBeUndefined() // omitted until it fires
  })

  it('the outage ROUSES the wing and raises the alarm — what the party pays for it', () => {
    // Tested against what `objects.cutPower` actually does, which is NOT the
    // `dormant`/`wakeOn` path: it clears `status.sleep` and flips any NPC whose
    // `ai.mode` is 'sleep' to 'wander', and ticks `w.alarm` up. (A spore pod is
    // dormant but its wakeOn list has no 'power-cut', and the Derelict Unit that
    // does carry that trigger is not dormant at all — so asserting on a pod here
    // would have been asserting on a mechanism this lever never touches.)
    const { w } = wingWorld(SEALKEEPER_GRID_FRAC - 0.05)
    const napper = spawnNpc(w, 'thug', w.level.w / 2 + 3, w.level.h / 2 + 3)
    napper.ai!.mode = 'sleep'
    napper.status!.sleep = 500
    const alarmBefore = w.alarm
    run(w, 60)
    expect(anyPowerCut(w)).toBe(true)
    expect(napper.ai!.mode).not.toBe('sleep')
    expect(napper.status!.sleep).toBe(0)
    expect(w.alarm).toBeGreaterThan(alarmBefore)
  })

  it('claims the wing it is met in, so the SHIPPED fortify can run for it', () => {
    // spawnNpc stamps no `ai.zone`, and `fortify` finds its building through it.
    // Without the claim the boss could never lay a barricade and the failure
    // would be invisible — the consideration would just return nothing forever.
    const { w, boss } = wingWorld(1)
    run(w, 5)
    expect(boss.ai!.zone).toBeDefined()
    expect(boss.ai!.zone!.building).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('the entrance, feedback, and snapshot hygiene', () => {
  it('does NOTHING until a player has witnessed it — no wing sealed off-screen', () => {
    // The Mireclaw once spent its whole brood cap before anyone opened the door.
    // A Sealkeeper running from tick 0 would have the wing shut and the grid
    // dark before the party arrived — an entrance with no boss behind it.
    const { w, cx, cy } = arena()
    const d = door(w, cx, cy)
    const boss = spawnNpc(w, 'sealkeeper', cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    boss.speed = 0
    run(w, 200)
    expect(w.mission.bossRevealed).toBeFalsy()
    expect(d.door!.open).toBe(true)
    expect(boss.ai!.sealed).toBeUndefined()
  })

  it('announces itself once a live player can see it, and pins a meter', () => {
    const { w, cx, cy } = arena()
    const boss = spawnNpc(w, 'sealkeeper', cx + 0.5, cy + 0.5)
    boss.speed = 0
    pauper(w, cx + 3.5, cy + 0.5)
    run(w, 3)
    expect(w.mission.bossRevealed).toBe(true)
    const meter = w.annotations.find((a) => a.id === `sealkeeper:${boss.id}`)
    expect(meter).toBeDefined()
    expect(meter!.targetId).toBe(boss.id)
    expect(meter!.text).toContain('BLOW THE DOORS') // it names the counterplay
  })

  it('the meter counts the doors it has taken from you', () => {
    const { w, cx, cy } = arena()
    door(w, cx, cy)
    const boss = sealkeeper(w, cx + 0.5 + SEAL_STANDOFF, cy + 0.5)
    run(w, 30)
    const text = w.annotations.find((a) => a.id === `sealkeeper:${boss.id}`)!.text!
    expect(text).toContain('1 SEALED')
  })

  it('an untouched Sealkeeper carries NO extra fields, so snapshots round-trip', () => {
    const { w, x, y } = pristine()
    const boss = sealkeeper(w, x, y)
    run(w, 30)
    // All four fields are optional and absent at rest.
    expect(boss.ai!.sealed).toBeUndefined()
    expect(boss.ai!.sealAt).toBeUndefined()
    expect(boss.ai!.gridCut).toBeUndefined()
    const restored = deserializeWorld(serializeWorld(w))
    expect(serializeWorld(restored)).toEqual(serializeWorld(w))
  })

  it('survives a mid-fight snapshot byte-identically', () => {
    const { w, x, y } = pristine()
    sealkeeper(w, x, y, SEALKEEPER_GRID_FRAC - 0.05)
    run(w, 20)
    const a = deserializeWorld(serializeWorld(w))
    const b = deserializeWorld(serializeWorld(w))
    for (let t = 0; t < 60; t++) {
      tickWorld(a, idle())
      tickWorld(b, idle())
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('draws NO randomness — two identical fights evolve byte-identically', () => {
    const build = (): World => {
      const { w, x, y } = pristine()
      sealkeeper(w, x, y)
      return w
    }
    const a = build()
    const b = build()
    run(a, 200)
    run(b, 200)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('takes its meter with it when it dies', () => {
    const { w, cx, cy } = arena()
    const boss = sealkeeper(w, cx + 0.5, cy + 0.5)
    run(w, 2)
    expect(w.annotations.some((a) => a.id === `sealkeeper:${boss.id}`)).toBe(true)
    boss.health!.hp = 0
    boss.dead = true
    tickWorld(w, idle())
    expect(w.annotations.some((a) => a.id === `sealkeeper:${boss.id}`)).toBe(false)
  })

  it('degenerate inputs: no doors, no players, no building → no crash', () => {
    const { w, cx, cy } = arena()
    const boss = sealkeeper(w, cx + 0.5, cy + 0.5)
    w.level.buildings.length = 0
    run(w, 200)
    expect(Number.isFinite(boss.pos.x)).toBe(true)
    expect(boss.dead).toBeFalsy()
  })
})
