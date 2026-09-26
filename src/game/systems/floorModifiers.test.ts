// Floor modifiers (floorModifiers.ts + systems/modifierSystem.ts), adversarial.
//
// Mechanics run in hand-carved arenas (exact tiles, exact bodies) through the
// real tickWorld. Wiring, replay and the "nothing else moved" proof run on real
// populated floors. The golden digests were captured on `main` @ 16cf73f,
// before any modifier code existed.

import { describe, expect, it } from 'vitest'
import { worldDigest } from '../../debug/worldDigest'
import type { Entity } from '../entity'
import {
  BROWNOUT_SIGHT,
  FLOOR_MODIFIER_KINDS,
  HUNT_FIRST,
  HUNT_GAP,
  HUNT_RETRY,
  modifierView,
  rollFloorModifier,
  TIDE_FLOOD,
  TIDE_MIN_TILES,
  TIDE_PERIOD,
  tideFlooded,
  WADE_SPEED,
  type FloorModifierKind,
} from '../floorModifiers'
import { generateLevel } from '../levelgen/generate'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { populateWorld, spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { playerSpawnPoint } from '../spawnPlacement'
import { expectWorldEqual } from '../testkit'
import { emptyInput, SIM_RATE, type InputCmd, type SimEvent } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { kill } from './combat'
import { perceives } from './goals'
import { groupById, membersOf, packSize } from './groups'
import { shock } from './interactions'
import { nextFloor, setupFloor } from './missions'
import { applyFloorModifier, HUNT_BAND, modifierSystem } from './modifierSystem'
import { isWet } from './statusFx'

// ── helpers ────────────────────────────────────────────────────────────────

const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Digest of everything EXCEPT the feature itself: the modifier and its
 * floor-entry announcement. What remains must match `main` exactly. */
const digestWithoutModifier = (w: World): string => {
  const m = w.modifier
  const events = w.events
  delete w.modifier
  w.events = events.filter((e) => e.type !== 'floorModifier')
  const d = fnv1a(worldDigest(w))
  w.events = events
  if (m) w.modifier = m
  return d
}

const direct = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  spawnPlayer(w, 0, at.x, at.y)
  return w
}

const viaStairs = (seed: number, floor: number): World => {
  const w = direct(seed, 1)
  while (w.floor < floor) nextFloor(w)
  return w
}

const player = (w: World, slot = 0): Entity => w.entities.find((e) => e.playerCtl?.playerId === slot)!

const cmd = (over: Partial<InputCmd> = {}): InputCmd => ({ ...emptyInput(), ...over })
const tickN = (w: World, n: number, inputs: Map<number, InputCmd> = new Map(), log?: SimEvent[]): void => {
  for (let i = 0; i < n; i++) {
    tickWorld(w, inputs)
    if (log) log.push(...w.events)
  }
}

/** Whole level solid, then a carved box of `tile` — an exact, sealed stage. */
const arena = (x0 = 2, y0 = 2, x1 = 50, y1 = 30, tile: number = Tile.Floor): World => {
  const w = createWorld(11, 2, 'normal', true)
  w.level.tiles.fill(Tile.Wall)
  w.level.solid.fill(1)
  paint(w, x0, y0, x1, y1, tile)
  return w
}

const paint = (w: World, x0: number, y0: number, x1: number, y1: number, tile: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = tile
      w.level.solid[y * w.level.w + x] = 0
    }
  }
}

const mod = (kind: FloorModifierKind, since = 0): World['modifier'] =>
  kind === 'hunted' ? { kind, since, huntAt: since + HUNT_FIRST, hunts: 0 } : { kind, since }

/** Seeds whose floor rolls each modifier (found by scan, pinned by assertion). */
const SEEDS = { hunted: [4, 2], brownout: [5, 2], bogTide: [6, 2] } as const

// ── the roll ───────────────────────────────────────────────────────────────

