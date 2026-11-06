// The snapshot's sparse AIM trailer: which records hold a ranged weapon ready
// (game/aiming.ts), so a co-op client plays the aim loops it cannot derive.

import { describe, expect, it } from 'vitest'
import { decodeSnapshot, encodeSnapshot, type WireEntity, type WireSnapshot } from './messages'

const npc = (id: number, extra: Partial<WireEntity> = {}): WireEntity => ({
  id,
  archetype: 'drowner',
  x: 10 + id,
  y: 12,
  facing: 0,
  hpPct: 1,
  flags: 0,
  ...extra,
})
const snap = (entities: WireEntity[]): WireSnapshot => ({ tick: 900, floor: 2, alarm: 0, epoch: 0, lastInputSeq: 7, entities })
const aimers = (s: WireSnapshot): number[] => s.entities.filter((e) => e.aiming).map((e) => e.id)

describe('snapshot aim trailer', () => {
  it('costs nothing when nobody aims: the bytes are the pre-trailer format', () => {
    const quiet = snap(Array.from({ length: 48 }, (_, i) => npc(i + 1)))
    expect(encodeSnapshot(quiet).length).toBe(11 + 48 * 10)
    expect(aimers(decodeSnapshot(encodeSnapshot(quiet)))).toEqual([])
  })

  it('alone it costs the two empty counts before it, its own count, and a byte per aimer', () => {
    const plain = Array.from({ length: 48 }, (_, i) => npc(i + 1))
    const some = plain.map((e, i) => (i % 6 === 0 ? { ...e, aiming: true as const } : e))
    const added = encodeSnapshot(snap(some)).length - encodeSnapshot(snap(plain)).length
    expect(added).toBe(1 + 1 + 1 + 8)
    expect(aimers(decodeSnapshot(encodeSnapshot(snap(some))))).toEqual([1, 7, 13, 19, 25, 31, 37, 43])
  })

  it('round-trips beside the status and activity trailers, every combination, on the right records', () => {
    const cases: Partial<WireEntity>[][] = [
      [{ statuses: ['frozen'] }, { aiming: true }],
      [{ activity: { kind: 'cards', playing: true } }, { aiming: true }],
      [{ statuses: ['wet'], aiming: true }, { activity: { kind: 'cards', playing: false } }, { aiming: true }],
      [{ statuses: ['burning'] }, { activity: { kind: 'cards', playing: true } }],
    ]
    for (const c of cases) {
      const s = snap(c.map((x, i) => npc(i + 1, x)))
      const back = decodeSnapshot(encodeSnapshot(s))
      expect(back.entities.map((e) => ({ s: e.statuses, a: e.activity, aim: e.aiming }))).toEqual(
        s.entities.map((e) => ({ s: e.statuses, a: e.activity, aim: e.aiming })),
      )
    }
  })

  it('ADVERSARIAL: a truncated aim trailer marks no record beyond what it carries, and never throws', () => {
    const s = snap([npc(1, { aiming: true }), npc(2, { aiming: true }), npc(3)])
    const bytes = encodeSnapshot(s)
    const cut = bytes.slice(0, bytes.length - 1)
    expect(() => decodeSnapshot(cut)).not.toThrow()
    expect(aimers(decodeSnapshot(cut))).toEqual([1])
  })
})
