// Boundary coverage for the wire envelope + base64 helpers. These strings come
// off a socket, so exercise empty/unicode/binary-ish inputs and confirm the
// encode/decode pair is a faithful round-trip.

import { describe, expect, it } from 'vitest'
import { DEFAULT_HUB_PORT, decodeArg, encodeArg, fromB64, hubUrl, toB64 } from './protocol'

describe('toB64 / fromB64 round-trip', () => {
  const cases: Record<string, string> = {
    empty: '',
    ascii: 'the quick brown fox',
    json: '{"health":{"hp":3}}',
    accents: 'naïve café résumé',
    emoji: 'skull 💀 fire 🔥 ok 👍',
    cjk: '日本語のテスト',
    newlines: 'line1\nline2\r\ntab\tend',
    'high bytes': Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join(''),
  }
  for (const [name, s] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      expect(fromB64(toB64(s))).toBe(s)
    })
  }
  it('produces ascii-only base64 output', () => {
    const out = toB64('naïve 💀 日本語')
    expect(out).toMatch(/^[A-Za-z0-9+/]*=*$/)
  })
})

describe('encodeArg / decodeArg', () => {
  it('leaves whitespace-free payloads untouched (no b64 wrap)', () => {
    expect(encodeArg('{"hp":3}')).toBe('{"hp":3}')
    expect(decodeArg('{"hp":3}')).toBe('{"hp":3}')
  })
  it('wraps payloads containing whitespace and decodes them back', () => {
    for (const s of ['{ "hp": 3 }', 'a\tb', 'line\nbreak', '  leading']) {
      const enc = encodeArg(s)
      expect(enc.startsWith('b64:')).toBe(true)
      expect(decodeArg(enc)).toBe(s)
    }
  })
  it('round-trips unicode through encode/decode', () => {
    const s = '{ "name": "café 💀" }'
    expect(decodeArg(encodeArg(s))).toBe(s)
  })
  it('decodes a raw payload that was not wrapped', () => {
    expect(decodeArg('plain')).toBe('plain')
  })
  it('throws on malformed base64 (documents the failure mode)', () => {
    expect(() => decodeArg('b64:@@@notbase64@@@')).toThrow()
  })
  it('KNOWN AMBIGUITY: a raw payload literally starting with b64: is decoded, not passed through', () => {
    // encodeArg never emits this for a whitespace-free string, but a caller that
    // hand-crafts a literal "b64:<valid base64>" hits the prefix heuristic and
    // gets the DECODED bytes back, not the verbatim string. Documented quirk.
    expect(decodeArg(`b64:${toB64('hello')}`)).toBe('hello')
  })
})

describe('hubUrl', () => {
  it('uses the default port when none is given', () => {
    expect(hubUrl('192.168.1.5')).toBe(`ws://192.168.1.5:${DEFAULT_HUB_PORT}`)
  })
  it('honours an explicit port', () => {
    expect(hubUrl('localhost', 9999)).toBe('ws://localhost:9999')
  })
})