describe('floor modifiers: the roll', () => {
  it('floor 1 is always clean', () => {
    for (let seed = 0; seed < 400; seed++) expect(rollFloorModifier(seed, 1, generateLevel(seed, 1))).toBeUndefined()
  })

  it('the pinned seeds roll the modifier each suite relies on', () => {
    for (const [kind, [seed, floor]] of Object.entries(SEEDS)) {
      expect(rollFloorModifier(seed, floor, generateLevel(seed, floor))).toBe(kind)
      expect(direct(seed, floor).modifier?.kind).toBe(kind)
    }
    expect(direct(1, 2).modifier).toBeUndefined()
  })

  it('about half of floors 2+ carry one, and every kind shows up', () => {
    const seen: Record<string, number> = {}
    let total = 0
    for (let seed = 1; seed <= 150; seed++) {
      for (let floor = 2; floor <= 7; floor++) {
        const k = rollFloorModifier(seed, floor, generateLevel(seed, floor)) ?? 'none'
        seen[k] = (seen[k] ?? 0) + 1
        total++
      }
    }
    expect(seen.none / total).toBeGreaterThan(0.42)
    expect(seen.none / total).toBeLessThan(0.58)
    const withMod = total - seen.none
    for (const k of FLOOR_MODIFIER_KINDS) expect(seen[k] / withMod).toBeGreaterThan(0.2)
  })

  it('is a pure function of seed+floor: the same floor rolls the same way every time', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const lv = generateLevel(seed, 4)
      expect(rollFloorModifier(seed, 4, lv)).toBe(rollFloorModifier(seed, 4, lv))
    }
  })

  it('never rolls a bog tide on a floor with too little low ground to flood', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const lv = generateLevel(seed, 2)
      lv.tiles.fill(Tile.Floor) // no street, hall, grate or bog anywhere
      expect(rollFloorModifier(seed, 2, lv)).not.toBe('bogTide')
    }
    expect(TIDE_MIN_TILES).toBeGreaterThan(0)
  })

  describe('byte-identical to main apart from the modifier itself', () => {
    // Captured on main @ 16cf73f with the same build helpers and `worldDigest`.
    const GOLDEN: Record<string, string> = {
      'direct:7:1': '2dec1543',
      'stairs:7:1': '2dec1543',
      'direct:1:2': 'bbca894b',
      'stairs:1:2': 'ec5b05df',
      'direct:4:2': '92795920',
      'stairs:4:2': 'b73d0410',
      'direct:5:2': 'eaa0178e',
      'stairs:5:2': 'c903e766',
      'direct:6:2': '582621cd',
      'stairs:6:2': '5878d5b7',
      'direct:1:3': '39b39de5',
      'stairs:1:3': '93e9b8c6',
      'direct:3:3': 'f0b7ed2a',
      'stairs:3:3': '33a2cc63',
      'direct:10:3': '29c82ce9',
      'stairs:10:3': '08567d0b',
      'direct:2:4': '6c0ad81b',
      'stairs:2:4': '58662ff6',
      'play:7:1': '1ed48e2d',
      'play:1:2': '53d35f3b',
    }
    const floors: [number, number][] = [[7, 1], [1, 2], [4, 2], [5, 2], [6, 2], [1, 3], [3, 3], [10, 3], [2, 4]]
    for (const [seed, floor] of floors) {
      it(`seed ${seed} floor ${floor}: layout, mission, population and both rng streams match main`, () => {
        expect(digestWithoutModifier(direct(seed, floor))).toBe(GOLDEN[`direct:${seed}:${floor}`])
        expect(digestWithoutModifier(viaStairs(seed, floor))).toBe(GOLDEN[`stairs:${seed}:${floor}`])
      })
    }
    for (const [seed, floor] of [[7, 1], [1, 2]] as const) {
      it(`clean floor seed ${seed} floor ${floor}: 300 ticks of play digest exactly as on main`, () => {
        const w = direct(seed, floor)
        expect(w.modifier).toBeUndefined()
        for (let t = 1; t <= 300; t++) {
          tickWorld(w, new Map([[0, cmd({ seq: t, moveX: Math.sin(t * 0.02), moveY: Math.cos(t * 0.03), attack: t % 40 < 10, aimX: 1, aimY: 0 })]]))
        }
        expect(digestWithoutModifier(w)).toBe(GOLDEN[`play:${seed}:${floor}`])
      })
    }
  })

  it('a clean floor serializes with no modifier key at all', () => {
    expect('modifier' in serializeWorld(direct(1, 2))).toBe(false)
  })

  it('round-trips through a snapshot and replays byte-identically', () => {
    for (const [seed, floor] of Object.values(SEEDS)) {
      const w = direct(seed, floor)
      tickN(w, HUNT_FIRST + 40) // past the first hunt and into the first flood
      const j = serializeWorld(w)
      expect(j.modifier?.kind).toBe(w.modifier?.kind)
      const b = deserializeWorld(j)
      tickN(w, 200)
      tickN(b, 200)
      expectWorldEqual(w, b)
    }
  })

  it('a new floor re-rolls: a modifier never leaks down the stairs', () => {
    // Find a seed whose floor 2 has a modifier and floor 3 has none.
    let seed = 1
    while (!(rollFloorModifier(seed, 2, generateLevel(seed, 2)) && !rollFloorModifier(seed, 3, generateLevel(seed, 3)))) seed++
    const w = viaStairs(seed, 2)
    expect(w.modifier).toBeDefined()
    nextFloor(w)
    expect(w.floor).toBe(3)
    expect(w.modifier).toBeUndefined()
  })

  it('announces itself on floor entry, after the floor change', () => {
    const w = viaStairs(4, 1)
    nextFloor(w)
    expect(w.events.map((e) => e.type)).toContain('floorModifier')
    expect(w.events.find((e) => e.type === 'floorModifier')).toEqual({ type: 'floorModifier', kind: 'hunted' })
  })

  it('is inert once the run is over', () => {
    const w = direct(...SEEDS.hunted)
    w.gameOver = true
    w.tick = w.modifier!.huntAt!
    modifierSystem(w)
    expect(w.modifier!.packId).toBeUndefined()
  })
})

