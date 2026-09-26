// #130. Damage over time hurts like any other blow. It restarts the passive-regen
// wait (systems/regen.ts) and trips a `damage` sleeper (systems/dormancy.ts), the
// two readers of `health.lastHurtTick`. Before this fix elementSystem took hp without
// recording the hurt, so a still, burning player healed ~10 HP/s against a
// ~6.7 HP/s burn and floor fire could not hurt a player who stood in it.
// Every case runs the real tick (runTicks), which also fails any fractional hp.

import { describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { runTicks } from '../testkit'
import type { InputCmd } from '../types'
import { createWorld, type World } from '../world'
import { applyDamage, detonate } from './combat'
import { igniteCell } from './fire'
import { shock, wet } from './interactions'
import { REGEN_CALM_TICKS, REGEN_HP_PER_INTERVAL } from './regen'
import { applyStatus, hasStatus } from './statusFx'

const idle = new Map<number, Partial<InputCmd>>([[0, {}]])

/** One player on the spawn tile of an otherwise empty world, spawn grace shed. */
const solo = (hp: number): { w: World; p: Entity } => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  p.health!.iframes = 0
  p.health!.hp = hp
  return { w, p }
}

/** hp lost by `id` to this tick's `hit` events. */
const hitsOn = (w: World, id: number): number =>
  w.events.reduce((sum, ev) => (ev.type === 'hit' && ev.targetId === id ? sum + ev.amount : sum), 0)

describe('damage over time interrupts regen', () => {
  it('a player standing still in a burning cell never heals while burning, and loses hp', () => {
    const { w, p } = solo(120)
    igniteCell(w, Math.floor(p.pos.x), Math.floor(p.pos.y))
    let prev = p.health!.hp
    let burned = 0
    for (let t = 0; t < 300; t++) {
      runTicks(w, idle, 1)
      expect(hasStatus(p, 'burning')).toBe(true)
      expect(p.health!.hp, `tick ${w.tick - 1}: healed while burning`).toBeLessThanOrEqual(prev)
      burned += hitsOn(w, p.id)
      prev = p.health!.hp
    }
    // Net loss, and every hp lost is a burn tick: no heal clawed any of it back.
    expect(burned).toBeGreaterThan(0)
    expect(p.health!.hp).toBe(120 - burned)
  })

  it('regen resumes exactly REGEN_CALM_TICKS after the last burn tick', () => {
    const { w, p } = solo(100)
    applyStatus(w, p, 'burning', 60)
    let lastBurn = -1
    while (hasStatus(p, 'burning')) {
      runTicks(w, idle, 1)
      if (hitsOn(w, p.id) > 0) lastBurn = w.tick - 1
    }
    expect(lastBurn).toBeGreaterThan(0)
    const burnedTo = p.health!.hp
    expect(burnedTo).toBeLessThan(100)
    // No heal lands on any tick before the full calm window after the last burn.
    while (w.tick < lastBurn + REGEN_CALM_TICKS) {
      runTicks(w, idle, 1)
      expect(p.health!.hp, `tick ${w.tick - 1}: healed inside the calm window`).toBe(burnedTo)
    }
    // The first heal lands on tick lastBurn + REGEN_CALM_TICKS, never later.
    runTicks(w, idle, 1)
    expect(p.health!.hp).toBe(burnedTo + REGEN_HP_PER_INTERVAL)
  })

  it.each(Object.values(ELEMENTS).filter((d) => d.dot > 0).map((d) => d.id))(
    '%s never lets a still player heal while it is on',
    (kind) => {
      const { w, p } = solo(100)
      // Every default duration outlasts the calm window, so a missed hurt heals.
      expect(ELEMENTS[kind].durationTicks).toBeGreaterThan(REGEN_CALM_TICKS)
      applyStatus(w, p, kind, ELEMENTS[kind].durationTicks)
      let prev = p.health!.hp
      while (hasStatus(p, kind)) {
        runTicks(w, idle, 1)
        expect(p.health!.hp, `tick ${w.tick - 1}: healed while ${kind}`).toBeLessThanOrEqual(prev)
        prev = p.health!.hp
      }
      expect(p.health!.hp).toBeLessThan(100)
    },
  )
})

describe('every damage source trips a damage sleeper the same way', () => {
  /** A dormant pod that wakes on damage only, in a cleared 21x21 room, with no
   * resist table so every source lands at full strength. */
  const sleeper = (): { w: World; pod: Entity } => {
    const w = createWorld(1, 1, 'normal', false)
    const cx = Math.floor(w.level.w / 2)
    const cy = Math.floor(w.level.h / 2)
    for (let y = cy - 10; y <= cy + 10; y++)
      for (let x = cx - 10; x <= cx + 10; x++) {
        w.level.tiles[y * w.level.w + x] = Tile.Floor
        w.level.solid[y * w.level.w + x] = 0
      }
    const pod = spawnNpc(w, 'pod', cx + 0.5, cy + 0.5)
    pod.ai!.wakeOn = ['damage']
    pod.resist = undefined
    pod.health = { hp: 1000, max: 1000, iframes: 0 }
    return { w, pod }
  }

  const sources: [string, (w: World, pod: Entity) => void][] = [
    ['a bullet', (w, pod) => applyDamage(w, pod, 5, pod.pos.x + 1, pod.pos.y, 0, 0)],
    ['a blast', (w, pod) => detonate(w, pod.pos.x + 1, pod.pos.y, 2, 5, 0)],
    ['a shock arc through a wet body', (w, pod) => (wet(w, pod), shock(w, pod))],
    ...Object.values(ELEMENTS)
      .filter((d) => d.dot > 0)
      .map((d): [string, (w: World, pod: Entity) => void] => [
        `${d.id} damage over time`,
        (w, pod) => applyStatus(w, pod, d.id, d.durationTicks),
      ]),
  ]

  it.each(sources)('%s wakes it', (_, hurt) => {
    const { w, pod } = sleeper()
    runTicks(w, idle, 5)
    expect(pod.ai!.dormant).toBe(true)
    hurt(w, pod)
    runTicks(w, idle, 30)
    expect(pod.health!.hp).toBeLessThan(1000)
    expect(pod.ai!.dormant).toBe(false)
  })
})
