// Snapshot-codec coverage for bullet mod provenance: the variable per-projectile
// tail (u8 count + one packed byte per mod) must round-trip exactly, cost other
// archetypes nothing, stay in registry sync with data/mods.ts, and survive
// adversarial inputs (unknown ids, huge stacks, over-cap lists, garbage bytes).

import { describe, expect, it } from 'vitest'
import { MODS } from '../../game/data/mods'
import { makeEntity } from '../../game/entity'
import {
  applyWireEntity,
  decodeSnapshot,
  encodeSnapshot,
  toWireEntity,
  WIRE_MODS,
  type WireEntity,
  type WireSnapshot,
} from './messages'

const wire = (over: Partial<WireEntity> = {}): WireEntity => ({
  id: 7,
  archetype: 'projectile',
  x: 3,
  y: 4,
  facing: 0,
  hpPct: 1,
  flags: 0,
  ...over,
})

const snap = (entities: WireEntity[]): WireSnapshot => ({ tick: 10, floor: 1, alarm: 0, lastInputSeq: 0, entities })

const roundTrip = (entities: WireEntity[]): WireSnapshot => decodeSnapshot(encodeSnapshot(snap(entities)))

describe('WIRE_MODS registry', () => {
  it('covers every mod in the MODS registry (new mods must be APPENDED here)', () => {
    for (const id of Object.keys(MODS)) {
      expect(WIRE_MODS.includes(id as (typeof WIRE_MODS)[number]), `mod '${id}' missing from WIRE_MODS`).toBe(true)
    }
  })

  it('has no duplicates and fits the 5-bit index space', () => {
    expect(new Set(WIRE_MODS).size).toBe(WIRE_MODS.length)
    expect(WIRE_MODS.length).toBeLessThanOrEqual(32)
  })
})

describe('snapshot codec — projectile mod tail', () => {
  it('round-trips a modded bullet exactly', () => {
    const mods = [
      { id: 'frost', stacks: 1 },
      { id: 'overload', stacks: 3 },
      { id: 'pierce', stacks: 5 },
    ]
    const [e] = roundTrip([wire({ mods })]).entities
    expect(e.mods).toEqual(mods)
  })

  it('a vanilla bullet round-trips with NO mods field', () => {
    const [e] = roundTrip([wire()]).entities
    expect(e.mods).toBeUndefined()
  })

  it('every registry mod survives the packed byte at stacks 1 and 5', () => {
    for (const id of WIRE_MODS) {
      for (const stacks of [1, 5]) {
        const [e] = roundTrip([wire({ mods: [{ id, stacks }] })]).entities
        expect(e.mods).toEqual([{ id, stacks }])
      }
    }
  })

  it('stacks clamp into the 3-bit field: 0/negative dropped, >8 → 8', () => {
    const [e] = roundTrip([
      wire({ mods: [{ id: 'overload', stacks: 99 }, { id: 'pierce', stacks: 0 }, { id: 'frost', stacks: -3 }] }),
    ]).entities
    expect(e.mods).toEqual([{ id: 'overload', stacks: 8 }])
  })

  it('unknown mod ids are skipped on encode (a hostile/future peer cannot desync us)', () => {
    const [e] = roundTrip([wire({ mods: [{ id: 'warpdrive', stacks: 2 }, { id: 'bounce', stacks: 1 }] })]).entities
    expect(e.mods).toEqual([{ id: 'bounce', stacks: 1 }])
  })

  it('an over-cap mod list truncates instead of corrupting the record stream', () => {
    const mods = WIRE_MODS.map((id) => ({ id, stacks: 1 }))
    const decoded = roundTrip([wire({ mods }), wire({ id: 8, x: 9 })])
    // First record truncated to the cap; the FOLLOWING record still parses clean.
    expect(decoded.entities[0].mods!.length).toBe(12)
    expect(decoded.entities[1].id).toBe(8)
    expect(decoded.entities[1].x).toBeCloseTo(9, 1)
  })

  it('mixed archetypes: only projectiles pay the tail, neighbors decode exactly', () => {
    const decoded = roundTrip([
      wire({ id: 1, archetype: 'player', x: 1.5, y: 2.5 }),
      wire({ id: 2, mods: [{ id: 'homing', stacks: 2 }] }),
      wire({ id: 3, archetype: 'thug', x: 6, y: 7 }),
      wire({ id: 4, archetype: 'grenade', x: 2, y: 2 }),
    ])
    expect(decoded.entities.map((e) => e.archetype)).toEqual(['player', 'projectile', 'thug', 'grenade'])
    expect(decoded.entities[1].mods).toEqual([{ id: 'homing', stacks: 2 }])
    expect(decoded.entities[0].mods).toBeUndefined()
    expect(decoded.entities[2].x).toBeCloseTo(6, 1)
  })
})

describe('host → wire → client entity bridge', () => {
  it('toWireEntity lifts projectile.mods off the sim entity', () => {
    const e = makeEntity('projectile', 'projectile', 1, 1)
    e.projectile = { ownerId: 3, damage: 14, ttl: 20, mods: [{ id: 'shock', stacks: 1 }] }
    const we = toWireEntity(e, 0)
    expect(we.mods).toEqual([{ id: 'shock', stacks: 1 }])
    // A copy, not a live alias into the sim.
    expect(we.mods).not.toBe(e.projectile.mods)
  })

  it('applyWireEntity materializes render-side provenance on the client mirror', () => {
    const we = wire({ mods: [{ id: 'glassCannon', stacks: 2 }] })
    const e = applyWireEntity(undefined, we, 5)
    expect(e.kind).toBe('projectile')
    expect(e.projectile?.mods).toEqual([{ id: 'glassCannon', stacks: 2 }])
  })

  it('a vanilla wire bullet leaves the client mirror unmodded', () => {
    const e = applyWireEntity(undefined, wire(), 5)
    expect(e.projectile?.mods).toBeUndefined()
  })
})
