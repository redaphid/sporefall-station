// #114 ruling: "fire should set creatures alight." Any living NPC or player
// standing in a burning cell catches `burning`, and the burn scales by its
// `resist.burning` exactly like a burning round's does. `burning: 0` is immunity.
// Every case runs the real tick (tickWorld via runTicks) on a staged world.

import { beforeEach, describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import { makeEntity, type Entity } from '../entity'
import { isSolidTile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import type { InputCmd, SimEvent } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { fireAt, igniteCell } from './fire'
import { freeze, wet } from './interactions'
import { spawnObject } from './objects'
import { applyStatus, hasStatus, isPanicking } from './statusFx'

const STAGE_W = 12

/** The open 3-row block nearest the level centre: a row of STAGE_W clear cells
 * with clear rows above and below, so bodies walk and roll without scraping walls. */
const findStage = (w: World): { x: number; y: number } => {
  const clear = (x: number, y: number): boolean => {
    for (let i = 0; i < STAGE_W; i++) for (let dy = -1; dy <= 1; dy++) if (isSolidTile(w.level, x + i, y + dy)) return false
    return true
  }
  let best: { x: number; y: number } | undefined
  let bestD = Infinity
  for (let y = 2; y < w.level.h - 2; y++) {
    for (let x = 2; x < w.level.w - STAGE_W - 2; x++) {
      if (!clear(x, y)) continue
      const d = Math.abs(x - w.level.w / 2) + Math.abs(y - w.level.h / 2)
      if (d < bestD) [best, bestD] = [{ x, y }, d]
    }
  }
  if (!best) throw new Error('no open stage on this level')
  return best
}

const noInput = new Map<number, Partial<InputCmd>>()

/** A rooted NPC (a guard never ambles off its cell) centred in cell (cx, cy). */
const npc = (w: World, archetype: string, cx: number, cy: number, hp?: number): Entity => {
  const e = spawnNpc(w, archetype, cx + 0.5, cy + 0.5)
  e.ai!.guard = true
  if (hp !== undefined) e.health = { hp, max: hp, iframes: 0 }
  return e
}

const player = (w: World, x: number, y: number): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.health!.iframes = 0
  return p
}

const cellOf = (e: Entity): [number, number] => [Math.floor(e.pos.x), Math.floor(e.pos.y)]

const moveTo = (e: Entity, cx: number, cy: number): void => {
  e.pos = { x: cx + 0.5, y: cy + 0.5 }
  e.prevPos = { ...e.pos }
}

const fireCount = (w: World): number => w.entities.filter((e) => e.fire && !e.dead).length

describe('fire sets creatures alight (#114)', () => {
  let w: World
  let s: { x: number; y: number }
  beforeEach(() => {
    w = createWorld(1, 1)
    s = findStage(w)
  })

  it('a thug standing in a burning cell catches fire and takes the burn', () => {
    const thug = npc(w, 'thug', s.x, s.y)
    igniteCell(w, s.x, s.y)
    const t0 = w.tick
    runTicks(w, noInput, 1)
    expect(thug.fx?.burning).toEqual({ until: t0 + ELEMENTS.burning.durationTicks })
    runTicks(w, noInput, 45)
    expect(thug.health!.hp).toBeLessThan(40)
  })

  it('burns exactly as hard as a burning round does, scaled by resist.burning', () => {
    // Floor fire and an Incendiary hit must agree tick for tick, per archetype.
    const pairs = (['thug', 'sporeling', 'brute'] as const).map((arch, i) => {
      const inFire = npc(w, arch, s.x + i, s.y, 500)
      const shot = npc(w, arch, s.x + i, s.y + 1, 500)
      igniteCell(w, s.x + i, s.y)
      return { arch, inFire, shot }
    })
    for (const { shot } of pairs) applyStatus(w, shot, 'burning', ELEMENTS.burning.durationTicks)
    runTicks(w, noInput, 120)
    const lost = pairs.map(({ arch, inFire, shot }) => ({ arch, fire: 500 - inFire.health!.hp, round: 500 - shot.health!.hp }))
    for (const l of lost) expect(l.fire, l.arch).toBe(l.round)
    const byArch = Object.fromEntries(lost.map((l) => [l.arch, l.fire]))
    expect(byArch.sporeling).toBeGreaterThan(byArch.thug)
    expect(byArch.brute).toBeGreaterThan(byArch.thug)
  })

  it.each([
    ['an NPC', (w: World, x: number, y: number) => npc(w, 'thug', x, y)],
    ['a player', (w: World, x: number, y: number) => player(w, x + 0.5, y + 0.5)],
  ])('%s immune to burning (resist 0) never ignites and loses no hp', (_label, make) => {
    const e = make(w, s.x, s.y)
    e.resist = { burning: 0 }
    const hp = e.health!.hp
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 120)
    expect(hasStatus(e, 'burning')).toBe(false)
    expect(e.health!.hp).toBe(hp)
    expect(cellOf(e)).toEqual([s.x, s.y])
  })

  it('keeps burning for the full status duration after leaving the fire, then goes out', () => {
    const thug = npc(w, 'thug', s.x, s.y, 1000)
    thug.speed = 0
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 10)
    expect(cellOf(thug)).toEqual([s.x, s.y])
    const lastLit = w.tick - 1
    moveTo(thug, s.x + 6, s.y)
    const hpOut = thug.health!.hp
    runTicks(w, noInput, lastLit + ELEMENTS.burning.durationTicks - w.tick)
    expect(hasStatus(thug, 'burning')).toBe(true)
    expect(thug.health!.hp).toBeLessThan(hpOut)
    runTicks(w, noInput, 1)
    expect(hasStatus(thug, 'burning')).toBe(false)
    const hpDone = thug.health!.hp
    runTicks(w, noInput, 60)
    expect(thug.health!.hp).toBe(hpDone)
  })

  it('a player in the fire ignites, walks out still burning, and rolls it out', () => {
    const p = player(w, s.x + 0.5, s.y + 0.5)
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 1)
    expect(hasStatus(p, 'burning')).toBe(true)

    const east = new Map([[0, { moveX: 1 }]])
    while (cellOf(p)[0] === s.x) runTicks(w, east, 1)
    runTicks(w, noInput, 1)
    expect(hasStatus(p, 'burning')).toBe(true)
    const naturalEnd = p.fx!.burning.until

    const doused: Extract<SimEvent, { type: 'burnDoused' }>[] = []
    const roll = new Map([[0, { roll: true, moveX: 1 }]])
    while (hasStatus(p, 'burning') && w.tick < naturalEnd) {
      runTicks(w, roll, 1)
      for (const ev of w.events) if (ev.type === 'burnDoused') doused.push(ev)
    }
    expect(hasStatus(p, 'burning')).toBe(false)
    expect(w.tick).toBeLessThan(naturalEnd - 400)
    expect(doused.length).toBe(4)
    expect(doused.at(-1)!.remainingTicks).toBe(0)
  })

  it('a roll that ends inside the burning cell is lit again at full duration', () => {
    const p = player(w, s.x + 1.05, s.y + 0.5)
    igniteCell(w, s.x + 1, s.y)
    runTicks(w, noInput, 1)
    const t = w.tick
    runTicks(w, new Map([[0, { roll: true, moveX: 1 }]]), 1)
    expect(w.events.some((e) => e.type === 'burnDoused')).toBe(true)
    expect(cellOf(p)).toEqual([s.x + 1, s.y])
    expect(p.fx!.burning.until).toBe(t + ELEMENTS.burning.durationTicks)
  })

  it('a frozen body in the fire catches and burns, stays frozen, and never shatters', () => {
    const thug = npc(w, 'thug', s.x, s.y, 200)
    freeze(w, thug)
    const thawAt = thug.fx!.frozen.until
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 1)
    expect(hasStatus(thug, 'burning')).toBe(true)
    expect(thug.fx!.frozen.until).toBe(thawAt)
    runTicks(w, noInput, 60)
    expect(hasStatus(thug, 'frozen')).toBe(true)
    expect(thug.health!.hp).toBeLessThan(200)
    expect(thug.shattered).toBeUndefined()
  })

  it('a cinder catches fire (0.2 resists, it does not immunise) and burns slower than a thug', () => {
    const cinder = npc(w, 'cinder', s.x, s.y, 500)
    const thug = npc(w, 'thug', s.x + 2, s.y, 500)
    igniteCell(w, s.x, s.y)
    igniteCell(w, s.x + 2, s.y)
    runTicks(w, noInput, 120)
    expect(hasStatus(cinder, 'burning')).toBe(true)
    expect(500 - cinder.health!.hp).toBeLessThan(500 - thug.health!.hp)
  })

  it('a wet body meets floor fire exactly as it meets a burning round', () => {
    const inFire = npc(w, 'thug', s.x, s.y)
    const shot = npc(w, 'thug', s.x + 3, s.y)
    wet(w, inFire)
    wet(w, shot)
    igniteCell(w, s.x, s.y)
    applyStatus(w, shot, 'burning', ELEMENTS.burning.durationTicks)
    runTicks(w, noInput, 1)
    expect(hasStatus(inFire, 'burning')).toBe(hasStatus(shot, 'burning'))
    expect(hasStatus(inFire, 'wet')).toBe(hasStatus(shot, 'wet'))
  })

  it('a burning creature lays no fire of its own on bare floor', () => {
    const thug = npc(w, 'thug', s.x, s.y, 1000)
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 1)
    moveTo(thug, s.x + 6, s.y)
    runTicks(w, noInput, 18 * 4)
    expect(hasStatus(thug, 'burning')).toBe(true)
    expect(fireCount(w)).toBe(1)
    expect(fireAt(w, s.x + 6, s.y)).toBe(false)
  })

  it('fire never leaps to a creature in the neighbouring cell', () => {
    const thug = npc(w, 'thug', s.x + 1, s.y)
    const p = player(w, s.x - 0.5, s.y + 0.5)
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 18 * 4)
    expect(fireCount(w)).toBe(1)
    expect(hasStatus(thug, 'burning')).toBe(false)
    expect(hasStatus(p, 'burning')).toBe(false)
  })

  it('things that are not creatures stay untouched in a burning cell', () => {
    const cash = addEntity(w, makeEntity('pickup', 'pickup.cash', s.x + 0.5, s.y + 0.5, 0.3))
    cash.pickup = { itemId: 'cash', qty: 10 }
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 30)
    expect(cash.fx).toBeUndefined()
  })

  it('is byte-identical across a serialize/deserialize taken mid-fire', () => {
    const stage = (): World => {
      const v = createWorld(1, 1)
      npc(v, 'thug', s.x, s.y)
      npc(v, 'sporeling', s.x + 1, s.y)
      npc(v, 'cinder', s.x + 2, s.y)
      player(v, s.x + 3.5, s.y + 0.5)
      const crate = addEntity(v, makeEntity('interactable', 'crate', s.x + 4.5, s.y + 0.5, 0.4))
      crate.flammable = true
      crate.health = { hp: 20, max: 20, iframes: 0 }
      for (let i = 0; i < 4; i++) igniteCell(v, s.x + i, s.y)
      return v
    }
    const inputs = new Map([[0, { moveX: 1 }]])
    const a = runTicks(stage(), inputs, 40)
    const snap = serializeWorld(a)
    expect(snap.entities.filter((e) => (e.ai || e.playerCtl) && e.fx?.burning).length).toBeGreaterThan(1)
    runTicks(a, inputs, 300)
    const b = runTicks(deserializeWorld(snap), inputs, 300)
    expectWorldEqual(a, b)
    const c = runTicks(stage(), inputs, 340)
    expectWorldEqual(a, c)
  })
})

