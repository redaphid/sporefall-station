import { describe, expect, it } from 'vitest'
import { spawnNpc } from './populate'
import { spawnPlayer } from './player'
import { deserializeWorld, serializeWorld } from './serialize'
import { clearSelection, MIN_PICK_PX, PICK_RADIUS, pickNearestEntity, pickRadiusAt, selectedEntities, setSelected, toggleSelected } from './select'
import { createWorld, type World } from './world'

const world = (): World => createWorld(4321, 1)

describe('pickNearestEntity — pointer → world → nearest', () => {
  it('picks the closest entity within the radius', () => {
    const w = world()
    const a = spawnNpc(w, 'cop', 10, 10)
    const b = spawnNpc(w, 'thug', 12, 10)
    expect(pickNearestEntity(w.entities, 10.3, 10, 1.2)).toBe(a)
    expect(pickNearestEntity(w.entities, 11.8, 10, 1.2)).toBe(b)
  })

  it('returns undefined when nothing is within the radius (tap on empty space / off-screen)', () => {
    const w = world()
    spawnNpc(w, 'cop', 10, 10)
    expect(pickNearestEntity(w.entities, 40, 40, 1.2)).toBeUndefined()
    // A point just outside the radius misses too.
    expect(pickNearestEntity(w.entities, 12, 10, 1.2)).toBeUndefined()
  })

  it('breaks ties deterministically by smaller id', () => {
    const w = world()
    const a = spawnNpc(w, 'cop', 10, 10)
    const b = spawnNpc(w, 'thug', 10, 10) // exactly coincident
    expect(a.id).toBeLessThan(b.id)
    expect(pickNearestEntity(w.entities, 10, 10, 1.2)).toBe(a)
  })

  it('skips dead entities and honours the filter', () => {
    const w = world()
    const dead = spawnNpc(w, 'cop', 10, 10)
    dead.dead = true
    const live = spawnNpc(w, 'thug', 10.5, 10)
    expect(pickNearestEntity(w.entities, 10, 10, 1.2)).toBe(live)
    // Filter out the only candidate → nothing.
    expect(pickNearestEntity(w.entities, 10.5, 10, 1.2, (e) => e.kind === 'player')).toBeUndefined()
  })

  it('returns undefined for non-finite pointer coords', () => {
    const w = world()
    spawnNpc(w, 'cop', 10, 10)
    expect(pickNearestEntity(w.entities, NaN, 10, 1.2)).toBeUndefined()
    expect(pickNearestEntity(w.entities, 10, Infinity, 1.2)).toBeUndefined()
  })
})

describe('pickRadiusAt — zoom-aware pick radius (px-per-tile in, world tiles out)', () => {
  const TILE = 32 // mirrors render TILE_PX; the helper itself is unit-agnostic

  it('at 1× and above, the sprite-derived PICK_RADIUS wins', () => {
    expect(pickRadiusAt(TILE * 1)).toBe(PICK_RADIUS)
    expect(pickRadiusAt(TILE * 2)).toBe(PICK_RADIUS)
    expect(pickRadiusAt(TILE * 4)).toBe(PICK_RADIUS) // max zoom: still full sprite reach
  })

  it('zoomed far out, the radius grows to preserve MIN_PICK_PX of screen reach', () => {
    const r = pickRadiusAt(TILE * 0.25) // 8 px/tile — below the break-even scale
    expect(r).toBeCloseTo(MIN_PICK_PX / 8)
    expect(r).toBeGreaterThan(PICK_RADIUS)
    // The guaranteed screen reach holds at the far extreme too.
    expect(pickRadiusAt(TILE * 0.125) * TILE * 0.125).toBeCloseTo(MIN_PICK_PX)
  })

  it('the crossover is continuous: just past the break-even scale nothing jumps', () => {
    const breakEven = MIN_PICK_PX / PICK_RADIUS
    expect(pickRadiusAt(breakEven)).toBeCloseTo(PICK_RADIUS)
    expect(pickRadiusAt(breakEven + 0.01)).toBe(PICK_RADIUS)
    expect(pickRadiusAt(breakEven - 0.01)).toBeGreaterThan(PICK_RADIUS)
  })

  it('degenerate scales (0, negative, NaN, Infinity→0 reach) fall back safely', () => {
    expect(pickRadiusAt(0)).toBe(PICK_RADIUS)
    expect(pickRadiusAt(-5)).toBe(PICK_RADIUS)
    expect(pickRadiusAt(NaN)).toBe(PICK_RADIUS)
    expect(pickRadiusAt(Infinity)).toBe(PICK_RADIUS)
  })

  it('picking with the grown radius actually lands a tap that PICK_RADIUS would miss', () => {
    const w = world()
    const cop = spawnNpc(w, 'cop', 10, 10)
    const scale = TILE * 0.25 // zoomed out past the break-even scale
    const missAt = 10 + PICK_RADIUS + 0.05 // just outside the base radius
    expect(pickNearestEntity(w.entities, missAt, 10, PICK_RADIUS)).toBeUndefined()
    expect(pickNearestEntity(w.entities, missAt, 10, pickRadiusAt(scale))).toBe(cop)
  })
})

describe('selection flag (general, multi-select)', () => {
  it('toggles a single entity', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 5, 5)
    expect(toggleSelected(w, e.id)).toBe(true)
    expect(e.selected).toBe(true)
    expect(toggleSelected(w, e.id)).toBe(false)
    expect(e.selected).toBeUndefined() // cleared, not stored as false
  })

  it('toggling a missing id is a clean miss', () => {
    expect(toggleSelected(world(), 9999)).toBeUndefined()
  })

  it('supports MANY selected at once and lists them', () => {
    const w = world()
    const a = spawnNpc(w, 'cop', 1, 1)
    const b = spawnNpc(w, 'thug', 2, 2)
    const c = spawnNpc(w, 'thug', 3, 3)
    setSelected(a, true)
    setSelected(c, true)
    expect(selectedEntities(w.entities).map((e) => e.id).sort()).toEqual([a.id, c.id].sort())
    expect(b.selected).toBeUndefined()
  })

  it('clearSelection wipes every flag and counts them', () => {
    const w = world()
    const a = spawnNpc(w, 'cop', 1, 1)
    const b = spawnNpc(w, 'thug', 2, 2)
    setSelected(a, true)
    setSelected(b, true)
    expect(clearSelection(w.entities)).toBe(2)
    expect(selectedEntities(w.entities)).toEqual([])
  })
})

describe('selection round-trips in world serialization (no dedicated field needed)', () => {
  it('a selected flag survives a full serialize → deserialize', () => {
    const w = world()
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    const e = spawnNpc(w, 'cop', 6, 6)
    setSelected(e, true)
    const restored = deserializeWorld(serializeWorld(w))
    const re = restored.byId.get(e.id)!
    const rp = restored.byId.get(p.id)!
    expect(re.selected).toBe(true)
    expect(rp.selected).toBeUndefined() // unselected entities carry no flag
    expect(selectedEntities(restored.entities).map((x) => x.id)).toEqual([e.id])
  })
})
