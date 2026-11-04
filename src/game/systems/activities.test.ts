// Settlers at props: claim a seat, walk there, sit, play, and get up again.
// Every test stages an authored room (worldFromScene), runs the real systems
// (tickWorld) and asserts on what the settlers did.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks, worldFromScene, type CastSpawner } from '../testkit'
import type { SimEvent } from '../types'
import { tickWorld, type World } from '../world'
import { ACTIVITIES, claimantsOf, GOING_MAX, WAIT_MAX } from './activities'
import { spawnObject } from './objects'

const settler: CastSpawner = (w, x, y) => spawnNpc(w, 'civilian', x + 0.5, y + 0.5)
const CAST: Record<string, CastSpawner> = {
  T: (w, x, y) => spawnObject(w, 'table', x, y),
  c: (w, x, y) => spawnObject(w, 'chair', x, y),
  b: (w, x, y) => spawnObject(w, 'bench', x, y),
  k: (w, x, y) => spawnObject(w, 'bunk', x, y),
  s: settler,
}

// A mess: one table with four chairs round it, settlers along the bottom.
const MESS = [
  '############',
  '#..........#',
  '#....c.....#',
  '#...cTc....#',
  '#....c.....#',
  '#..........#',
  '#.s..s..s..#',
  '############',
]

const stage = (rows: readonly string[] = MESS, hostile = false): World => worldFromScene(rows, CAST, { hostile })
const settlers = (w: World): Entity[] => w.entities.filter((e) => e.archetype === 'civilian' && !e.dead)
const table = (w: World): Entity => w.entities.find((e) => e.archetype === 'table')!

/** Tick until `pred` holds (fails the test after `max` ticks); returns the
 * events seen on the way. */
const until = (w: World, pred: () => boolean, max: number, seen: SimEvent[] = []): SimEvent[] => {
  for (let i = 0; i < max && !pred(); i++) {
    tickWorld(w, new Map())
    seen.push(...w.events)
  }
  expect(pred(), `condition not met within ${max} ticks (tick ${w.tick})`).toBe(true)
  return seen
}

const playing = (w: World): Entity[] => settlers(w).filter((s) => s.ai!.activity?.phase === 'playing')

