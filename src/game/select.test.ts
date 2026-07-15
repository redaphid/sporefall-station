import { describe, expect, it } from 'vitest'
import { spawnNpc } from './populate'
import { spawnPlayer } from './player'
import { deserializeWorld, serializeWorld } from './serialize'
import { clearSelection, pickNearestEntity, selectedEntities, setSelected, toggleSelected } from './select'
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
    const p = spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
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
