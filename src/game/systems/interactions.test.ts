import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { emptyInput } from '../types'
import { movementSystem } from './movement'
import { hasStatus } from './statusFx'
import { shock, wet } from './interactions'

const npc = (w: World, x: number, y: number, hp = 40): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.speed = 4
  return e
}

describe('wet + electric chain', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('zapping one wet entity chains to an adjacent wet entity and damages it', () => {
    const a = npc(w, 20, 20)
    const b = npc(w, 21, 20)
    wet(w, a)
    wet(w, b)
    shock(w, a)
    expect(hasStatus(b, 'electrified')).toBe(true)
    expect(b.health!.hp).toBeLessThan(40)
  })

  it('does not arc across a dry gap', () => {
    const a = npc(w, 20, 20)
    const dry = npc(w, 21, 20)
    const far = npc(w, 22, 20)
    wet(w, a)
    wet(w, far)
    shock(w, a)
    expect(hasStatus(dry, 'electrified')).toBe(false)
    expect(hasStatus(far, 'electrified')).toBe(false)
    expect(far.health!.hp).toBe(40)
  })

  it('a dry zapped entity is electrified but takes no water damage', () => {
    const a = npc(w, 20, 20)
    shock(w, a)
    expect(hasStatus(a, 'electrified')).toBe(true)
    expect(a.health!.hp).toBe(40)
  })

  it('electrified immobilizes like frost', () => {
    const a = npc(w, 20, 20)
    a.intent = { x: 1, y: 0 }
    shock(w, a)
    movementSystem(w, new Map([[0, emptyInput()]]))
    expect(a.pos.x).toBeCloseTo(20)
  })

  it('chains through a connected wet cluster deterministically', () => {
    const ents = [npc(w, 20, 20), npc(w, 21, 20), npc(w, 22, 20), npc(w, 23, 20)]
    for (const e of ents) wet(w, e)
    shock(w, ents[0])
    for (const e of ents) expect(hasStatus(e, 'electrified')).toBe(true)
    for (let i = 1; i < ents.length; i++) expect(ents[i].health!.hp).toBeLessThan(40)
  })
})
