import { describe, expect, it } from 'vitest'
import { ELEMENTS } from '../../game/data/elements'
import { decodeSnapshot, encodeSnapshot, WIRE_STATUSES, type WireEntity, type WireSnapshot } from './messages'

const npc = (id: number, statuses?: string[]): WireEntity => ({
  id,
  archetype: 'thug',
  x: 10 + id,
  y: 12,
  facing: 0,
  hpPct: 1,
  flags: 0,
  ...(statuses ? { statuses } : {}),
})

const snap = (entities: WireEntity[]): WireSnapshot => ({ tick: 900, floor: 2, alarm: 0, lastInputSeq: 7, entities })

describe('snapshot status trailer', () => {
  it('registers every element in data/elements.ts within one byte', () => {
    for (const k of Object.keys(ELEMENTS)) expect(WIRE_STATUSES, k).toContain(k)
    expect(WIRE_STATUSES.length).toBeLessThanOrEqual(8)
  })

  it('costs nothing when no entity is statused', () => {
    const quiet = snap(Array.from({ length: 48 }, (_, i) => npc(i + 1)))
    const bytes = encodeSnapshot(quiet)
    expect(bytes.length).toBe(10 + 48 * 10)
    expect(decodeSnapshot(bytes).entities.every((e) => e.statuses === undefined)).toBe(true)
  })

  it('costs 1 + 2 bytes per statused entity on a typical floor (10 statused of 48)', () => {
    const plain = Array.from({ length: 48 }, (_, i) => npc(i + 1))
    const statused = plain.map((e, i) => (i % 5 === 0 && i < 50 ? { ...e, statuses: ['frozen', 'burning'] } : e))
    const n = statused.filter((e) => e.statuses).length
    expect(n).toBe(10)
    const added = encodeSnapshot(snap(statused)).length - encodeSnapshot(snap(plain)).length
    expect(added).toBe(1 + 2 * n)
  })

  it('round-trips every status on the right entity, other records untouched', () => {
    const entities = [npc(1), npc(2, [...WIRE_STATUSES]), npc(3), npc(4, ['wet']), npc(5, ['spore', 'electrified'])]
    const d = decodeSnapshot(encodeSnapshot(snap(entities)))
    expect(d.entities.map((e) => e.statuses?.slice().sort())).toEqual([
      undefined,
      [...WIRE_STATUSES].sort(),
      undefined,
      ['wet'],
      ['electrified', 'spore'],
    ])
    expect(d.entities.map((e) => e.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('survives projectile mod tails ahead of it in the record stream', () => {
    const shot: WireEntity = { ...npc(9), archetype: 'projectile', mods: [{ id: 'frost', stacks: 2 }] }
    const d = decodeSnapshot(encodeSnapshot(snap([shot, npc(10, ['frozen'])])))
    expect(d.entities[0].mods).toEqual([{ id: 'frost', stacks: 2 }])
    expect(d.entities[1].statuses).toEqual(['frozen'])
  })

  it('drops unknown status keys instead of mis-mapping them', () => {
    const bytes = encodeSnapshot(snap([npc(1, ['chilly', 'stun'])]))
    expect(bytes.length).toBe(10 + 10)
    expect(decodeSnapshot(bytes).entities[0].statuses).toBeUndefined()
  })

  it('is deterministic: same snapshot, same bytes', () => {
    const s = snap([npc(1, ['burning', 'frozen']), npc(2, ['wet'])])
    expect(encodeSnapshot(s)).toEqual(encodeSnapshot(structuredClone(s)))
  })

  it('ignores a trailer that points past the entity list or is truncated', () => {
    const good = encodeSnapshot(snap([npc(1, ['frozen'])]))
    const outOfRange = good.slice()
    outOfRange[good.length - 2] = 200
    expect(decodeSnapshot(outOfRange).entities[0].statuses).toBeUndefined()
    const truncated = good.slice(0, good.length - 1)
    expect(() => decodeSnapshot(truncated)).not.toThrow()
    expect(decodeSnapshot(truncated).entities).toHaveLength(1)
    const overCount = good.slice()
    overCount[good.length - 3] = 255
    expect(decodeSnapshot(overCount).entities[0].statuses).toEqual(['frozen'])
  })
})
