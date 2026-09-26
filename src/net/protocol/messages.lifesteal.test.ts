// hp crosses the wire as one u8 of hp/max, and the client rebuilds
// round(byte / 255 * max). That recovers a whole hp exactly for any max up to 255
// but cannot carry a fraction, so the host's hp must stay whole for the client to
// match.

import { describe, expect, it } from 'vitest'
import { makeEntity } from '../../game/entity'
import { spawnPlayer } from '../../game/player'
import { arm } from '../../game/testkit'
import { emptyInput } from '../../game/types'
import { addEntity, createWorld, tickWorld } from '../../game/world'
import { applyWireEntity, decodeSnapshot, encodeSnapshot, toWireEntity } from './messages'

describe('player hp over the snapshot codec after a lifesteal heal', () => {
  it('the client rebuilds exactly the hp the host holds, on every tick of sustained fire', () => {
    const w = createWorld(1, 1)
    const host = spawnPlayer(w, 0, 20, 20)
    host.health = { hp: 100, max: 240, iframes: 0 }
    arm(host, 'pistol').mods = [{ id: 'lifesteal', stacks: 2 }]
    const foe = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
    foe.health = { hp: 10000, max: 10000, iframes: 0 }

    const mirror = makeEntity('player', 'player', 0, 0)
    mirror.health = { hp: 0, max: host.health.max, iframes: 0 }
    const pairs: [number, number][] = []
    for (let t = 0; t < 60; t++) {
      tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: 1, aimY: 0 }]]))
      const snap = { tick: w.tick, floor: w.floor, alarm: 0, lastInputSeq: 0, entities: [toWireEntity(host, w.tick)] }
      applyWireEntity(mirror, decodeSnapshot(encodeSnapshot(snap)).entities[0], w.tick)
      pairs.push([host.health.hp, mirror.health.hp])
    }
    expect(host.health.hp).toBeGreaterThan(100)
    expect(pairs.filter(([h, c]) => h !== c)).toEqual([])
  })

  it('every whole hp survives the codec for every max up to 255', () => {
    const host = makeEntity('player', 'player', 0, 0)
    const mirror = makeEntity('player', 'player', 0, 0)
    const misses: string[] = []
    for (let max = 1; max <= 255; max++) {
      mirror.health = { hp: 0, max, iframes: 0 }
      for (let hp = 0; hp <= max; hp++) {
        host.health = { hp, max, iframes: 0 }
        const snap = { tick: 0, floor: 1, alarm: 0, lastInputSeq: 0, entities: [toWireEntity(host, 0)] }
        applyWireEntity(mirror, decodeSnapshot(encodeSnapshot(snap)).entities[0], 0)
        if (mirror.health.hp !== hp) misses.push(`${hp}/${max} -> ${mirror.health.hp}`)
      }
    }
    expect(misses).toEqual([])
  })
})
