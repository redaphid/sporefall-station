// #87 — elements differ by VERB, not by number. Each element does one thing a
// player can name mid-fight, and every control verb shares one clamp so no pair
// of elements holds a target longer than the strongest element alone.
//
//   frozen      HOLDS    — can't move or act; a hard hit shatters (PR #79)
//   burning     PANICS   — drops the fight and runs from whoever lit it,
//                          lighting any flammable it brushes past
//   electrified JUMPS    — stuns, then leaps once to the nearest other NPC
//                          (never a player) and floods anything wet
//   spore       BLINDS   — a choking NPC can't see past arm's reach, so it
//                          loses you
//   wet         DOUSES + CONDUCTS — puts a fire out, can't catch fire, carries a shock

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { playerSpawnPoint } from '../spawnPlacement'
import { expectWorldEqual, runTicks } from '../testkit'
import type { Entity } from '../entity'
import { createWorld, type World } from '../world'
import { vlen } from '../simMath'
import { fireAt, fireSystem } from './fire'
import { perceives, SPORE_BLIND_RANGE } from './goals'
import { ARC_JUMP_RADIUS, shock } from './interactions'
import { spawnObject } from './objects'
import { statusSystem } from './status'
import {
  IMMOBILIZE_IMMUNE_TICKS,
  PANIC_TICKS,
  addStatus,
  applyStatus,
  hasStatus,
  isImmobilized,
  isPanicking,
  statusFxSystem,
} from './statusFx'

const carve = (w: World, x0: number, y0: number, x1: number, y1: number, tile: number): void => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = tile
      w.level.solid[y * w.level.w + x] = tile === Tile.Wall ? 1 : 0
    }
}

/** A sealed 25x13 room in a hostile world: the fight is real, nothing else interferes. */
const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1, 'normal', true)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  carve(w, 0, 0, w.level.w - 1, w.level.h - 1, Tile.Wall)
  carve(w, cx - 12, cy - 6, cx + 12, cy + 6, Tile.Floor)
  return { w, cx, cy }
}

const tough = (e: Entity): Entity => {
  e.health!.hp = e.health!.max = 100000
  return e
}

const dist = (a: Entity, b: Entity): number => vlen(a.pos.x - b.pos.x, a.pos.y - b.pos.y)

const idle = new Map([[0, {}]])