// ── bog tide ───────────────────────────────────────────────────────────────

describe('bog tide', () => {
  const FLOOD_AT = TIDE_PERIOD - TIDE_FLOOD

  it('opens dry, floods for the tail of each cycle, then ebbs', () => {
    const m = mod('bogTide', 100)
    expect(tideFlooded(m, 99)).toBe(false)
    expect(tideFlooded(m, 100)).toBe(false)
    expect(tideFlooded(m, 100 + FLOOD_AT - 1)).toBe(false)
    expect(tideFlooded(m, 100 + FLOOD_AT)).toBe(true)
    expect(tideFlooded(m, 100 + TIDE_PERIOD - 1)).toBe(true)
    expect(tideFlooded(m, 100 + TIDE_PERIOD)).toBe(false)
    expect(tideFlooded(m, 100 + TIDE_PERIOD + FLOOD_AT)).toBe(true)
    expect(tideFlooded(mod('brownout', 100), 100 + FLOOD_AT)).toBe(false)
    expect(tideFlooded(undefined, 100 + FLOOD_AT)).toBe(false)
  })

  it('raises and lowers the tide with events on the exact ticks', () => {
    const w = arena()
    w.modifier = mod('bogTide', 0)
    const log: { tick: number; ev: SimEvent }[] = []
    for (let i = 0; i < TIDE_PERIOD * 2 + 1; i++) {
      tickWorld(w, new Map())
      for (const ev of w.events) if (ev.type === 'tide') log.push({ tick: w.tick - 1, ev })
    }
    expect(log).toEqual([
      { tick: FLOOD_AT, ev: { type: 'tide', rising: true } },
      { tick: TIDE_PERIOD, ev: { type: 'tide', rising: false } },
      { tick: TIDE_PERIOD + FLOOD_AT, ev: { type: 'tide', rising: true } },
      { tick: TIDE_PERIOD * 2, ev: { type: 'tide', rising: false } },
    ])
  })

  /** Street (low) on the left half, sidewalk (high) on the right. */
  const shore = (): World => {
    const w = arena(2, 2, 50, 30, Tile.Sidewalk)
    paint(w, 2, 2, 25, 30, Tile.Street)
    w.modifier = mod('bogTide', 0)
    return w
  }

  const walked = (w: World, p: Entity, ticks: number, over: Partial<InputCmd> = {}): number => {
    const x0 = p.pos.x
    tickN(w, ticks, new Map([[0, cmd({ moveX: 1, ...over })]]))
    return p.pos.x - x0
  }

  it('wading through a flooded street is slower and leaves you wet; the same walk at low tide is not', () => {
    const dry = shore()
    const pd = spawnPlayer(dry, 0, 5.5, 10.5)
    const dryDist = walked(dry, pd, 30)
    expect(isWet(pd)).toBe(false)

    const wet = shore()
    wet.tick = FLOOD_AT
    const pw = spawnPlayer(wet, 0, 5.5, 10.5)
    const wetDist = walked(wet, pw, 30)
    expect(isWet(pw)).toBe(true)
    expect(wetDist / dryDist).toBeCloseTo(WADE_SPEED, 2)
  })

  it('the high ground stays dry and full speed while the tide is in', () => {
    const w = shore()
    w.tick = FLOOD_AT
    const p = spawnPlayer(w, 0, 30.5, 10.5)
    const d = walked(w, p, 30)
    expect(isWet(p)).toBe(false)
    const ref = shore()
    const q = spawnPlayer(ref, 0, 30.5, 10.5)
    expect(d).toBeCloseTo(walked(ref, q, 30), 6)
  })

  it('a dodge roll bursts through the water at full roll speed', () => {
    const a = shore()
    a.tick = FLOOD_AT
    const pa = spawnPlayer(a, 0, 5.5, 10.5)
    const b = shore()
    const pb = spawnPlayer(b, 0, 5.5, 10.5)
    // One roll press, then hold the stick: compare the roll's own ticks.
    const roll = (w: World, p: Entity): number => {
      const x0 = p.pos.x
      tickWorld(w, new Map([[0, cmd({ moveX: 1, roll: true })]]))
      tickN(w, 5, new Map([[0, cmd({ moveX: 1 })]]))
      return p.pos.x - x0
    }
    expect(roll(a, pa)).toBeCloseTo(roll(b, pb), 6)
  })

  it('NPCs wade too, and a shock arcs through everyone standing in the flood', () => {
    const w = shore()
    w.tick = FLOOD_AT
    const a = spawnNpc(w, 'thug', 10.5, 10.5)
    const b = spawnNpc(w, 'thug', 11.5, 10.5)
    const c = spawnNpc(w, 'thug', 12.5, 10.5)
    tickN(w, 1)
    expect([a, b, c].every(isWet)).toBe(true)
    const hp = c.health!.hp
    shock(w, a)
    expect(c.health!.hp).toBeLessThan(hp)
  })

  it('the same trio on dry ground at low tide stops the arc at the first body', () => {
    const w = shore()
    const a = spawnNpc(w, 'thug', 10.5, 10.5)
    const b = spawnNpc(w, 'thug', 11.5, 10.5)
    tickN(w, 1)
    expect(isWet(a) || isWet(b)).toBe(false)
    const hp = b.health!.hp
    shock(w, a)
    expect(b.health!.hp).toBe(hp)
  })

  it('never touches the dead, doors or pickups', () => {
    const w = shore()
    w.tick = FLOOD_AT
    const p = spawnPlayer(w, 0, 5.5, 10.5)
    p.dead = true
    const n = spawnNpc(w, 'thug', 6.5, 12.5)
    kill(w, n)
    tickN(w, 1)
    expect(isWet(p)).toBe(false)
    for (const e of w.entities) if (!e.health) expect(e.fx?.wet).toBeUndefined()
  })

  it('an empty floor floods without incident', () => {
    const w = shore()
    w.tick = FLOOD_AT
    expect(() => tickN(w, TIDE_PERIOD)).not.toThrow()
  })
})

