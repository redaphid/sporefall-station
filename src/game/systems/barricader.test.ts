// Barricader ('barricader' behavior + `fortify`) — adversarial TDD. Exact
// world state (hand-built buildings + carved geometry, or full populate), the
// REAL systems via tickWorld, assertions on the hard safety rules: barricades
// stand beside doorways never ON them, respect the bunker's promised-open
// patrol lane, cap per building, never touch `level.solid` (reachability is
// structurally untouched), stay destroyable, and the whole thing is
// deterministic per seed.

import { describe, expect, it } from 'vitest'
import { generateLevel } from '../levelgen/generate'
import { bunkerLaneKeys, Tile, type Building } from '../levelgen/level'
import { populateWorld, spawnNpc } from '../populate'
import { serializeWorld } from '../serialize'
import { emptyInput, type SimEvent } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { BARRICADE_CAP, barricadeSpotFor } from './behaviors'
import { applyDamage } from './combat'
import { setupFloor } from './missions'

const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
}

const wall = (w: World, x: number, y: number): void => {
  w.level.tiles[y * w.level.w + x] = Tile.Wall
  w.level.solid[y * w.level.w + x] = 1
}

const run = (w: World, n: number): SimEvent[] => {
  const seen: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, { ...emptyInput() }]]))
    seen.push(...w.events)
  }
  return seen
}

const barricades = (w: World) => w.entities.filter((e) => e.archetype === 'barricade' && !e.dead)

/**
 * A hand-built 9×7 one-room building at (10,10) with doorways cut in its wall.
 * The Building record is pushed into the level so zone lookups work.
 */
const buildingWorld = (doorSpots: { x: number; y: number }[]): { w: World; b: Building } => {
  const w = createWorld(7, 1, 'normal', false)
  w.level.tiles.fill(Tile.Wall)
  w.level.solid.fill(1)
  carve(w, 4, 4, 36, 30) // surrounding street
  // Building shell 10..18 × 10..16 (walls), interior 11..17 × 11..15.
  for (let x = 10; x <= 18; x++) for (let y = 10; y <= 16; y++) wall(w, x, y)
  carve(w, 11, 11, 17, 15)
  for (const d of doorSpots) carve(w, d.x, d.y, d.x, d.y) // doorway gaps
  const b: Building = {
    rect: { x: 10, y: 10, w: 9, h: 7 },
    rooms: [{ x: 11, y: 11, w: 7, h: 5 }],
    doors: doorSpots,
    role: 'warehouse',
  }
  w.level.buildings.length = 0
  w.level.buildings.push(b)
  return { w, b }
}

const barricaderAt = (w: World, x: number, y: number) => {
  const e = spawnNpc(w, 'thug', x, y)
  e.combat!.weapon = 'bat'
  e.ai!.behavior = 'barricader'
  e.ai!.zone = { building: 0, role: 'warehouse' }
  return e
}

describe('barricadeSpotFor — the site chooser (pure, deterministic)', () => {
  it('picks the tile ADJACENT-INSIDE a doorway, never the door tile itself', () => {
    const { w, b } = buildingWorld([{ x: 10, y: 13 }]) // west wall doorway
    const spot = barricadeSpotFor(w, b)
    expect(spot).toEqual({ x: 11, y: 13 }) // one step INSIDE, beside the frame
  })

  it('skips the bunker patrol lane (the promised-open contract)', () => {
    const { w, b } = buildingWorld([{ x: 10, y: 13 }])
    // A bunker whose band room is the full footprint puts the lane (the
    // band's inner ring) right on the doorway's inside tile (11,13).
    const bunker: Building = { ...b, role: 'bunker', rooms: [{ x: 10, y: 10, w: 9, h: 7 }] }
    expect(bunkerLaneKeys(bunker, w.level.w).has(13 * w.level.w + 11)).toBe(true)
    const spot = barricadeSpotFor(w, bunker)
    // The lane tile is refused; with every other inside-neighbour solid, the
    // door is unpluggable — null, never a lane violation.
    expect(spot).toBeNull()
  })

  it('returns null once every doorway is plugged', () => {
    const { w, b } = buildingWorld([{ x: 10, y: 13 }])
    barricaderAt(w, 13.5, 13.5)
    run(w, 600)
    expect(barricades(w).length).toBeGreaterThanOrEqual(1)
    expect(barricadeSpotFor(w, b)).toBeNull()
  })
})