describe('burning PANICS', () => {
  it('a thug closing on a player turns and runs the moment the player lights it', () => {
    const { w, cx, cy } = arena()
    const p = tough(spawnPlayer(w, 0, cx - 4 + 0.5, cy + 0.5))
    const thug = tough(spawnNpc(w, 'thug', cx + 0.5, cy + 0.5))
    runTicks(w, idle, 20) // it engages
    expect(thug.ai!.mode).toBe('aggro')
    const closing = dist(thug, p)

    applyStatus(w, thug, 'burning', 240, p.id)
    expect(isPanicking(w, thug)).toBe(true)
    runTicks(w, idle, 40)
    expect(thug.ai!.goal).toBe('flee')
    expect(dist(thug, p)).toBeGreaterThan(closing + 2)
  })

  it('panic ends after PANIC_TICKS and the burning thug comes back for you', () => {
    const { w, cx, cy } = arena()
    const p = tough(spawnPlayer(w, 0, cx - 4 + 0.5, cy + 0.5))
    const thug = tough(spawnNpc(w, 'thug', cx + 0.5, cy + 0.5))
    runTicks(w, idle, 5)
    applyStatus(w, thug, 'burning', 600, p.id)
    runTicks(w, idle, PANIC_TICKS + 20)
    expect(isPanicking(w, thug)).toBe(false)
    expect(hasStatus(thug, 'burning')).toBe(true) // still on fire, just no longer scared
    expect(thug.ai!.goal).not.toBe('flee')
    expect(thug.ai!.panicFrom).toBeUndefined()
    // It ran out of sight; step back into view and it fights again.
    p.pos = { x: thug.pos.x - 3, y: thug.pos.y }
    p.prevPos = { ...p.pos }
    runTicks(w, idle, 20)
    expect(thug.ai!.mode).toBe('aggro')
    expect(thug.ai!.targetId).toBe(p.id)
  })

  it('a flamethrower held on one target panics it once, then barely: total panic is bounded', () => {
    const { w, cx, cy } = arena()
    const thug = tough(spawnNpc(w, 'thug', cx + 0.5, cy + 0.5))
    let panicked = 0
    for (let t = 0; t < 900; t++) {
      if (t % 6 === 0) applyStatus(w, thug, 'burning', 240, 999)
      if (isPanicking(w, thug)) panicked++
      statusSystem(w)
      statusFxSystem(w)
      w.tick++
    }
    // 60 + 30 + 15 + 7 + 3 + 1: a geometric tail, never a perma-panic.
    expect(panicked).toBeLessThanOrEqual(PANIC_TICKS * 2)
    expect(panicked).toBeGreaterThanOrEqual(PANIC_TICKS)
  })

  it('bosses, fireproof bodies, players and the dead never panic', () => {
    const { w, cx, cy } = arena()
    const boss = spawnNpc(w, 'boss', cx, cy)
    const fireproof = spawnNpc(w, 'thug', cx + 3, cy)
    fireproof.resist = { burning: 0 }
    const p = spawnPlayer(w, 0, cx - 3, cy)
    const corpse = spawnNpc(w, 'thug', cx + 5, cy)
    corpse.dead = true
    for (const e of [boss, fireproof, p, corpse]) applyStatus(w, e, 'burning', 240)
    for (const e of [boss, fireproof, p, corpse]) expect(isPanicking(w, e)).toBe(false)
    expect(hasStatus(corpse, 'burning')).toBe(false)
  })

  it('with no lighter (a fire cell) it bolts ahead — never frozen in place fleeing itself', () => {
    const { w, cx, cy } = arena()
    const thug = tough(spawnNpc(w, 'thug', cx + 0.5, cy + 0.5))
    thug.facing = 0 // looking east
    applyStatus(w, thug, 'burning', 240)
    const x0 = thug.pos.x
    runTicks(w, new Map(), 30)
    expect(thug.pos.x - x0).toBeGreaterThan(1.5)
  })

  it('a lighter who died since the hit is no problem: it runs from where they stood', () => {
    const { w, cx, cy } = arena()
    const p = tough(spawnPlayer(w, 0, cx - 3 + 0.5, cy + 0.5))
    const thug = tough(spawnNpc(w, 'thug', cx + 0.5, cy + 0.5))
    applyStatus(w, thug, 'burning', 240, p.id)
    p.dead = true
    const x0 = thug.pos.x
    runTicks(w, new Map(), 30)
    expect(thug.pos.x).toBeGreaterThan(x0 + 1.5)
  })

  it('a burning NPC lights the crate it brushes past; a dry one does not', () => {
    const { w, cx, cy } = arena()
    const crate = spawnObject(w, 'crate', cx + 1, cy)
    const thug = spawnNpc(w, 'thug', cx + 0.9, cy + 0.5) // touching the crate
    fireSystem(w)
    expect(fireAt(w, Math.floor(crate.pos.x), Math.floor(crate.pos.y))).toBe(false)
    addStatus(w, thug, 'burning', 240)
    fireSystem(w)
    expect(fireAt(w, Math.floor(crate.pos.x), Math.floor(crate.pos.y))).toBe(true)
  })

  it('a mid-panic snapshot replays byte-identically', () => {
    const w = createWorld(5, 1, 'normal', true)
    const at = playerSpawnPoint(w.level, 0)
    const p = tough(spawnPlayer(w, 0, at.x, at.y))
    const thug = tough(spawnNpc(w, 'thug', at.x + 1, at.y))
    runTicks(w, idle, 3)
    applyStatus(w, thug, 'burning', 240, p.id)
    runTicks(w, idle, 10)
    expect(isPanicking(w, thug)).toBe(true)
    const copy = deserializeWorld(serializeWorld(w))
    runTicks(w, idle, 60)
    runTicks(copy, idle, 60)
    expectWorldEqual(w, copy)
  })
})

