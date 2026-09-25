import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../game/entity'
import type { SimEvent } from '../game/types'
import { BEAM_TICKS, BLAST_TICKS, blinkHalfPeriod, createGroupFxTracker } from './groupFxModel'

const body = (id: number, x: number, y: number, ai?: Entity['ai']): Entity => {
  const e = makeEntity('npc', 'drowner', x, y, 0.35)
  e.id = id
  if (ai) e.ai = ai
  return e
}
const raider = (id: number, x: number, y: number, role: 'grunt' | 'medic', healing?: boolean): Entity =>
  body(id, x, y, { group: { id: 1, role }, ...(healing ? { healing: true } : {}) } as Entity['ai'])

const frame = (tick: number, events: SimEvent[] = [], entities: Entity[] = []) => ({ tick, events, entities })

describe('group fx: the sapper charge', () => {
  const plant: SimEvent = { type: 'sapperCharge', entityId: 9, doorId: 5, x: 10.5, y: 4.5, fuse: 48 }

  it('shows the planted charge with a countdown from the event until the fuse runs out', () => {
    const fx = createGroupFxTracker()
    const ui = fx.update(frame(100, [plant]))
    expect(ui.charges).toHaveLength(1)
    expect(ui.charges[0]).toMatchObject({ doorId: 5, x: 10.5, y: 4.5, ticksLeft: 48, label: '1.6' })
    expect(fx.update(frame(130)).charges[0].label).toBe('0.6')
    expect(fx.update(frame(147)).charges).toHaveLength(1)
    expect(fx.update(frame(148)).charges).toHaveLength(0)
  })

  it('blinks, and blinks faster as the fuse burns down', () => {
    expect(blinkHalfPeriod(48, 48)).toBeGreaterThan(blinkHalfPeriod(10, 48))
    expect(blinkHalfPeriod(1, 48)).toBe(1)
    const fx = createGroupFxTracker()
    fx.update(frame(0, [plant]))
    const lit = new Set<boolean>()
    for (let t = 1; t < 48; t++) lit.add(fx.update(frame(t)).charges[0].lit)
    expect(lit).toEqual(new Set([true, false]))
  })

  it('the breach of the charged door swaps the charge for an expanding shockwave', () => {
    const fx = createGroupFxTracker()
    fx.update(frame(0, [plant]))
    const ui = fx.update(frame(48, [{ type: 'doorBreach', entityId: 5, x: 10.5, y: 4.5 }]))
    expect(ui.charges).toHaveLength(0)
    expect(ui.blasts).toHaveLength(1)
    const later = fx.update(frame(48 + BLAST_TICKS - 1))
    expect(later.blasts[0].radius).toBeGreaterThan(ui.blasts[0].radius)
    expect(later.blasts[0].alpha).toBeLessThan(ui.blasts[0].alpha)
    expect(fx.update(frame(48 + BLAST_TICKS)).blasts).toHaveLength(0)
  })

  it('an unrelated breach (a grenade on some other door) draws no shockwave', () => {
    const fx = createGroupFxTracker()
    const ui = fx.update(frame(3, [{ type: 'doorBreach', entityId: 77, x: 1, y: 1 }]))
    expect(ui.blasts).toHaveLength(0)
  })

  it('processes a tick once however many frames draw it, and a rewind clears it', () => {
    const fx = createGroupFxTracker()
    fx.update(frame(10, [plant]))
    fx.update(frame(10, [plant]))
    expect(fx.update(frame(11)).charges).toHaveLength(1)
    expect(fx.update(frame(2)).charges).toHaveLength(0)
  })
})

describe('group fx: the medic', () => {
  it('draws a heal beam from the medic to the patched body, following them, then fades', () => {
    const fx = createGroupFxTracker()
    const medic = raider(1, 5, 5, 'medic')
    const grunt = raider(2, 6, 5, 'grunt', true)
    const ui = fx.update(frame(30, [{ type: 'heal', entityId: 2, byId: 1, amount: 8 }], [medic, grunt]))
    expect(ui.beams).toEqual([{ x1: 5, y1: 5, x2: 6, y2: 5, alpha: 1 }])
    grunt.pos.x = 7
    const mid = fx.update(frame(35, [], [medic, grunt]))
    expect(mid.beams[0].x2).toBe(7)
    expect(mid.beams[0].alpha).toBeLessThan(1)
    expect(fx.update(frame(30 + BEAM_TICKS, [], [medic, grunt])).beams).toHaveLength(0)
  })

  it('marks raiders falling back to be healed, and rings the medic', () => {
    const fx = createGroupFxTracker()
    const ui = fx.update(frame(1, [], [raider(1, 5, 5, 'medic'), raider(2, 6, 5, 'grunt', true), raider(3, 8, 5, 'grunt')]))
    expect(ui.retreaters).toEqual([{ x: 6, y: 5 }])
    expect(ui.medics).toEqual([{ x: 5, y: 5 }])
  })

  it('drops a beam whose end died', () => {
    const fx = createGroupFxTracker()
    const grunt = raider(2, 6, 5, 'grunt')
    grunt.dead = true
    const ui = fx.update(frame(1, [{ type: 'heal', entityId: 2, byId: 1, amount: 8 }], [raider(1, 5, 5, 'medic'), grunt]))
    expect(ui.beams).toHaveLength(0)
  })
})