describe('the barricader at work', () => {
  it('walks to the doorway and stands a barricade up beside it (evented)', () => {
    const { w } = buildingWorld([{ x: 10, y: 13 }])
    const npc = barricaderAt(w, 16.5, 12.5)
    const events = run(w, 600)
    const built = events.filter((ev) => ev.type === 'barricade')
    expect(built.length).toBe(1)
    const bar = barricades(w)[0]
    expect(bar).toBeDefined()
    expect(Math.floor(bar.pos.x)).toBe(11)
    expect(Math.floor(bar.pos.y)).toBe(13)
    // NEVER on the door tile.
    expect(Math.floor(bar.pos.x) === 10 && Math.floor(bar.pos.y) === 13).toBe(false)
    expect(built[0]).toMatchObject({ type: 'barricade', byId: npc.id })
  })

  it('respects the per-building cap with more doorways than the cap allows', () => {
    const { w } = buildingWorld([
      { x: 10, y: 12 },
      { x: 10, y: 14 },
      { x: 18, y: 12 },
      { x: 18, y: 14 },
      { x: 14, y: 10 },
    ])
    barricaderAt(w, 14.5, 13.5)
    run(w, 3000)
    expect(barricades(w).length).toBe(BARRICADE_CAP)
  })

  it('construction NEVER touches level.solid — reachability is structurally intact', () => {
    const { w } = buildingWorld([{ x: 10, y: 13 }])
    barricaderAt(w, 13.5, 13.5)
    const solidBefore = Uint8Array.from(w.level.solid)
    run(w, 600)
    expect(barricades(w).length).toBeGreaterThanOrEqual(1)
    expect(Uint8Array.from(w.level.solid)).toEqual(solidBefore)
    // And every barricade is a soft interactable body, not terrain.
    for (const bar of barricades(w)) {
      expect(bar.kind).toBe('interactable')
      expect(bar.health).toBeDefined()
    }
  })

  it('a barricade is destroyable: enough damage removes it', () => {
    const { w } = buildingWorld([{ x: 10, y: 13 }])
    barricaderAt(w, 13.5, 13.5)
    run(w, 600)
    const bar = barricades(w)[0]
    expect(bar).toBeDefined()
    applyDamage(w, bar, 999, bar.pos.x - 1, bar.pos.y, 0, 0)
    run(w, 2)
    expect(barricades(w)).toHaveLength(0)
  })

  it('degenerate inputs: no zone / doorless building → no fortify, no crash', () => {
    const { w } = buildingWorld([])
    const noDoors = barricaderAt(w, 13.5, 13.5)
    const drifter = spawnNpc(w, 'thug', 24.5, 24.5)
    drifter.ai!.behavior = 'barricader' // no zone at all
    run(w, 400)
    expect(barricades(w)).toHaveLength(0)
    expect(Number.isFinite(noDoors.pos.x)).toBe(true)
    expect(Number.isFinite(drifter.pos.x)).toBe(true)
  })
})

describe('populate wiring', () => {
  const bunkerFloor = (): { seed: number; floor: number } => {
    for (let seed = 1; seed <= 100; seed++) {
      for (let floor = 2; floor <= 4; floor++) {
        if (generateLevel(seed, floor).buildings.some((b) => b.role === 'bunker')) return { seed, floor }
      }
    }
    throw new Error('no bunker in search bound')
  }

  it('some bunker fields a barricader; patrol guards are never conscripted', () => {
    let saw = false
    for (let seed = 1; seed <= 30 && !saw; seed++) {
      for (let floor = 2; floor <= 4 && !saw; floor++) {
        const w = createWorld(seed, floor)
        populateWorld(w)
        for (const e of w.entities) {
          if (e.ai?.behavior === 'barricader') saw = true
          if (e.ai?.behavior === 'patrol') expect(e.ai.squad).toBeUndefined()
        }
      }
    }
    expect(saw).toBe(true)
  })

  it('a real populated bunker floor runs: any barricade built honors every rule', () => {
    const { seed, floor } = bunkerFloor()
    const w = createWorld(seed, floor)
    populateWorld(w)
    setupFloor(w)
    run(w, 1200)
    const lw = w.level.w
    for (const bar of barricades(w)) {
      const tx = Math.floor(bar.pos.x)
      const ty = Math.floor(bar.pos.y)
      for (const b of w.level.buildings) {
        // Never ON any door tile of any building.
        for (const d of b.doors) expect(tx === d.x && ty === d.y).toBe(false)
        // Never on a bunker patrol lane.
        expect(bunkerLaneKeys(b, lw).has(ty * lw + tx)).toBe(false)
      }
    }
    // Cap holds per building.
    for (const b of w.level.buildings) {
      const inB = barricades(w).filter((bar) => {
        const tx = Math.floor(bar.pos.x)
        const ty = Math.floor(bar.pos.y)
        return tx >= b.rect.x && tx < b.rect.x + b.rect.w && ty >= b.rect.y && ty < b.rect.y + b.rect.h
      })
      expect(inB.length).toBeLessThanOrEqual(3)
    }
  })

  it('determinism: two identical bunker floors evolve byte-identically while fortifying', () => {
    const { seed, floor } = bunkerFloor()
    const build = (): World => {
      const w = createWorld(seed, floor)
      populateWorld(w)
      setupFloor(w)
      return w
    }
    const a = build()
    const b = build()
    run(a, 400)
    run(b, 400)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})
