import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { hasStatus } from './statusFx'
import { elementSystem, fireAt, fireSystem, igniteCell } from './fire'

const flammable = (w: World, x: number, y: number, hp = 20): Entity => {
  const e = addEntity(w, makeEntity('interactable', 'crate', x, y, 0.4))
  e.flammable = true
  e.health = { hp, max: hp, iframes: 0 }
  return e
}

describe('fire', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('igniteCell places one fire hazard in that cell', () => {
    igniteCell(w, 5, 5)
    expect(fireAt(w, 5, 5)).toBe(true)
    expect(fireAt(w, 6, 5)).toBe(false)
  })

  it('is a no-op when the cell already burns', () => {
    igniteCell(w, 5, 5)
    igniteCell(w, 5, 5)
    const fires = w.entities.filter((e) => e.fire)
    expect(fires.length).toBe(1)
  })

  it('ignites a flammable entity standing in the fire (burning + DoT)', () => {
    const crate = flammable(w, 5, 5)
    igniteCell(w, 5, 5)
    fireSystem(w)
    elementSystem(w)
    expect(hasStatus(crate, 'burning')).toBe(true)
    expect(crate.health!.hp).toBeLessThan(20)
  })

  it('spreads to an adjacent flammable neighbor', () => {
    flammable(w, 6, 5)
    igniteCell(w, 5, 5)
    fireSystem(w)
    expect(fireAt(w, 6, 5)).toBe(true)
  })

  it('does not spread to a diagonal neighbor', () => {
    flammable(w, 6, 6)
    igniteCell(w, 5, 5)
    fireSystem(w)
    expect(fireAt(w, 6, 6)).toBe(false)
  })

  it('drives hp strictly down over successive ticks and eventually kills', () => {
    const crate = flammable(w, 5, 5, 5)
    igniteCell(w, 5, 5)
    let last = crate.health!.hp
    for (let i = 0; i < 60 && !crate.dead; i++) {
      fireSystem(w)
      elementSystem(w)
      expect(crate.health!.hp).toBeLessThanOrEqual(last)
      last = crate.health!.hp
      w.tick++
    }
    expect(crate.dead).toBe(true)
  })

  it('burns down and extinguishes once fuel runs out', () => {
    igniteCell(w, 5, 5)
    for (let i = 0; i < 500 && fireAt(w, 5, 5); i++) {
      fireSystem(w)
      w.tick++
    }
    expect(fireAt(w, 5, 5)).toBe(false)
  })

  it('is deterministic: same seed and script yields identical fire layout', () => {
    const run = (): string => {
      const world = createWorld(7, 1)
      flammable(world, 6, 5)
      flammable(world, 7, 5)
      igniteCell(world, 5, 5)
      for (let i = 0; i < 5; i++) {
        fireSystem(world)
        world.tick++
      }
      return world.entities
        .filter((e) => e.fire)
        .map((e) => `${Math.floor(e.pos.x)},${Math.floor(e.pos.y)}`)
        .sort()
        .join('|')
    }
    expect(run()).toBe(run())
  })
})