describe('card games', () => {
  it('two settlers sit at the table, start together and share one end tick', () => {
    const w = stage(MESS.map((r) => r.replace('s..s..s', 's..s...')))
    const seen = until(w, () => playing(w).length === 2, 900)
    const [a, b] = playing(w)
    expect(a.ai!.goal).toBe('cards')
    expect(b.ai!.goal).toBe('cards')
    expect(a.ai!.activity!.until).toBe(b.ai!.activity!.until)
    expect(a.ai!.activity!.seat).not.toBe(b.ai!.activity!.seat)
    const start = seen.filter((e) => e.type === 'activity' && e.phase === 'start')
    expect(start).toHaveLength(1)
    expect(start[0]).toMatchObject({ kind: 'cards', entityId: table(w).id })
    // Seated on their chairs, facing the table.
    for (const p of [a, b]) {
      const chair = w.byId.get(p.ai!.activity!.seat)!
      expect(Math.hypot(p.pos.x - chair.pos.x, p.pos.y - chair.pos.y)).toBeLessThan(0.35)
      const t = table(w)
      const toTable = Math.atan2(t.pos.y - p.pos.y, t.pos.x - p.pos.x)
      expect(Math.abs(Math.atan2(Math.sin(p.facing - toTable), Math.cos(p.facing - toTable)))).toBeLessThan(0.05)
    }
    const end = a.ai!.activity!.until!
    const [lo, hi] = ACTIVITIES.cards.play
    expect(end - w.tick).toBeGreaterThanOrEqual(lo - 1)
    expect(end - w.tick).toBeLessThanOrEqual(hi)
    const ending: SimEvent[] = []
    until(w, () => !a.ai!.activity && !b.ai!.activity, end - w.tick + 2, ending)
    const ends = ending.filter((e) => e.type === 'activity' && e.phase === 'end')
    expect(ends).toEqual([{ type: 'activity', entityId: table(w).id, kind: 'cards', phase: 'end', seats: [a.id, b.id], why: 'done' }])
    expect(w.tick - 1).toBe(end)
    expect(a.ai!.leisureAt).toBeGreaterThan(w.tick)
  })

  it('a lone settler never starts a game, and gives the seat up after waiting', () => {
    const w = stage(MESS.map((r) => r.replace('s..s..s', '.....s.')))
    const [s] = settlers(w)
    const seen = until(w, () => s.ai!.activity?.phase === 'seated', 600)
    const sat = w.tick
    until(w, () => !s.ai!.activity, WAIT_MAX + 5, seen)
    expect(w.tick - sat).toBeGreaterThanOrEqual(WAIT_MAX)
    expect(seen.some((e) => e.type === 'activity' && e.phase === 'start')).toBe(false)
    expect(seen.filter((e) => e.type === 'activity' && e.phase === 'end').map((e) => (e as { why?: string }).why)).toEqual(['timeout'])
  })

  it('seats are exclusive: a two-chair table seats two and turns the third away', () => {
    const rows = [
      '############',
      '#..........#',
      '#...cTc....#',
      '#..........#',
      '#.s..s..s..#',
      '############',
    ]
    const w = stage(rows)
    let maxClaims = 0
    for (let i = 0; i < 1200; i++) {
      tickWorld(w, new Map())
      const claims = claimantsOf(w, table(w).id)
      maxClaims = Math.max(maxClaims, claims.length)
      const seats = claims.map((c) => c.ai!.activity!.seat)
      expect(new Set(seats).size, `tick ${w.tick}: two settlers on one chair`).toBe(seats.length)
    }
    expect(maxClaims).toBe(2)
  })

  it('a session in progress takes no new players', () => {
    const w = stage()
    until(w, () => playing(w).length >= 2, 900)
    const inGame = new Set(playing(w).map((p) => p.id))
    for (let i = 0; i < 300; i++) {
      tickWorld(w, new Map())
      for (const c of claimantsOf(w, table(w).id)) {
        if (!inGame.has(c.id)) expect.fail(`settler #${c.id} joined a game already under way`)
      }
      if (playing(w).length === 0) break
    }
  })

  it('a death mid-game breaks the game up for the table and frees every seat', () => {
    const w = stage(MESS.map((r) => r.replace('s..s..s', 's..s...')))
    until(w, () => playing(w).length === 2, 900)
    const [a, b] = playing(w)
    a.dead = true
    const seen: SimEvent[] = []
    tickWorld(w, new Map())
    seen.push(...w.events)
    tickWorld(w, new Map())
    seen.push(...w.events)
    expect(b.ai!.activity).toBeUndefined()
    expect(claimantsOf(w, table(w).id)).toEqual([])
    expect(seen.find((e) => e.type === 'activity' && e.phase === 'end')).toMatchObject({ seats: [b.id], why: 'broken' })
  })

  it('a destroyed table ends the game for everyone at it', () => {
    const w = stage(MESS.map((r) => r.replace('s..s..s', 's..s...')))
    until(w, () => playing(w).length === 2, 900)
    table(w).dead = true
    runTicks(w, new Map(), 2)
    expect(settlers(w).every((s) => !s.ai!.activity)).toBe(true)
  })

  it('a seat behind a wall it cannot reach is given up, not walked into forever', () => {
    // The table room is sealed: no door, no gap.
    const w = stage([
      '############',
      '#...#.....##',
      '#.s.#.cTc.##',
      '#...#.....##',
      '#.s.########',
      '############',
    ])
    for (let i = 0; i < GOING_MAX + 400; i++) {
      tickWorld(w, new Map())
      for (const s of settlers(w)) {
        const claim = s.ai!.activity
        if (claim) expect(w.tick - claim.since).toBeLessThanOrEqual(GOING_MAX + 1)
      }
    }
    expect(playing(w)).toEqual([])
  })
})

