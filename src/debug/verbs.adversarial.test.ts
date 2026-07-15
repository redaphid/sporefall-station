// Adversarial coverage for the verb bridge. This is a DEBUG SURFACE that takes
// untrusted lines off a socket, so every test here throws garbage at `runVerb`
// and asserts it fails CLEANLY (a thrown Error the transport turns into an
// `ok:false` reply) rather than crashing, corrupting global state, or silently
// doing the wrong thing.

import { afterEach, describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { createWorld, type World } from '../game/world'
import { encodeArg, toB64 } from './protocol'
import { runVerb, serializeEntity } from './verbs'

const world = (): World => createWorld(1234, 1)

describe('malformed verb lines', () => {
  it('rejects an unknown verb', () => {
    expect(() => runVerb(world(), 'frobnicate 1')).toThrow(/unknown verb/)
  })
  it('rejects empty and whitespace-only input', () => {
    expect(() => runVerb(world(), '')).toThrow(/unknown verb/)
    expect(() => runVerb(world(), '     ')).toThrow(/unknown verb/)
    expect(() => runVerb(world(), '\t\n ')).toThrow(/unknown verb/)
  })
  it('tolerates leading/trailing/interior whitespace in a valid verb', () => {
    const w = world()
    spawnNpc(w, 'cop', 0, 0)
    expect(JSON.parse(runVerb(w, '   state   ')).total).toBe(1)
    expect(JSON.parse(runVerb(w, 'spawn   npc    cop   3   4')).archetype).toBe('cop')
  })
  it('survives a very long line without crashing', () => {
    const w = world()
    // A megabyte of junk after a bad verb — must still be a clean throw.
    expect(() => runVerb(w, 'frob ' + 'x'.repeat(1_000_000))).toThrow(/unknown verb/)
  })
})

describe('get / entity id parsing', () => {
  it('rejects non-numeric ids', () => {
    expect(() => runVerb(world(), 'get abc')).toThrow(/expected a number/)
    expect(() => runVerb(world(), 'get 12x')).toThrow(/expected a number/)
  })
  it('rejects non-finite ids (Infinity / NaN / huge)', () => {
    expect(() => runVerb(world(), 'get 1e999')).toThrow(/expected a number/)
    expect(() => runVerb(world(), 'get NaN')).toThrow(/expected a number/)
    expect(() => runVerb(world(), 'get Infinity')).toThrow(/expected a number/)
  })
  it('reports a clean miss for a numeric id that does not exist', () => {
    expect(() => runVerb(world(), 'get 9999')).toThrow(/no entity/)
    expect(() => runVerb(world(), 'get -5')).toThrow(/no entity/)
    // Empty id coerces to 0, which is never a live id (ids start at 1).
    expect(() => runVerb(world(), 'get')).toThrow(/no entity/)
  })
})

describe('spawn', () => {
  it('rejects a missing archetype/kind (usage)', () => {
    expect(() => runVerb(world(), 'spawn')).toThrow(/usage/)
    expect(() => runVerb(world(), 'spawn npc')).toThrow(/usage/)
  })
  it('rejects missing / non-numeric / non-finite coords', () => {
    expect(() => runVerb(world(), 'spawn npc cop')).toThrow(/expected a number/)
    expect(() => runVerb(world(), 'spawn npc cop 1')).toThrow(/expected a number/)
    expect(() => runVerb(world(), 'spawn npc cop a b')).toThrow(/expected a number/)
    expect(() => runVerb(world(), 'spawn npc cop 1e999 0')).toThrow(/expected a number/)
  })
  it('falls back to a bare entity for an unknown npc archetype (no crash)', () => {
    const w = world()
    const out = JSON.parse(runVerb(w, 'spawn npc no_such_archetype 1 2'))
    expect(out.kind).toBe('npc')
    expect(out.archetype).toBe('no_such_archetype')
    expect(out.ai).toBeUndefined() // not wired — it isn't a real NPC def
    expect(out.pos).toEqual({ x: 1, y: 2 })
  })
  it('materializes an arbitrary kind via the generic fallback', () => {
    const w = world()
    const out = JSON.parse(runVerb(w, 'spawn projectile whatever 5 6'))
    expect(out.kind).toBe('projectile')
    expect(out.archetype).toBe('whatever')
  })
  it('allows huge but finite out-of-bounds coords (repro convenience)', () => {
    const w = world()
    const out = JSON.parse(runVerb(w, 'spawn npc cop 1e6 -1e6'))
    expect(out.pos).toEqual({ x: 1e6, y: -1e6 })
  })
  it('substitutes soldier for an unknown player class', () => {
    const w = world()
    const out = JSON.parse(runVerb(w, 'spawn player no_such_class 1 1'))
    expect(out.kind).toBe('player')
    expect(out.playerCtl.classId).toBe('soldier')
  })
})

describe('set — patch validation', () => {
  it('rejects invalid JSON cleanly', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    expect(() => runVerb(w, `set ${e.id} {not json}`)).toThrow()
    expect(() => runVerb(w, `set ${e.id} {"a":}`)).toThrow()
  })
  it('requires an id and a patch (usage)', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    expect(() => runVerb(w, `set ${e.id}`)).toThrow(/usage/)
  })
  it('rejects non-object JSON (number / string / array / null)', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    for (const bad of ['5', '"hi"', '[1,2,3]', 'null', 'true']) {
      expect(() => runVerb(w, `set ${e.id} ${encodeArg(bad)}`)).toThrow(/must be a JSON object/)
    }
    // An array patch must not splatter numeric-index keys onto the entity.
    expect((e as unknown as Record<string, unknown>)['0']).toBeUndefined()
  })
})

