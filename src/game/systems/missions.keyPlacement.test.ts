// A sealed gate's soft key (keycard, generator, feeder Spore Node) must be
// reachable from the spawn WITHOUT passing through any sealed gate. Station
// modules often have a single door, so a key dropped "somewhere in the
// building" landed behind the very gate it opens, and the floor could only be
// won by breaching.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { isSolidTile, type Building } from '../levelgen/level'
import { levelFromJson } from '../levelgen/levelText'
import { createWorld, worldFromState, type World } from '../world'
import { setupFloor } from './missions'

const isSealed = (d: Entity): boolean =>
  !!d.door &&
  !d.door.open &&
  (d.door.overgrown === true || (d.door.locked && (d.door.sealKind === 'keycard' || d.door.sealKind === 'power')))

/** Tiles walkable from the spawn with every sealed gate shut. Plain locks are
 * pickable, so they pass; stairs are followed. Written independently of the
 * placement code on purpose: it is the oracle. */
const reachFromSpawn = (w: World): Set<number> => {
  const W = w.level.w
  const shut = new Set(w.entities.filter(isSealed).map((d) => Math.floor(d.pos.y) * W + Math.floor(d.pos.x)))
  const stair = new Map((w.level.stairs ?? []).map((l) => [l.from.y * W + l.from.x, l.landing.y * W + l.landing.x]))
  const start = Math.floor(w.level.spawn.y) * W + Math.floor(w.level.spawn.x)
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const k = queue.pop()!
    const x = k % W
    const y = (k - x) / W
    const steps: [number, number][] = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]
    const hop = stair.get(k)
    if (hop !== undefined) steps.push([hop % W, Math.floor(hop / W)])
    for (const [nx, ny] of steps) {
      const n = ny * W + nx
      if (seen.has(n) || isSolidTile(w.level, nx, ny) || shut.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return seen
}

const gateOf = (w: World): Entity | undefined => w.entities.find(isSealed)

const keyOf = (w: World, gate: Entity): Entity | undefined => {
  const d = gate.door!
  if (d.overgrown) return d.nodeId === undefined ? undefined : w.byId.get(d.nodeId)
  if (d.sealKind === 'keycard') return w.entities.find((e) => e.pickup?.itemId === d.keyId)
  return w.entities.find((e) => e.archetype === 'generator' && e.wing === d.wing)
}

const tileOf = (w: World, e: Entity): number => Math.floor(e.pos.y) * w.level.w + Math.floor(e.pos.x)

const schemeOf = (gate: Entity): string => (gate.door!.overgrown ? 'overgrown' : gate.door!.sealKind!)

// A lobby the player starts in, and below it the objective module, whose ONLY
// door is the gate at (4,4). Every tile of the module is behind the gate.
const SINGLE_DOOR_ROWS = [
  '##########',
  '#........#',
  '#.@......#',
  '#........#',
  '####.#####',
  '#........#',
  '#........#',
  '##########',
]
const SINGLE_DOOR_BUILDINGS: Building[] = [
  { rect: { x: 0, y: 0, w: 10, h: 5 }, rooms: [{ x: 1, y: 1, w: 8, h: 3 }], doors: [{ x: 4, y: 4 }], role: 'quarters' },
  {
    rect: { x: 0, y: 4, w: 10, h: 4 },
    rooms: [{ x: 1, y: 5, w: 8, h: 2 }],
    doors: [{ x: 4, y: 4 }],
    role: 'lab',
    objectiveRoom: { x: 1, y: 5, w: 8, h: 2 },
  },
]

const authored = (rows: string[], buildings: Building[], seed: number, floor: number): World => {
  const w = worldFromState({ level: levelFromJson({ rows, buildings }), seed, floor })
  setupFloor(w)
  return w
}

describe('a sealed gate never hides its own key', () => {
  it('puts the key outside a single-door objective module, for every scheme', () => {
    const schemes = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [3, 5]) {
        const w = authored(SINGLE_DOOR_ROWS, SINGLE_DOOR_BUILDINGS, seed, floor)
        const ctx = `seed ${seed} floor ${floor} ${w.mission.template}`
        expect(w.mission.targetBuilding, ctx).toBe(1)
        const gate = gateOf(w)!
        expect(gate, `${ctx}: the gate is sealed`).toBeDefined()
        expect([Math.floor(gate.pos.x), Math.floor(gate.pos.y)], ctx).toEqual([4, 4])
        schemes.add(schemeOf(gate))
        const key = keyOf(w, gate)
        expect(key, `${ctx}: ${schemeOf(gate)} key placed`).toBeDefined()
        expect(Math.floor(key!.pos.y), `${ctx}: ${schemeOf(gate)} key is in the lobby, above the gate`).toBeLessThan(4)
        expect(reachFromSpawn(w).has(tileOf(w, key!)), ctx).toBe(true)
        const target = w.byId.get(w.mission.targetEntityId!)!
        expect(reachFromSpawn(w).has(tileOf(w, target)), `${ctx}: the objective really is behind the gate`).toBe(false)
      }
    }
    expect([...schemes].sort()).toEqual(['keycard', 'overgrown', 'power'])
  })

  it('never puts the key on the spawn tile or on a doorway', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = authored(SINGLE_DOOR_ROWS, SINGLE_DOOR_BUILDINGS, seed, 3)
      const key = keyOf(w, gateOf(w)!)!
      expect([Math.floor(key.pos.x), Math.floor(key.pos.y)], `seed ${seed}`).not.toEqual([2, 2])
      expect(
        w.entities.some((d) => d.door && tileOf(w, d) === tileOf(w, key)),
        `seed ${seed}: key on a door tile`,
      ).toBe(false)
    }
  })

  it('places no key at all when nothing outside the gate is free, rather than one behind it', () => {
    // The spawn tile is the only floor tile on the near side of the gate.
    const rows = ['#######', '##@####', '##.####', '#.....#', '#.....#', '#######']
    const buildings: Building[] = [
      { rect: { x: 1, y: 0, w: 3, h: 3 }, rooms: [{ x: 2, y: 1, w: 1, h: 1 }], doors: [{ x: 2, y: 2 }], role: 'quarters' },
      {
        rect: { x: 0, y: 2, w: 7, h: 4 },
        rooms: [{ x: 1, y: 3, w: 5, h: 2 }],
        doors: [{ x: 2, y: 2 }],
        role: 'lab',
        objectiveRoom: { x: 1, y: 3, w: 5, h: 2 },
      },
    ]
    for (let seed = 1; seed <= 20; seed++) {
      const w = authored(rows, buildings, seed, 3)
      const gate = gateOf(w)!
      expect(gate, `seed ${seed}`).toBeDefined()
      expect(keyOf(w, gate), `seed ${seed}: no room for a ${schemeOf(gate)} key`).toBeUndefined()
    }
  })

  it('is deterministic: the same seed places the same key on the same tile', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const a = authored(SINGLE_DOOR_ROWS, SINGLE_DOOR_BUILDINGS, seed, 3)
      const b = authored(SINGLE_DOOR_ROWS, SINGLE_DOOR_BUILDINGS, seed, 3)
      expect(tileOf(a, keyOf(a, gateOf(a)!)!)).toBe(tileOf(b, keyOf(b, gateOf(b)!)!))
    }
  })
})

