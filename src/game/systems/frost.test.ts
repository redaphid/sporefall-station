import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput } from '../types'
import { applyDamage } from './combat'
import { elementSystem, fireSystem, igniteCell } from './fire'
import { movementSystem } from './movement'
import { freeze } from './interactions'

const npc = (w: World, x: number, y: number, hp = 40): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.speed = 4
  return e
}

describe('frost', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('immobilizes: a frozen entity does not move', () => {
    const e = npc(w, 20, 20)
    e.intent = { x: 1, y: 0 }
    freeze(w, e)
    movementSystem(w, new Map([[0, emptyInput()]]))
    expect(e.pos.x).toBeCloseTo(20)
  })

  it('thaws on expiry: an unfrozen twin moves freely', () => {
    const e = npc(w, 20, 20)
    e.intent = { x: 1, y: 0 }
    movementSystem(w, new Map([[0, emptyInput()]]))
    expect(e.pos.x).toBeGreaterThan(20)
  })

  it('shatters on impact: a frozen entity hit is destroyed outright', () => {
    const e = npc(w, 20, 20)
    freeze(w, e)
    applyDamage(w, e, 1, 25, 20, 0, 99)
    expect(e.health!.hp).toBe(0)
    expect(e.dead).toBe(true)
    expect(e.shattered).toBe(true)
  })

  it('an unfrozen twin hit for the same damage survives', () => {
    const e = npc(w, 20, 20)
    applyDamage(w, e, 1, 25, 20, 0, 99)
    expect(e.health!.hp).toBe(39)
    expect(e.dead).toBeFalsy()
    expect(e.shattered).toBeFalsy()
  })

  it('fire carve-out: a frozen burning entity dies by DoT without shattering', () => {
    const e = npc(w, 20, 20, 6)
    e.flammable = true
    freeze(w, e)
    igniteCell(w, 20, 20)
    for (let t = 0; t < 120 && !e.dead; t++) {
      fireSystem(w)
      elementSystem(w)
      w.tick++
    }
    expect(e.dead).toBe(true)
    expect(e.shattered).toBeFalsy()
  })

  it('same-tick freeze does not retroactively count: freezing an already-dead entity is a no-op', () => {
    const e = npc(w, 20, 20)
    e.dead = true
    freeze(w, e)
    applyDamage(w, e, 1, 25, 20, 0, 99)
    expect(e.shattered).toBeFalsy()
  })
})
