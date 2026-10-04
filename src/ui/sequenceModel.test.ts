import { describe, expect, it } from 'vitest'
import type { Entity, WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { arm } from '../game/testkit'
import { createWorld } from '../game/world'
import { previewSwaps } from '../input/modSwapQueue'
import { buildSequence } from './sequenceModel'

/** A player whose pistol carries `mods`, with optional stored sequence state. */
const tech = (mods: WeaponMod[], castIndex?: number, rechargeUntil?: number): Entity => {
  const w = createWorld(3, 1)
  const p = spawnPlayer(w, 0, 10.5, 10.5)
  p.loadout!.inventory = []
  const s = arm(p, 'pistol')
  s.mods = mods
  if (castIndex !== undefined) s.castIndex = castIndex
  if (rechargeUntil !== undefined) s.rechargeUntil = rechargeUntil
  return p
}
const m = (id: string): WeaponMod => ({ id, stacks: 1 })

describe('sequence strip model', () => {
  it('is shown whenever the weapon has mods, and hidden otherwise', () => {
    expect(buildSequence(tech([m('frost')]), 0)).not.toBeNull()
    expect(buildSequence(tech([]), 0)).toBeNull()
    expect(buildSequence(undefined, 0)).toBeNull()
  })

  it("highlights the cast at the sim's stored castIndex: modifiers through the payload", () => {
    const model = buildSequence(tech([m('frost'), m('overload'), m('shock'), m('incendiary')], 1), 0)!
    expect(model.entries.map((e) => e.next)).toEqual([false, true, true, false])
    expect(model.entries.map((e) => e.payload)).toEqual([true, false, true, true])
  })

  it('marks entries past the weapon slots as stowed', () => {
    const model = buildSequence(tech([m('frost'), m('shock'), m('incendiary'), m('overload'), m('pierce')]), 0)!
    expect(model.slots).toBe(4)
    expect(model.entries.map((e) => e.live)).toEqual([true, true, true, true, false])
  })

  it('reports recharge left against the host tick', () => {
    const model = buildSequence(tech([m('frost'), m('shock')], 0, 50), 40)!
    expect(model.rechargeLeft).toBe(10)
    expect(model.rechargeTotal).toBe(20)
    expect(buildSequence(tech([m('frost'), m('shock')], 0, 50), 60)!.rechargeLeft).toBe(0)
  })

  it('a one-cast wand has no recharge and highlights its whole window every pull (#115)', () => {
    const model = buildSequence(tech([m('overload'), m('frost')], 1), 0)!
    expect(model.rechargeTotal).toBe(0)
    expect(model.entries.map((e) => e.next)).toEqual([true, true])
  })

  it('previews queued swaps without touching the stack', () => {
    const p = tech([m('frost'), m('shock'), m('overload')])
    const model = buildSequence(p, 0, (mods) => previewSwaps(mods, [{ a: 0, b: 2 }]))!
    expect(model.entries.map((e) => e.id)).toEqual(['overload', 'shock', 'frost'])
    expect(p.loadout!.inventory[0].mods!.map((x) => x.id)).toEqual(['frost', 'shock', 'overload'])
  })
})