describe('generated floors 3-8 over 200 seeds', () => {
  it('every sealed gate has its key, reachable with every sealed gate shut', { timeout: 300_000 }, () => {
    let gated = 0
    let objectivesBehindGate = 0
    const schemes = new Set<string>()
    const failures: string[] = []
    for (let seed = 1; seed <= 200; seed++) {
      for (let floor = 3; floor <= 8; floor++) {
        const w = createWorld(seed, floor)
        setupFloor(w)
        const gate = gateOf(w)
        if (!gate) continue
        gated++
        schemes.add(schemeOf(gate))
        const reach = reachFromSpawn(w)
        const key = keyOf(w, gate)
        if (!key) failures.push(`seed ${seed} floor ${floor}: no ${schemeOf(gate)} key`)
        else if (!reach.has(tileOf(w, key))) failures.push(`seed ${seed} floor ${floor}: ${schemeOf(gate)} key behind a seal`)
        const target = w.mission.targetEntityId === undefined ? undefined : w.byId.get(w.mission.targetEntityId)
        if (target && !reach.has(tileOf(w, target))) objectivesBehindGate++
      }
    }
    expect(failures.slice(0, 10), `${failures.length} of ${gated} gated floors`).toEqual([])
    expect(gated).toBe(1200)
    expect([...schemes].sort()).toEqual(['keycard', 'overgrown', 'power'])
    // Non-vacuous: on most floors the objective really does sit behind the gate.
    expect(objectivesBehindGate).toBeGreaterThan(600)
  })
})