describe('wet DOUSES', () => {
  it('fire on a wet body only dries it: no burn, no panic', () => {
    const { w, cx, cy } = arena()
    const thug = spawnNpc(w, 'thug', cx, cy)
    addStatus(w, thug, 'wet', 150)
    applyStatus(w, thug, 'burning', 240, 999)
    expect(hasStatus(thug, 'burning')).toBe(false)
    expect(hasStatus(thug, 'wet')).toBe(false)
    expect(isPanicking(w, thug)).toBe(false)
    applyStatus(w, thug, 'burning', 240, 999) // now dry: it catches
    expect(hasStatus(thug, 'burning')).toBe(true)
  })

  it('soaking a burning body puts the fire out', () => {
    const { w, cx, cy } = arena()
    const thug = spawnNpc(w, 'thug', cx, cy)
    applyStatus(w, thug, 'burning', 240)
    addStatus(w, thug, 'wet', 150)
    expect(hasStatus(thug, 'burning')).toBe(false)
    expect(hasStatus(thug, 'wet')).toBe(true)
  })
})

describe('electrified JUMPS', () => {
  it('a Tesla hit leaps to the nearest other NPC, skipping a closer player', () => {
    const { w, cx, cy } = arena()
    const a = spawnNpc(w, 'thug', cx, cy)
    const p = spawnPlayer(w, 0, cx + 1, cy) // nearer than b
    const b = spawnNpc(w, 'thug', cx - 2, cy)
    applyStatus(w, a, 'electrified', 45, p.id)
    expect(isImmobilized(a)).toBe(true)
    expect(isImmobilized(b)).toBe(true)
    expect(isImmobilized(p)).toBe(false)
    expect(w.events.some((ev) => ev.type === 'shock' && ev.targetId === b.id)).toBe(true)
  })

  it('it leaps ONCE: the third body in a line stays free', () => {
    const { w, cx, cy } = arena()
    const a = spawnNpc(w, 'thug', cx, cy)
    const b = spawnNpc(w, 'thug', cx + 2, cy)
    const c = spawnNpc(w, 'thug', cx + 4, cy)
    applyStatus(w, a, 'electrified', 45)
    expect([a, b, c].map(isImmobilized)).toEqual([true, true, false])
  })

  it('nothing within ARC_JUMP_RADIUS: it is an ordinary stun (an empty floor)', () => {
    const { w, cx, cy } = arena()
    const a = spawnNpc(w, 'thug', cx, cy)
    const far = spawnNpc(w, 'thug', cx + ARC_JUMP_RADIUS + 0.6, cy)
    applyStatus(w, a, 'electrified', 45)
    expect(isImmobilized(a)).toBe(true)
    expect(isImmobilized(far)).toBe(false)
    expect(w.events.filter((ev) => ev.type === 'shock')).toEqual([])
  })

  it('a shocked player never throws a leap into the crowd (co-op: the NPC stun gun)', () => {
    const { w, cx, cy } = arena()
    const p1 = spawnPlayer(w, 0, cx, cy)
    const p2 = spawnPlayer(w, 1, cx + 1, cy)
    const npc = spawnNpc(w, 'thug', cx - 1, cy)
    applyStatus(w, p1, 'electrified', 45, npc.id)
    expect(isImmobilized(p1)).toBe(true)
    expect(isImmobilized(p2)).toBe(false)
    expect(isImmobilized(npc)).toBe(false)
  })

  it('a player who joins mid-floor right beside the target is still never a leap target', () => {
    const { w, cx, cy } = arena()
    const a = spawnNpc(w, 'thug', cx, cy)
    runTicks(w, new Map(), 30)
    const late = spawnPlayer(w, 1, a.pos.x + 0.8, a.pos.y)
    applyStatus(w, a, 'electrified', 45)
    expect(isImmobilized(late)).toBe(false)
  })

  it('the leap goes through the same anti-chain-lock: it cannot re-lock a body in its immunity gap', () => {
    const { w, cx, cy } = arena()
    const a = spawnNpc(w, 'thug', cx, cy)
    const b = spawnNpc(w, 'thug', cx + 2, cy)
    applyStatus(w, b, 'frozen', 10)
    for (let i = 0; i < 12; i++) {
      statusFxSystem(w)
      w.tick++
    }
    expect(isImmobilized(b)).toBe(false) // thawed, but inside the immunity gap
    applyStatus(w, a, 'electrified', 45)
    expect(isImmobilized(b)).toBe(false)
  })

  it('a leap into a wet body floods the wet cluster behind it', () => {
    const { w, cx, cy } = arena()
    const a = spawnNpc(w, 'thug', cx, cy)
    const b = tough(spawnNpc(w, 'thug', cx + 2, cy))
    const c = tough(spawnNpc(w, 'thug', cx + 3.5, cy)) // out of leap range of a, in chain range of b
    addStatus(w, b, 'wet', 150)
    addStatus(w, c, 'wet', 150)
    shock(w, a, 45)
    expect([a, b, c].map(isImmobilized)).toEqual([true, true, true])
    expect(c.health!.hp).toBeLessThan(c.health!.max)
  })
})

