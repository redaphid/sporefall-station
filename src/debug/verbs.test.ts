import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { createWorld, type World } from '../game/world'
import { encodeArg } from './protocol'
import { runVerb, serializeEntity, verbName, WRITE_VERBS } from './verbs'

const world = (): World => createWorld(1234, 1)

describe('runVerb', () => {
  it('lists every entity with its verbatim component JSON', () => {
    const w = world()
    const npc = spawnNpc(w, 'cop', 5, 6)
    const list = JSON.parse(runVerb(w, 'entities')) as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    const row = list[0]
    // Verbatim mirror: id/kind/archetype AND every component field survive.
    expect(row.id).toBe(npc.id)
    expect(row.kind).toBe('npc')
    expect(row.archetype).toBe('cop')
    expect(row.health).toEqual(npc.health)
    expect((row.ai as { faction: string }).faction).toBe('cop')
  })

  it('serializes UNKNOWN/future component fields (verbatim mirror)', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 1, 1)
    // A component no verb knows about — it must still appear in the mirror.
    ;(e as unknown as { futureThing: { z: number } }).futureThing = { z: 42 }
    const dump = serializeEntity(e)
    expect((dump.futureThing as { z: number }).z).toBe(42)
    expect(JSON.parse(runVerb(w, `get ${e.id}`)).futureThing.z).toBe(42)
  })

  it('get returns one entity, and errors on a missing id', () => {
    const w = world()
    const e = spawnNpc(w, 'civilian', 2, 3)
    expect(JSON.parse(runVerb(w, `get ${e.id}`)).id).toBe(e.id)
    expect(() => runVerb(w, 'get 9999')).toThrow(/no entity/)
  })

  it('set deep-merges a JSON patch and coerces scalar types', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    runVerb(w, `set ${e.id} {"health":{"hp":7}}`)
    expect(e.health!.hp).toBe(7)
    expect(e.health!.max).toBe(spawnNpc(world(), 'thug', 0, 0).health!.max) // untouched
    // String coerced to the field's existing number type.
    runVerb(w, `set ${e.id} {"speed":"3.5"}`)
    expect(e.speed).toBe(3.5)
  })

  it('set accepts a base64-wrapped payload (whitespace-safe)', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    runVerb(w, `set ${e.id} ${encodeArg('{ "health": { "hp": 3 } }')}`)
    expect(e.health!.hp).toBe(3)
  })

  it('spawn creates a fully-wired NPC', () => {
    const w = world()
    const before = w.entities.length
    const out = JSON.parse(runVerb(w, 'spawn npc cop 10 12'))
    expect(w.entities.length).toBe(before + 1)
    expect(out.archetype).toBe('cop')
    expect(out.pos).toEqual({ x: 10, y: 12 })
    expect(out.ai).toBeTruthy()
    expect(out.health).toBeTruthy()
  })

  it('kill marks an npc dead and downs a player', () => {
    const w = world()
    const npc = spawnNpc(w, 'thug', 0, 0)
    expect(JSON.parse(runVerb(w, `kill ${npc.id}`)).dead).toBe(true)
    const p = spawnPlayer(w, 0, 'soldier', 1, 1)
    const rep = JSON.parse(runVerb(w, `kill ${p.id}`))
    expect(rep.dead).toBe(false)
    expect(rep.downed).toBe(true)
  })

  it('teleport moves pos and clears interpolation', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    runVerb(w, `teleport ${e.id} 20 30`)
    expect(e.pos).toEqual({ x: 20, y: 30 })
    expect(e.prevPos).toEqual({ x: 20, y: 30 })
  })

  it('state summarizes the world with per-kind counts', () => {
    const w = world()
    spawnNpc(w, 'cop', 0, 0)
    spawnNpc(w, 'thug', 1, 1)
    spawnPlayer(w, 0, 'soldier', 2, 2)
    const s = JSON.parse(runVerb(w, 'state'))
    expect(s.tick).toBe(0)
    expect(s.seed).toBe(1234)
    expect(s.total).toBe(3)
    expect(s.counts.npc).toBe(2)
    expect(s.counts.player).toBe(1)
  })

  it('events reflects the supplied recent-events ring', () => {
    const w = world()
    const ring = [{ type: 'death', x: 1, y: 2, entityId: 5 } as const]
    expect(JSON.parse(runVerb(w, 'events', { events: ring }))).toEqual(ring)
  })

  it('command is a verbatim escape hatch onto another verb', () => {
    const w = world()
    spawnNpc(w, 'cop', 0, 0)
    expect(JSON.parse(runVerb(w, 'command state')).total).toBe(1)
  })

  it('rejects an unknown verb', () => {
    expect(() => runVerb(world(), 'frobnicate 1')).toThrow(/unknown verb/)
  })
})

describe('verbName / WRITE_VERBS', () => {
  it('classifies reads and writes, unwrapping command', () => {
    expect(verbName('entities')).toBe('entities')
    expect(verbName('set 5 {}')).toBe('set')
    expect(verbName('command spawn npc cop 1 2')).toBe('spawn')
    expect(WRITE_VERBS.has(verbName('command kill 3'))).toBe(true)
    expect(WRITE_VERBS.has(verbName('state'))).toBe(false)
  })
})