describe('a threat ends the game: settlers still run', () => {
  const ROOMS = [
    '##############',
    '#............#',
    '#....c.......#',
    '#...cTc......#',
    '#....c.......#',
    '#............#',
    '#.s..s.......#',
    '##############',
    '#@...........#',
    '##############',
  ]

  it('a hostile walking in interrupts a game within half a second and frees the seats', () => {
    const w = stage(ROOMS, true)
    const player = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    until(w, () => playing(w).length === 2, 900)
    const [a, b] = playing(w)
    // Teleport the hostile into the mess, beside the table.
    player.pos.x = 8.5
    player.pos.y = 3.5
    player.prevPos.x = 8.5
    player.prevPos.y = 3.5
    const t0 = w.tick
    until(w, () => !a.ai!.activity && !b.ai!.activity, 15)
    expect(w.tick - t0).toBeLessThanOrEqual(15)
    for (const s of [a, b]) expect(['flee', 'battle', 'alert']).toContain(s.ai!.goal)
    expect(claimantsOf(w, table(w).id)).toEqual([])
  })
})

describe('gunfire breaks a game', () => {
  it('settlers look up from their cards at a shot in earshot and go to see', () => {
    const w = stage(MESS.map((r) => r.replace('s..s..s', 's..s...')))
    until(w, () => playing(w).length === 2, 900)
    const [a, b] = playing(w)
    // A shot fired just outside the mess door, in earshot of the table.
    w.noises.push({ x: 10.5, y: 1.5, expires: w.tick + 60 })
    const seen = until(w, () => !a.ai!.activity && !b.ai!.activity, 15)
    for (const s of [a, b]) expect(s.ai!.goal).toBe('investigate')
    expect(claimantsOf(w, table(w).id)).toEqual([])
    expect(seen.find((e) => e.type === 'activity' && e.phase === 'end')).toMatchObject({ why: 'broken' })
  })

  it('an ambient pull that is not a noise does not break a game', () => {
    const w = stage(MESS.map((r) => r.replace('s..s..s', 's..s...')))
    until(w, () => playing(w).length === 2, 900)
    const players = playing(w)
    const end = players[0].ai!.activity!.until!
    // No noise and no threat: nothing ambient outbids a seated game.
    runTicks(w, new Map(), end - w.tick - 1)
    for (const p of players) expect(p.ai!.activity?.phase).toBe('playing')
  })
})

describe('save and load mid-game', () => {
  it('a snapshot taken mid-game replays to the same world, ending on the same tick', () => {
    const w = stage()
    until(w, () => playing(w).length >= 2, 900)
    runTicks(w, new Map(), 45)
    const json = serializeWorld(w)
    const claims = settlers(w).map((s) => s.ai!.activity)
    expect(json.entities.some((e) => (e as { ai?: { activity?: unknown } }).ai?.activity)).toBe(true)
    const copy = deserializeWorld(JSON.parse(JSON.stringify(json)))
    expect(settlers(copy).map((s) => s.ai!.activity)).toEqual(claims)
    runTicks(w, new Map(), 2400)
    runTicks(copy, new Map(), 2400)
    expectWorldEqual(w, copy)
  })
})

describe('determinism', () => {
  it('two runs of one authored settlement are byte-identical, activities and all', () => {
    const rows = [
      '##############',
      '#k.k.....b...#',
      '#............#',
      '#....c.......#',
      '#...cTc......#',
      '#....c.......#',
      '#.s..s..s..s.#',
      '##############',
    ]
    const a = stage(rows)
    const b = stage(rows)
    const kinds = new Set<string>()
    for (let i = 0; i < 3600; i++) {
      tickWorld(a, new Map())
      tickWorld(b, new Map())
      for (const e of a.events) if (e.type === 'activity') kinds.add(e.kind)
    }
    expectWorldEqual(a, b)
    expect([...kinds].sort()).toEqual(['cards', 'rest', 'tinker'])
  })
})