describe('spore BLINDS', () => {
  it('a choking thug cannot see a player five tiles off, but can at arm\'s reach', () => {
    const { w, cx, cy } = arena()
    const thug = spawnNpc(w, 'thug', cx + 0.5, cy + 0.5)
    const far = spawnPlayer(w, 0, cx + 5.5, cy + 0.5)
    const near = spawnPlayer(w, 1, cx + 0.5 + SPORE_BLIND_RANGE - 0.2, cy + 0.5)
    expect(perceives(w, thug, far)).toBe(true)
    addStatus(w, thug, 'spore', 150)
    expect(perceives(w, thug, far)).toBe(false)
    expect(perceives(w, thug, near)).toBe(true)
  })

  it('spore-dwellers (resist 0) are not blinded by their own air', () => {
    const { w, cx, cy } = arena()
    const sporeling = spawnNpc(w, 'sporeling', cx + 0.5, cy + 0.5)
    expect(sporeling.resist?.spore).toBe(0)
    const p = spawnPlayer(w, 0, cx + 4.5, cy + 0.5)
    addStatus(w, sporeling, 'spore', 150)
    expect(perceives(w, sporeling, p)).toBe(true)
  })

  it('a chaser that breathes spore stops tracking you: its last-known spot freezes as you move', () => {
    const { w, cx, cy } = arena()
    const p = tough(spawnPlayer(w, 0, cx - 3 + 0.5, cy + 0.5))
    const thug = tough(spawnNpc(w, 'thug', cx + 3 + 0.5, cy + 0.5))
    runTicks(w, idle, 10)
    expect(thug.ai!.mode).toBe('aggro')
    addStatus(w, thug, 'spore', 600)
    runTicks(w, idle, 12) // one think to register the loss of sight
    expect(thug.ai!.lastKnownTargetPos).toBeDefined()
    const lastSeen = { ...thug.ai!.lastKnownTargetPos! }
    const y0 = p.pos.y
    runTicks(w, new Map([[0, { moveX: 0, moveY: 1 }]]), 30) // the player slips away south
    expect(p.pos.y - y0).toBeGreaterThan(2)
    expect(dist(thug, p)).toBeGreaterThan(SPORE_BLIND_RANGE)
    expect(thug.ai!.lastKnownTargetPos ?? lastSeen).toEqual(lastSeen)
  })
})