describe('set — prototype pollution (fixed bug)', () => {
  afterEach(() => {
    // Belt and suspenders: if any assertion above regressed, do not let the
    // poisoned prototype leak into the rest of the suite.
    delete (Object.prototype as Record<string, unknown>).polluted
  })

  it('does NOT pollute Object.prototype via __proto__', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    // Wrapped in b64 because the JSON has spaces; also proves the b64 path is
    // not an escape around the guard.
    runVerb(w, `set ${e.id} ${encodeArg('{ "__proto__": { "polluted": true } }')}`)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    // The entity itself is untouched — the forbidden key is simply dropped.
    expect((e as unknown as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does NOT pollute via a nested constructor.prototype patch', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    runVerb(w, `set ${e.id} ${encodeArg('{ "constructor": { "prototype": { "polluted": true } } }')}`)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // The real constructor is intact.
    expect(e.constructor).toBe(Object)
  })
})

describe('set — merge semantics', () => {
  it('deep-merges without clobbering sibling fields', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    const maxBefore = e.health!.max
    runVerb(w, `set ${e.id} {"health":{"hp":7}}`)
    expect(e.health!.hp).toBe(7)
    expect(e.health!.max).toBe(maxBefore) // sibling preserved by the merge
  })
  it('coerces string scalars to the field s existing type', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    runVerb(w, `set ${e.id} {"speed":"3.5"}`)
    expect(e.speed).toBe(3.5)
    // Booleans coerce from strings too.
    ;(e as unknown as { flammable?: boolean }).flammable = false
    runVerb(w, `set ${e.id} {"flammable":"true"}`)
    expect((e as unknown as { flammable: boolean }).flammable).toBe(true)
  })
  it('adds unknown/future fields verbatim and they survive a round-trip', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    runVerb(w, `set ${e.id} ${encodeArg('{ "futureThing": { "z": 42, "tags": ["a","b"] } }')}`)
    const back = JSON.parse(runVerb(w, `get ${e.id}`))
    expect(back.futureThing).toEqual({ z: 42, tags: ['a', 'b'] })
  })
  it('accepts a deeply nested patch', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    runVerb(w, `set ${e.id} ${encodeArg('{ "a": { "b": { "c": { "d": 1 } } } }')}`)
    expect(JSON.parse(runVerb(w, `get ${e.id}`)).a.b.c.d).toBe(1)
  })
  it('accepts a large valid payload', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    const big = { blob: Array.from({ length: 5000 }, (_, i) => i) }
    runVerb(w, `set ${e.id} ${encodeArg(JSON.stringify(big))}`)
    expect((JSON.parse(runVerb(w, `get ${e.id}`)).blob as number[]).length).toBe(5000)
  })
})

describe('set — base64 payloads', () => {
  it('accepts a b64-wrapped whitespace payload', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    runVerb(w, `set ${e.id} ${encodeArg('{ "health": { "hp": 3 } }')}`)
    expect(e.health!.hp).toBe(3)
  })
  it('rejects malformed base64 cleanly', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    expect(() => runVerb(w, `set ${e.id} b64:!!!!not_base64`)).toThrow()
  })
  it('rejects base64 that decodes to non-JSON', () => {
    const w = world()
    const e = spawnNpc(w, 'thug', 0, 0)
    expect(() => runVerb(w, `set ${e.id} b64:${toB64('hello not json')}`)).toThrow()
  })
})

describe('verbatim mirror edge cases', () => {
  it('throws (does not hang) on a circular entity graph', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    ;(e as unknown as { self?: unknown }).self = e // JSON.stringify cannot encode this
    expect(() => runVerb(w, `get ${e.id}`)).toThrow(/circular/i)
  })
  it('serializes an entity list on an empty world as []', () => {
    expect(JSON.parse(runVerb(world(), 'entities'))).toEqual([])
  })
  it('serializeEntity is a deep copy, not a live reference', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    const snap = serializeEntity(e)
    e.pos.x = 999
    expect((snap.pos as { x: number }).x).toBe(0) // snapshot frozen at capture
  })
})

describe('kill / teleport adversarial', () => {
  it('kill on a missing id is a clean miss', () => {
    expect(() => runVerb(world(), 'kill 4242')).toThrow(/no entity/)
  })
  it('teleport rejects missing/garbage coords before mutating', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 7, 8)
    expect(() => runVerb(w, `teleport ${e.id}`)).toThrow(/expected a number for x/)
    expect(() => runVerb(w, `teleport ${e.id} 1 z`)).toThrow(/expected a number for y/)
    // Failed teleport left the position untouched (no partial mutation).
    expect(e.pos).toEqual({ x: 7, y: 8 })
  })
  it('teleport clears interpolation so the sprite does not streak', () => {
    const w = world()
    const e = spawnNpc(w, 'cop', 0, 0)
    e.prevPos = { x: 0, y: 0 }
    runVerb(w, `teleport ${e.id} 20 30`)
    expect(e.pos).toEqual({ x: 20, y: 30 })
    expect(e.prevPos).toEqual({ x: 20, y: 30 })
  })
})

describe('command escape hatch', () => {
  it('rejects a bare command (usage)', () => {
    expect(() => runVerb(world(), 'command')).toThrow(/usage/)
  })
  it('forwards to the inner verb verbatim, including nested command', () => {
    const w = world()
    spawnNpc(w, 'cop', 0, 0)
    expect(JSON.parse(runVerb(w, 'command state')).total).toBe(1)
    expect(JSON.parse(runVerb(w, 'command command state')).total).toBe(1)
  })
  it('propagates the inner verb s error', () => {
    expect(() => runVerb(world(), 'command frobnicate')).toThrow(/unknown verb/)
  })
})