// ── brownout ───────────────────────────────────────────────────────────────

describe('brownout', () => {
  const stage = (kind?: FloorModifierKind): { w: World; guard: Entity; p: Entity } => {
    const w = arena()
    if (kind) w.modifier = mod(kind)
    const guard = spawnNpc(w, 'thug', 10.5, 10.5)
    const p = spawnPlayer(w, 0, 10.5, 10.5)
    return { w, guard, p }
  }

  it('cuts every NPC sight range to BROWNOUT_SIGHT of normal', () => {
    const { w, guard, p } = stage('brownout')
    const sight = guard.ai!.sightRange
    p.pos.x = guard.pos.x + sight * BROWNOUT_SIGHT - 0.05
    expect(perceives(w, guard, p)).toBe(true)
    p.pos.x = guard.pos.x + sight * BROWNOUT_SIGHT + 0.05
    expect(perceives(w, guard, p)).toBe(false)
    w.modifier = undefined
    expect(perceives(w, guard, p)).toBe(true)
  })

  it('stacks with a cloak rather than replacing it', () => {
    const { w, guard, p } = stage('brownout')
    p.status!.cloakUntil = w.tick + 999
    p.pos.x = guard.pos.x + guard.ai!.sightRange * BROWNOUT_SIGHT * 0.5 + 0.05
    expect(perceives(w, guard, p)).toBe(false)
  })

  it('in the real sim, a player at 80% sight range is noticed in the light and missed in the dark', () => {
    const run = (kind?: FloorModifierKind): Entity => {
      const { w, guard, p } = stage(kind)
      p.pos.x = guard.pos.x + guard.ai!.sightRange * 0.8
      p.prevPos.x = p.pos.x
      tickN(w, 60, new Map([[0, cmd()]]))
      return guard
    }
    expect(run()?.ai?.targetId).toBeDefined()
    expect(run('brownout')?.ai?.targetId).toBeUndefined()
  })

  it('leaves the other modifiers’ sight alone', () => {
    for (const k of ['bogTide', 'hunted'] as const) {
      const { w, guard, p } = stage(k)
      p.pos.x = guard.pos.x + guard.ai!.sightRange - 0.05
      expect(perceives(w, guard, p)).toBe(true)
    }
  })
})