describe('floor fire meets the #92 element verbs', () => {
  let w: World
  let s: { x: number; y: number }
  beforeEach(() => {
    w = createWorld(1, 1)
    s = findStage(w)
  })

  it('an NPC lit by floor fire panics and bolts out of the flames, still burning', () => {
    const thug = spawnNpc(w, 'thug', s.x + 0.5, s.y + 0.5)
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 1)
    expect(isPanicking(w, thug)).toBe(true)
    runTicks(w, noInput, 30)
    expect(thug.ai!.goal).toBe('flee')
    expect(fireAt(w, ...cellOf(thug))).toBe(false)
    expect(hasStatus(thug, 'burning')).toBe(true)
  })

  it.each([
    ['an NPC', (w: World, x: number, y: number) => npc(w, 'thug', x, y)],
    ['a player', (w: World, x: number, y: number) => player(w, x + 0.5, y + 0.5)],
  ])('%s that is wet is dried by its first tick in the fire and lit by the next', (_label, make) => {
    const e = make(w, s.x, s.y)
    wet(w, e)
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 1)
    expect(hasStatus(e, 'wet')).toBe(false)
    expect(hasStatus(e, 'burning')).toBe(false)
    expect(isPanicking(w, e)).toBe(false)
    runTicks(w, noInput, 1)
    expect(hasStatus(e, 'burning')).toBe(true)
  })

  it('an NPC lit by floor fire carries it to a crate it brushes past', () => {
    const thug = npc(w, 'thug', s.x, s.y, 1000)
    thug.speed = 0
    igniteCell(w, s.x, s.y)
    runTicks(w, noInput, 1)
    const crate = spawnObject(w, 'crate', s.x + 8, s.y)
    moveTo(thug, s.x + 7, s.y)
    thug.pos.x += 0.3
    runTicks(w, noInput, 1)
    expect(fireAt(w, ...cellOf(crate))).toBe(true)
  })
})
