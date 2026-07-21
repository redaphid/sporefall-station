import { describe, expect, it } from 'vitest'
import { decodeAddressed, encodeAddressed, MAX_PEER_ID_LEN, parseControl } from './wsWire'

describe('addressed frame codec', () => {
  it('round-trips id + payload', () => {
    const payload = new Uint8Array([1, 2, 3, 255, 0, 42])
    const { id, payload: out } = decodeAddressed(encodeAddressed('c-abcd1234', payload))
    expect(id).toBe('c-abcd1234')
    expect([...out]).toEqual([...payload])
  })

  it('round-trips an empty payload (control-less data frame)', () => {
    const { id, payload } = decodeAddressed(encodeAddressed('host', new Uint8Array(0)))
    expect(id).toBe('host')
    expect(payload.length).toBe(0)
  })

  it('handles multi-byte utf-8 ids', () => {
    const { id } = decodeAddressed(encodeAddressed('naïve-☃', new Uint8Array([7])))
    expect(id).toBe('naïve-☃')
  })

  it('decoded payload is detached — mutating it does not touch the frame', () => {
    const frame = encodeAddressed('c-1', new Uint8Array([9, 9]))
    const { payload } = decodeAddressed(frame)
    payload[0] = 0
    // re-decoding the original frame still yields the original bytes
    expect([...decodeAddressed(frame).payload]).toEqual([9, 9])
  })

  it('rejects an empty id (nothing to address)', () => {
    expect(() => encodeAddressed('', new Uint8Array([1]))).toThrow(RangeError)
  })

  it('rejects an id longer than the 1-byte length header allows', () => {
    const tooLong = 'x'.repeat(MAX_PEER_ID_LEN + 1)
    expect(() => encodeAddressed(tooLong, new Uint8Array([1]))).toThrow(RangeError)
  })

  it('accepts an id exactly at the length limit', () => {
    const maxId = 'x'.repeat(MAX_PEER_ID_LEN)
    expect(decodeAddressed(encodeAddressed(maxId, new Uint8Array([1]))).id).toBe(maxId)
  })
})

describe('control frame parsing', () => {
  it('parses each control variant', () => {
    expect(parseControl(JSON.stringify({ t: 'host+' }))).toEqual({ t: 'host+' })
    expect(parseControl(JSON.stringify({ t: 'host-', reason: 'error' }))).toEqual({ t: 'host-', reason: 'error' })
    expect(parseControl(JSON.stringify({ t: 'peer+', id: 'c-1' }))).toEqual({ t: 'peer+', id: 'c-1' })
    expect(parseControl(JSON.stringify({ t: 'peer-', id: 'c-1', reason: 'remote' }))).toEqual({
      t: 'peer-',
      id: 'c-1',
      reason: 'remote',
    })
  })

  it('rejects non-control json and garbage', () => {
    expect(parseControl('not json')).toBeNull()
    expect(parseControl(JSON.stringify({ t: 'nope' }))).toBeNull()
    expect(parseControl(JSON.stringify({ hello: 1 }))).toBeNull()
    expect(parseControl('42')).toBeNull()
  })
})