// ── hunted ─────────────────────────────────────────────────────────────────

describe('hunted', () => {
  const trackers = (w: World) => (w.groups?.list ?? []).filter((g) => g.tracker)

  const huntFloor = (): World => direct(...SEEDS.hunted)

  it('nothing comes early; at HUNT_FIRST a tracker pack lands out of reach, already on the scent', () => {
    const w = huntFloor()
    const log: SimEvent[] = []
    tickN(w, HUNT_FIRST, new Map([[0, cmd()]]), log)
    expect(log.some((e) => e.type === 'huntersArrive')).toBe(false)
    expect(trackers(w)).toHaveLength(0)
    tickN(w, 1, new Map([[0, cmd()]]), log)
    const ev = log.find((e) => e.type === 'huntersArrive') as Extract<SimEvent, { type: 'huntersArrive' }>
    expect(ev).toBeDefined()
    const [g] = trackers(w)
    expect(g.id).toBe(ev.groupId)
    expect(g.targetId).toBe(player(w).id)
    expect(membersOf(w, g.id)).toHaveLength(packSize(w.floor))
    const d = Math.hypot(ev.x - player(w).pos.x, ev.y - player(w).pos.y)
    expect(d).toBeLessThanOrEqual(HUNT_BAND[1])
    expect(d).toBeGreaterThan(4)
    expect(w.modifier!.packId).toBe(g.id)
    expect(w.modifier!.huntAt).toBeUndefined()
  })

  /** A sealed, empty stage: nothing else on the floor to fight the pack, so
   * what the hounds do is the tracker behaviour alone. */
  const huntArena = (): { w: World; p: Entity } => {
    const w = arena(2, 2, 60, 40)
    w.modifier = mod('hunted')
    const p = spawnPlayer(w, 0, 5.5, 20.5)
    p.health!.max = p.health!.hp = 1e6 // survive the mauling; we are measuring the chase
    return { w, p }
  }
  const nearest = (w: World, id: number, p: Entity): number =>
    Math.min(...membersOf(w, id).map((m) => Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y)))

  it('the pack runs down a player who stands still', () => {
    const { w, p } = huntArena()
    tickN(w, HUNT_FIRST + 1, new Map([[0, cmd()]]))
    const [g] = trackers(w)
    const far = nearest(w, g.id, p)
    tickN(w, 15 * SIM_RATE, new Map([[0, cmd()]]))
    expect(far).toBeGreaterThan(10)
    expect(nearest(w, g.id, p)).toBeLessThan(2)
  })

  it('keeps tracking a player it cannot see (scent, not vision)', () => {
    const { w, p } = huntArena()
    tickN(w, HUNT_FIRST + 1, new Map([[0, cmd()]]))
    const [g] = trackers(w)
    for (const m of membersOf(w, g.id)) m.ai!.sightRange = 0.01 // blind hounds
    tickN(w, 15 * SIM_RATE, new Map([[0, cmd()]]))
    expect(nearest(w, g.id, p)).toBeLessThan(2.5)
    expect(groupById(w, g.id)?.phase).toBe('prowl') // never saw them, still came
  })

  it('an ordinary (non-tracker) pack given the same start stays home', () => {
    const { w, p } = huntArena()
    tickN(w, HUNT_FIRST + 1, new Map([[0, cmd()]]))
    const [g] = trackers(w)
    delete g.tracker
    for (const m of membersOf(w, g.id)) m.ai!.sightRange = 0.01
    const far = nearest(w, g.id, p)
    tickN(w, 15 * SIM_RATE, new Map([[0, cmd()]]))
    expect(nearest(w, g.id, p)).toBeGreaterThan(far - 4)
  })

  it('moving buys time: a player who runs is caught much later than one who waits', () => {
    /** Ticks after arrival until a hound is within bite range, running or not. */
    const caughtAfter = (run: boolean): number => {
      const { w, p } = huntArena()
      tickN(w, HUNT_FIRST + 1, new Map([[0, cmd()]]))
      const [g] = trackers(w)
      for (let t = 1; t <= 40 * SIM_RATE; t++) {
        const c = membersOf(w, g.id)
        const cx = c.reduce((s, m) => s + m.pos.x, 0) / c.length
        const cy = c.reduce((s, m) => s + m.pos.y, 0) / c.length
        const dx = p.pos.x - cx
        const dy = p.pos.y - cy
        const len = Math.hypot(dx, dy) || 1
        // Flee straight away; near a wall, slide along it instead.
        const nearWall = p.pos.x < 4 || p.pos.x > 59 || p.pos.y < 4 || p.pos.y > 39
        const move = run ? (nearWall ? { moveX: -dy / len, moveY: dx / len } : { moveX: dx / len, moveY: dy / len }) : {}
        tickN(w, 1, new Map([[0, cmd(move)]]))
        if (nearest(w, g.id, p) < 1.5) return t
      }
      return Infinity
    }
    const waited = caughtAfter(false)
    const ran = caughtAfter(true)
    expect(waited).toBeLessThan(15 * SIM_RATE)
    expect(ran).toBeGreaterThan(waited * 2) // measured: 133 vs 307 ticks
  })

  it('wipe the pack and the next one comes HUNT_GAP later, not before', () => {
    const { w } = huntArena()
    tickN(w, HUNT_FIRST + 1, new Map([[0, cmd()]]))
    const [g] = trackers(w)
    for (const m of membersOf(w, g.id)) kill(w, m)
    tickN(w, 1, new Map([[0, cmd()]])) // the group disbands; the modifier notices
    expect(w.modifier!.huntAt).toBe(w.tick - 1 + HUNT_GAP)
    const due = w.modifier!.huntAt!
    const log: SimEvent[] = []
    tickN(w, due - w.tick, new Map([[0, cmd()]]), log)
    expect(log.some((e) => e.type === 'huntersArrive')).toBe(false)
    tickN(w, 1, new Map([[0, cmd()]]), log)
    expect(log.filter((e) => e.type === 'huntersArrive')).toHaveLength(1)
    expect(w.modifier!.hunts).toBe(2)
  })

  it('never fields two tracker packs at once', () => {
    const { w } = huntArena()
    let most = 0
    for (let t = 0; t < HUNT_FIRST + HUNT_GAP * 3; t++) {
      tickN(w, 1, new Map([[0, cmd()]]))
      most = Math.max(most, trackers(w).length)
    }
    expect(most).toBe(1)
  })

  it('co-op: a downed prey hands the pack to the teammate still standing', () => {
    const w = huntFloor()
    const a = player(w)
    const b = spawnPlayer(w, 1, a.pos.x + 1, a.pos.y)
    tickN(w, HUNT_FIRST + 1)
    const [g] = trackers(w)
    const prey = w.byId.get(g.targetId!)!
    const other = prey === a ? b : a
    prey.playerCtl!.downed = { bleedTicks: 99999, reviveProgress: 0 }
    tickN(w, 2)
    expect(groupById(w, g.id)!.targetId).toBe(other.id)
  })

  it('with nobody left standing, the hunt waits and retries instead of landing on a corpse', () => {
    const w = huntFloor()
    player(w).dead = true
    const due = w.modifier!.huntAt!
    w.tick = due
    modifierSystem(w)
    expect(trackers(w)).toHaveLength(0)
    expect(w.modifier!.huntAt).toBe(due + HUNT_RETRY)
    expect(w.modifier!.hunts).toBe(0)
  })

  it('an empty floor (no players, no entities) never throws or spawns', () => {
    const w = createWorld(4, 2)
    w.modifier = mod('hunted')
    w.tick = HUNT_FIRST
    expect(() => tickN(w, HUNT_RETRY * 3)).not.toThrow()
    expect(w.entities).toHaveLength(0)
  })

  it('a mid-floor late joiner changes nothing about the schedule', () => {
    const a = huntFloor()
    const b = huntFloor()
    tickN(a, 10 * SIM_RATE)
    tickN(b, 10 * SIM_RATE)
    spawnPlayer(b, 1, player(b).pos.x + 1, player(b).pos.y)
    expect(b.modifier).toEqual(a.modifier)
    tickN(a, HUNT_FIRST)
    tickN(b, HUNT_FIRST)
    expect(trackers(a)).toHaveLength(1)
    expect(trackers(b)).toHaveLength(1)
  })

  it('applyFloorModifier is idempotent and draws nothing from the sim stream', () => {
    const w = huntFloor()
    const rng = w.rng.state()
    const before = JSON.stringify(serializeWorld(w))
    applyFloorModifier(w)
    w.events.length = 0
    const again = serializeWorld(w)
    expect(w.rng.state()).toBe(rng)
    expect(JSON.stringify({ ...again, events: [] })).toBe(JSON.stringify({ ...JSON.parse(before), events: [] }))
  })
})

// ── the view the HUD reads ─────────────────────────────────────────────────

describe('modifierView', () => {
  it('reports the tide and the hunt countdown from the host tick', () => {
    expect(modifierView(undefined, 0)).toBeUndefined()
    expect(modifierView(mod('bogTide'), 0)).toEqual({ kind: 'bogTide', flooded: false })
    expect(modifierView(mod('bogTide'), TIDE_PERIOD - 1)).toEqual({ kind: 'bogTide', flooded: true })
    expect(modifierView(mod('brownout'), 0)).toEqual({ kind: 'brownout' })
    expect(modifierView(mod('hunted'), 0)).toEqual({ kind: 'hunted', huntIn: HUNT_FIRST / SIM_RATE })
    expect(modifierView(mod('hunted'), HUNT_FIRST - 1)).toEqual({ kind: 'hunted', huntIn: 1 })
    expect(modifierView({ kind: 'hunted', since: 0, packId: 3 }, 50)).toEqual({ kind: 'hunted' })
  })
})
