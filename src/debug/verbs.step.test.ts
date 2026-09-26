// `step N {input}` — the playtest verb. An agent in a browser tab (visible or
// hidden: a background tab's frame loop is frozen) advances the REAL sim N ticks
// while holding one player's InputCmd, so it can move, aim, fire, and swap mods
// deterministically and read back what the build did.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { packModSwap } from '../game/systems/modSequence'
import { equipSlot, weaponStack } from '../game/systems/inventory'
import { emptyInput } from '../game/types'
import { createWorld, tickWorld, type World } from '../game/world'
import { runVerb } from './verbs'

const arena = (): { w: World; pid: number } => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  equipSlot(p, 0)
  return { w, pid: p.id }
}
const step = (w: World, line: string) => JSON.parse(runVerb(w, line)) as {
  tick: number
  advanced: number
  player?: number
  events: Record<string, number>
}

describe('step verb with a held input', () => {
  it('bare `step N` still advances with neutral input', () => {
    const a = arena()
    const b = arena()
    step(a.w, 'step 12')
    for (let i = 0; i < 12; i++) tickWorld(b.w, new Map())
    expect(serializeWorld(a.w)).toEqual(serializeWorld(b.w))
  })

  it('is byte-identical to tickWorld fed the same InputCmd every tick', () => {
    const a = arena()
    const b = arena()
    step(a.w, 'step 25 {"moveX":1,"moveY":-0.5,"aimX":0,"aimY":1,"attack":true}')
    for (let i = 0; i < 25; i++) {
      const cmd = { ...emptyInput(), seq: i, moveX: 1, moveY: -0.5, aimX: 0, aimY: 1, attack: true }
      tickWorld(b.w, new Map([[0, cmd]]))
    }
    expect(serializeWorld(a.w)).toEqual(serializeWorld(b.w))
  })

  it('moves the player where neutral input leaves it', () => {
    const held = arena()
    const idle = arena()
    step(held.w, 'step 20 {"moveX":1}')
    step(idle.w, 'step 20')
    const x = (w: World, id: number) => w.byId.get(id)!.pos.x
    expect(x(held.w, held.pid)).toBeGreaterThan(x(idle.w, idle.pid) + 1)
  })

  it('aimAt lands shots on a target straight below the player; the default aim misses it', () => {
    const shoot = (input: string) => {
      const { w } = arena()
      const npc = spawnNpc(w, 'thug', 20, 25)
      const hp0 = npc.health!.hp
      step(w, `step 60 ${input}`)
      return hp0 - npc.health!.hp
    }
    const { w } = arena()
    const npcId = spawnNpc(w, 'thug', 20, 25).id
    expect(shoot(`{"aimAt":${npcId},"attack":true}`)).toBeGreaterThan(0)
    expect(shoot('{"attack":true}')).toBe(0)
  })

  it('edge fields fire on the first tick only (a held swap would undo itself)', () => {
    const { w, pid } = arena()
    runVerb(w, `addMod ${pid} frost`)
    runVerb(w, `addMod ${pid} heavy`)
    const order = () => weaponStack(w.byId.get(pid)!)!.mods!.map((m) => m.id)
    const before = order()
    step(w, `step 2 {"modSwap":${packModSwap(0, 1)}}`)
    expect(order()).toEqual([before[1], before[0]])
  })

  it('reports event counts and the acting player', () => {
    const { w, pid } = arena()
    spawnNpc(w, 'thug', 23, 20)
    const r = step(w, 'step 45 {"aimX":1,"aimY":0,"attack":true}')
    expect(r.player).toBe(pid)
    expect(r.advanced).toBe(45)
    expect(Object.values(r.events).every((n) => Number.isInteger(n) && n > 0)).toBe(true)
  })

  it('clamps move and aim to the unit range the input layer produces', () => {
    const a = arena()
    const b = arena()
    step(a.w, 'step 10 {"moveX":50}')
    step(b.w, 'step 10 {"moveX":1}')
    expect(serializeWorld(a.w)).toEqual(serializeWorld(b.w))
  })

  it.each([
    ['not JSON', 'step 5 {moveX:1}'],
    ['a non-object', 'step 5 [1,2]'],
    ['an unknown field', 'step 5 {"teleport":true}'],
    ['a non-finite number', 'step 5 {"moveX":"fast"}'],
    ['a non-boolean button', 'step 5 {"attack":1}'],
    ['a missing player', 'step 5 {"player":9,"moveX":1}'],
    ['an aimAt entity that does not exist', 'step 5 {"aimAt":99999}'],
    ['a prototype key', 'step 5 {"__proto__":{"x":1}}'],
    ['a negative count', 'step -1 {"moveX":1}'],
  ])('rejects %s and advances nothing', (_why, line) => {
    const { w } = arena()
    const before = serializeWorld(w)
    expect(() => runVerb(w, line)).toThrow()
    expect(serializeWorld(w)).toEqual(before)
  })

  it('with no player on the map, a held input is an error, not a silent no-op', () => {
    const w = createWorld(1, 1)
    expect(() => runVerb(w, 'step 5 {"moveX":1}')).toThrow(/no player/)
  })
})

describe('playtest over saved worlds', () => {
  it('a run split across serialize/deserialize is byte-identical to one continuous run', () => {
    const once = arena()
    const split = arena()
    spawnNpc(once.w, 'thug', 20, 25)
    spawnNpc(split.w, 'thug', 20, 25)
    const npcId = once.w.entities.find((e) => e.kind === 'npc')!.id
    runVerb(once.w, `step 90 {"aimAt":${npcId},"attack":true,"moveX":0.3}`)
    let w = split.w
    for (const n of [30, 30, 30]) {
      w = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))
      runVerb(w, `step ${n} {"aimAt":${npcId},"attack":true,"moveX":0.3}`)
    }
    expect(serializeWorld(w)).toEqual(serializeWorld(once.w))
  })
})

describe('look verb', () => {
  it('reports the player build and nearby entities nearest first, within the radius', () => {
    const { w, pid } = arena()
    const far = spawnNpc(w, 'thug', 20, 31)
    const near = spawnNpc(w, 'brute', 23, 20)
    runVerb(w, `addMod ${pid} frost`)
    const seen = JSON.parse(runVerb(w, 'look 8'))
    expect(seen.player.id).toBe(pid)
    expect(seen.player.mods).toEqual(['frost'])
    const ids = seen.near.map((n: { id: number }) => n.id)
    expect(ids).toContain(near.id)
    expect(ids).not.toContain(far.id)
    const dists = seen.near.map((n: { dist: number }) => n.dist)
    expect(dists).toEqual([...dists].sort((a: number, b: number) => a - b))
    expect(seen.near.find((n: { id: number }) => n.id === near.id).resist).toEqual(w.byId.get(near.id)!.resist)
  })

  it('shows element statuses on a struck target', () => {
    const { w, pid } = arena()
    const npc = spawnNpc(w, 'thug', 20, 25)
    runVerb(w, `addMod ${pid} incendiary`)
    runVerb(w, `step 40 {"aimAt":${npc.id},"attack":true}`)
    const seen = JSON.parse(runVerb(w, 'look'))
    const row = seen.near.find((n: { id: number }) => n.id === npc.id)
    expect(row?.fx ?? []).toContain('burning')
  })

  it('is read-only and survives a world with no living player', () => {
    const w = createWorld(1, 1)
    const before = serializeWorld(w)
    expect(JSON.parse(runVerb(w, 'look')).player).toBeNull()
    expect(serializeWorld(w)).toEqual(before)
  })
})
