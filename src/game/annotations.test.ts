import { describe, expect, it } from 'vitest'
import {
  addAnnotations,
  clearAnnotations,
  nextAnnotationId,
  sanitizeAnnotation,
  visibleAnnotations,
} from './annotations'
import { deserializeWorld, serializeWorld } from './serialize'
import { expectWorldEqual } from './testkit'
import type { Annotation } from './types'
import { createWorld, type World } from './world'

const world = (): World => createWorld(1234, 1)
const id = () => 1

describe('addAnnotations + world state', () => {
  it('starts empty and appends sanitized copies', () => {
    const w = world()
    expect(w.annotations).toEqual([])
    const added = addAnnotations(w, { kind: 'label', targetId: 5, text: 'boss' })
    expect(added).toHaveLength(1)
    expect(w.annotations).toHaveLength(1)
    expect(w.annotations[0]).toMatchObject({ kind: 'label', targetId: 5, text: 'boss' })
  })

  it('adds many in one call and gives each a distinct auto id', () => {
    const w = world()
    addAnnotations(w, [
      { kind: 'pin', x: 1, y: 2 },
      { kind: 'pin', x: 3, y: 4 },
      { kind: 'text', text: 'hi' },
    ])
    const ids = w.annotations.map((a) => a.id)
    expect(new Set(ids).size).toBe(3) // all distinct
  })

  it('honours an explicit id and keeps auto ids clear of it', () => {
    const w = world()
    addAnnotations(w, { id: 99, kind: 'pin', x: 0, y: 0 })
    expect(nextAnnotationId(w)).toBe(100)
    addAnnotations(w, { kind: 'pin', x: 1, y: 1 })
    expect(w.annotations[1].id).toBe(100)
  })
})

describe('serialize round-trip (annotations ride along in world state)', () => {
  it('round-trips a world carrying annotations byte-for-byte', () => {
    const w = world()
    addAnnotations(w, [
      { kind: 'label', targetId: 7, text: 'target', color: '#f00' },
      { kind: 'circle', x: 10, y: 12, radius: 3, text: 'danger', ttlTick: 200 },
      { kind: 'arrow', x: 1, y: 1, x2: 5, y2: 5, text: 'go here' },
    ])
    const restored = deserializeWorld(serializeWorld(w))
    expect(restored.annotations).toEqual(w.annotations)
    expectWorldEqual(restored, w)
  })

  it('an empty annotations array serializes AWAY (no snapshot bloat, back-compat)', () => {
    const j = serializeWorld(world())
    expect('annotations' in j).toBe(false)
    // …and restores as an empty array, not undefined.
    expect(deserializeWorld(j).annotations).toEqual([])
  })
})

describe('ttl expiry (pure, render-time — the sim never prunes)', () => {
  it('hides an annotation once the tick reaches its ttlTick', () => {
    const anns: Annotation[] = [
      { id: 1, kind: 'text', text: 'permanent' },
      { id: 2, kind: 'text', text: 'fades', ttlTick: 10 },
    ]
    expect(visibleAnnotations(anns, 9).map((a) => a.id)).toEqual([1, 2])
    expect(visibleAnnotations(anns, 10).map((a) => a.id)).toEqual([1]) // expired at exactly ttlTick
    expect(visibleAnnotations(anns, 999).map((a) => a.id)).toEqual([1])
  })
})

describe('clearAnnotations', () => {
  it('clears all with no id', () => {
    const w = world()
    addAnnotations(w, [{ kind: 'pin', x: 0, y: 0 }, { kind: 'pin', x: 1, y: 1 }])
    expect(clearAnnotations(w)).toBe(2)
    expect(w.annotations).toEqual([])
  })

  it('clears exactly one by id (numeric or string)', () => {
    const w = world()
    addAnnotations(w, [{ id: 'a', kind: 'pin', x: 0, y: 0 }, { id: 2, kind: 'pin', x: 1, y: 1 }])
    expect(clearAnnotations(w, 'a')).toBe(1)
    expect(w.annotations.map((a) => a.id)).toEqual([2])
    expect(clearAnnotations(w, 'missing')).toBe(0)
  })
})

describe('sanitizeAnnotation — adversarial validation', () => {
  it('rejects a non-object', () => {
    for (const bad of [5, 'x', null, [1, 2]]) expect(() => sanitizeAnnotation(bad, id)).toThrow()
  })

  it('rejects an unknown / missing kind', () => {
    expect(() => sanitizeAnnotation({ kind: 'explosion' }, id)).toThrow(/kind/)
    expect(() => sanitizeAnnotation({ text: 'no kind' }, id)).toThrow(/kind/)
  })

  it('requires a position (targetId or x/y) for non-text kinds', () => {
    expect(() => sanitizeAnnotation({ kind: 'label', text: 'x' }, id)).toThrow(/targetId or an x\/y/)
    // …but the text banner needs neither.
    expect(sanitizeAnnotation({ kind: 'text', text: 'banner' }, id)).toMatchObject({ kind: 'text' })
    // targetId alone is enough (the engine-positioned form).
    expect(sanitizeAnnotation({ kind: 'label', targetId: 3 }, id)).toMatchObject({ targetId: 3 })
  })

  it('rejects non-finite numeric fields', () => {
    for (const k of ['x', 'y', 'radius', 'targetId', 'ttlTick'])
      expect(() => sanitizeAnnotation({ kind: 'pin', x: 0, y: 0, [k]: Infinity }, id)).toThrow()
    expect(() => sanitizeAnnotation({ kind: 'pin', x: NaN, y: 0 }, id)).toThrow()
  })

  it('rejects oversized text / color and empty/huge ids', () => {
    expect(() => sanitizeAnnotation({ kind: 'text', text: 'x'.repeat(500) }, id)).toThrow(/too long/)
    expect(() => sanitizeAnnotation({ kind: 'text', text: 'hi', color: 'c'.repeat(200) }, id)).toThrow(/too long/)
    expect(() => sanitizeAnnotation({ kind: 'text', id: '' }, id)).toThrow()
    expect(() => sanitizeAnnotation({ kind: 'text', id: 'z'.repeat(500) }, id)).toThrow()
  })

  it('is prototype-pollution-proof: only whitelisted fields are ever read', () => {
    const evil = JSON.parse('{ "kind": "text", "text": "ok", "__proto__": { "polluted": true } }')
    const out = sanitizeAnnotation(evil, id)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // The sanitized copy carries none of the junk — just the known fields.
    expect(Object.keys(out).sort()).toEqual(['id', 'kind', 'text'])
  })

  it('coerces text-banner text/color through cleanly and drops nothing valid', () => {
    const out = sanitizeAnnotation({ kind: 'arrow', x: 1, y: 2, x2: 3, y2: 4, radius: 2, color: '#0f0', text: 'go', ttlTick: 5, id: 7 }, id)
    expect(out).toEqual({ id: 7, kind: 'arrow', x: 1, y: 2, x2: 3, y2: 4, radius: 2, color: '#0f0', text: 'go', ttlTick: 5 })
  })
})
