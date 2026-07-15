// Adversarial coverage for the annotate / clearAnnotations / selection verbs —
// the debug surface takes untrusted lines off a socket, so garbage must fail
// CLEANLY (a thrown Error → ok:false reply), never crash or pollute globals.

import { afterEach, describe, expect, it } from 'vitest'
import { spawnNpc } from '../game/populate'
import { setSelected } from '../game/select'
import { createWorld, type World } from '../game/world'
import { encodeArg } from './protocol'
import { runVerb, verbName, WRITE_VERBS } from './verbs'

const world = (): World => createWorld(1234, 1)

describe('annotate — happy path', () => {
  it('adds a single entity-anchored label and reports the id', () => {
    const w = world()
    const out = JSON.parse(runVerb(w, `annotate ${encodeArg('{ "kind": "label", "targetId": 5, "text": "boss" }')}`))
    expect(out.added).toBe(1)
    expect(w.annotations).toHaveLength(1)
    expect(w.annotations[0]).toMatchObject({ kind: 'label', targetId: 5, text: 'boss' })
  })

  it('adds many from a JSON array in one call', () => {
    const w = world()
    const out = JSON.parse(
      runVerb(w, `annotate ${encodeArg('[{ "kind": "pin", "x": 1, "y": 2 }, { "kind": "text", "text": "hi" }]')}`),
    )
    expect(out.added).toBe(2)
    expect(w.annotations).toHaveLength(2)
  })

  it('is registered as a deferred WRITE verb', () => {
    expect(WRITE_VERBS.has('annotate')).toBe(true)
    expect(WRITE_VERBS.has('clearAnnotations')).toBe(true)
    expect(verbName('annotate {}')).toBe('annotate')
  })
})

describe('annotate — adversarial', () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted
  })

  it('rejects a bare annotate (usage)', () => {
    expect(() => runVerb(world(), 'annotate')).toThrow(/usage/)
  })

  it('rejects malformed JSON', () => {
    expect(() => runVerb(world(), 'annotate {not json}')).toThrow()
    expect(() => runVerb(world(), 'annotate [1,')).toThrow()
  })

  it('rejects an unknown kind and a non-object', () => {
    expect(() => runVerb(world(), `annotate ${encodeArg('{ "kind": "explosion", "x": 0, "y": 0 }')}`)).toThrow(/kind/)
    expect(() => runVerb(world(), 'annotate 5')).toThrow()
    expect(() => runVerb(world(), 'annotate null')).toThrow()
  })

  it('rejects a non-text kind with no position', () => {
    expect(() => runVerb(world(), `annotate ${encodeArg('{ "kind": "label", "text": "x" }')}`)).toThrow(/targetId or an x\/y/)
  })

  it('rejects oversized text without wedging it into world state', () => {
    const w = world()
    expect(() => runVerb(w, `annotate ${encodeArg(JSON.stringify({ kind: 'text', text: 'x'.repeat(1000) }))}`)).toThrow(/too long/)
    expect(w.annotations).toHaveLength(0) // nothing partially added
  })

  it('does NOT pollute Object.prototype via __proto__ in the payload', () => {
    const w = world()
    expect(() =>
      runVerb(w, 'annotate {"kind":"text","text":"x","__proto__":{"polluted":true}}'),
    ).toThrow(/forbidden key/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    expect(w.annotations).toHaveLength(0)
  })

  it('survives a megabyte payload without crashing (clean throw)', () => {
    expect(() => runVerb(world(), 'annotate ' + '{'.repeat(1_000_000))).toThrow()
  })
})

describe('clearAnnotations', () => {
  it('clears all, then by id (numeric and string)', () => {
    const w = world()
    runVerb(w, `annotate ${encodeArg('[{ "id": 1, "kind": "pin", "x": 0, "y": 0 }, { "id": "z", "kind": "pin", "x": 1, "y": 1 }]')}`)
    expect(JSON.parse(runVerb(w, 'clearAnnotations 1')).removed).toBe(1)
    expect(w.annotations.map((a) => a.id)).toEqual(['z'])
    expect(JSON.parse(runVerb(w, 'clearAnnotations z')).removed).toBe(1)
    expect(w.annotations).toHaveLength(0)
    // Clearing an empty set is a clean no-op.
    expect(JSON.parse(runVerb(w, 'clearAnnotations')).removed).toBe(0)
  })
})

describe('selection via the general entities/state verbs', () => {
  it('`entities selected` returns only the selected entities', () => {
    const w = world()
    const a = spawnNpc(w, 'cop', 1, 1)
    spawnNpc(w, 'thug', 2, 2)
    setSelected(a, true)
    const got = JSON.parse(runVerb(w, 'entities selected'))
    expect(got).toHaveLength(1)
    expect(got[0].id).toBe(a.id)
  })

  it('`entities <garbage>` is rejected with usage', () => {
    expect(() => runVerb(world(), 'entities frobnicate')).toThrow(/usage/)
  })

  it('`state` reports selectedIds and the annotation count', () => {
    const w = world()
    const a = spawnNpc(w, 'cop', 1, 1)
    setSelected(a, true)
    runVerb(w, `annotate ${encodeArg('{ "kind": "text", "text": "hi" }')}`)
    const st = JSON.parse(runVerb(w, 'state'))
    expect(st.selectedIds).toEqual([a.id])
    expect(st.annotations).toBe(1)
  })
})
