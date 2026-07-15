import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { addStatus, hasStatus, removeStatus, statusFxSystem } from './statusFx'

describe('statusFx', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('applies a status with an absolute expiry tick', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 10)
    expect(hasStatus(e, 'burning')).toBe(true)
    expect(e.fx!.burning.until).toBe(w.tick + 10)
  })

  it('expires a status once its tick arrives', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 2)
    w.tick = 1
    statusFxSystem(w)
    expect(hasStatus(e, 'burning')).toBe(true)
    w.tick = 2
    statusFxSystem(w)
    expect(hasStatus(e, 'burning')).toBe(false)
  })

  it('reapplying a status refreshes its expiry', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 5)
    w.tick = 4
    addStatus(w, e, 'burning', 5)
    expect(e.fx!.burning.until).toBe(9)
  })

  it('records the source entity that applied it', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 5, 42)
    expect(e.fx!.burning.source).toBe(42)
  })

  it('ignores non-positive durations', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 0)
    expect(hasStatus(e, 'burning')).toBe(false)
  })

  it('does not apply new statuses to the dead, but keeps existing ones ticking', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 5)
    e.dead = true
    addStatus(w, e, 'poisoned', 5)
    expect(hasStatus(e, 'poisoned')).toBe(false)
    expect(hasStatus(e, 'burning')).toBe(true)
  })

  it('removeStatus clears one effect', () => {
    const e = addEntity(w, makeEntity('npc', 'civilian', 5, 5))
    addStatus(w, e, 'burning', 5)
    removeStatus(e, 'burning')
    expect(hasStatus(e, 'burning')).toBe(false)
  })
})