// ── The clamp sweep (INSPO §1: clamps designed into the rules) ─────────────
// Two attackers each land one element on the same target on their own cadence
// and phase, for 60s. "Held" = immobilized; "out of the fight" = immobilized or
// panicking. For every ordered pair, the pair must never beat the stronger of its
// two elements used alone: no longer hold, no longer out-of-fight streak, no
// higher late-fight duty cycle. That is what "no stun-lock, no dominant pair" means.

const ELEMENT_HITS: Record<string, number> = { frozen: 120, electrified: 45, burning: 240, spore: 150, wet: 150 }
const CADENCES = [6, 12, 24, 30, 60, 90, 150]
const PHASES = [0, 3, 11]
const T = 1800

interface Pressure {
  maxHeld: number
  maxOut: number
  lateOutDuty: number
}

const pressure = (a: string, b: string): Pressure => {
  const worst: Pressure = { maxHeld: 0, maxOut: 0, lateOutDuty: 0 }
  for (const c1 of CADENCES)
    for (const c2 of CADENCES)
      for (const phase of PHASES) {
        const w = createWorld(3, 1)
        const e = tough(spawnNpc(w, 'thug', 10, 10))
        let held = 0
        let out = 0
        let lateOut = 0
        for (let t = 0; t < T; t++) {
          held = isImmobilized(e) ? held + 1 : 0
          out = isImmobilized(e) || isPanicking(w, e) ? out + 1 : 0
          worst.maxHeld = Math.max(worst.maxHeld, held)
          worst.maxOut = Math.max(worst.maxOut, out)
          if (t >= T / 2 && out > 0) lateOut++
          if (t % c1 === 0) applyStatus(w, e, a, ELEMENT_HITS[a], 900)
          if ((t + phase) % c2 === 0) applyStatus(w, e, b, ELEMENT_HITS[b], 901)
          statusSystem(w)
          statusFxSystem(w)
          w.tick++
        }
        worst.lateOutDuty = Math.max(worst.lateOutDuty, lateOut / (T / 2))
      }
  return worst
}

describe('element pair sweep: no stun-lock, no dominant pair', () => {
  const kinds = Object.keys(ELEMENT_HITS)
  const solo = Object.fromEntries(kinds.map((k) => [k, pressure(k, k)]))

  it('no element alone holds longer than a freeze', () => {
    for (const k of kinds) expect(solo[k].maxHeld).toBeLessThanOrEqual(ELEMENT_HITS.frozen)
  })

  for (const a of kinds)
    for (const b of kinds) {
      if (a === b) continue
      it(`${a} + ${b} is no stronger than the better of the two alone`, () => {
        const pair = pressure(a, b)
        const bound = (f: keyof Pressure): number => Math.max(solo[a][f], solo[b][f])
        expect(pair.maxHeld).toBeLessThanOrEqual(bound('maxHeld'))
        expect(pair.maxOut).toBeLessThanOrEqual(bound('maxOut'))
        expect(pair.lateOutDuty).toBeLessThanOrEqual(bound('lateOutDuty') + 1e-9)
      })
    }

  it('the shared guard: a shock landing as the ice melts waits out the immunity gap', () => {
    const w = createWorld(3, 1)
    const e = spawnNpc(w, 'thug', 10, 10)
    applyStatus(w, e, 'frozen', 30)
    for (let i = 0; i <= 30; i++) {
      statusFxSystem(w)
      w.tick++
    }
    applyStatus(w, e, 'electrified', 45)
    expect(isImmobilized(e)).toBe(false)
    for (let i = 0; i < IMMOBILIZE_IMMUNE_TICKS; i++) {
      statusFxSystem(w)
      w.tick++
    }
    applyStatus(w, e, 'electrified', 45)
    expect(isImmobilized(e)).toBe(true)
  })
})
