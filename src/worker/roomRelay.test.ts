import { describe, expect, it } from 'vitest'
import { encodeAddressed } from '../net/transport/wsWire'
import { type Action, CLOSE_HOST_TAKEN, type Conn, planClose, planData, planOpen } from './roomRelay'

const host = (conn: string): Conn => ({ conn, role: 'host' })
const client = (conn: string, clientId: string): Conn => ({ conn, role: 'client', clientId })

/** Pick out send-actions carrying a control object (not binary), for terse asserts. */
const controls = (actions: Action[]): { conn: string; data: unknown }[] =>
  actions
    .filter((a): a is Extract<Action, { kind: 'send' }> => a.kind === 'send' && !(a.data instanceof Uint8Array))
    .map((a) => ({ conn: a.conn, data: a.data }))

describe('planOpen — membership introductions', () => {
  it('host joining an empty room announces nothing', () => {
    expect(planOpen([host('H')], 'H')).toEqual([])
  })

  it('client joining before the host waits silently', () => {
    expect(planOpen([client('A', 'c-a')], 'A')).toEqual([])
  })

  it('client joining an occupied room introduces both directions', () => {
    const state = [host('H'), client('A', 'c-a')]
    expect(planOpen(state, 'A')).toEqual([
      { kind: 'send', conn: 'H', data: { t: 'peer+', id: 'c-a' } },
      { kind: 'send', conn: 'A', data: { t: 'host+' } },
    ])
  })

  it('host arriving late is introduced to every waiting client', () => {
    const state = [client('A', 'c-a'), client('B', 'c-b'), host('H')]
    const out = planOpen(state, 'H')
    // host learns of both clients; both clients learn the host is present
    expect(out).toContainEqual({ kind: 'send', conn: 'H', data: { t: 'peer+', id: 'c-a' } })
    expect(out).toContainEqual({ kind: 'send', conn: 'H', data: { t: 'peer+', id: 'c-b' } })
    expect(out).toContainEqual({ kind: 'send', conn: 'A', data: { t: 'host+' } })
    expect(out).toContainEqual({ kind: 'send', conn: 'B', data: { t: 'host+' } })
  })

  it('a second host is refused, not merged', () => {
    const state = [host('H1'), host('H2')]
    expect(planOpen(state, 'H2')).toEqual([{ kind: 'close', conn: 'H2', code: CLOSE_HOST_TAKEN, reason: expect.any(String) }])
  })

  it('ignores an open for a conn absent from the snapshot', () => {
    expect(planOpen([host('H')], 'ghost')).toEqual([])
  })
})

describe('planData — one-hop routing', () => {
  const state = [host('H'), client('A', 'c-a'), client('B', 'c-b')]

  it('routes a client payload to the host, re-addressed with the sender id', () => {
    const payload = new Uint8Array([1, 2, 3])
    const out = planData(state, 'A', payload)
    expect(out).toHaveLength(1)
    const a = out[0]
    expect(a.kind).toBe('send')
    if (a.kind === 'send' && a.data instanceof Uint8Array) {
      expect(a.conn).toBe('H')
      expect([...a.data]).toEqual([...encodeAddressed('c-a', payload)])
    } else throw new Error('expected binary send to host')
  })

  it('routes a host frame to the addressed client as a bare payload', () => {
    const payload = new Uint8Array([9, 8, 7])
    const out = planData(state, 'H', encodeAddressed('c-b', payload))
    expect(out).toHaveLength(1)
    const a = out[0]
    if (a.kind === 'send' && a.data instanceof Uint8Array) {
      expect(a.conn).toBe('B')
      expect([...a.data]).toEqual([9, 8, 7])
    } else throw new Error('expected binary send to B')
  })

  it('drops a host frame addressed to an unknown client', () => {
    expect(planData(state, 'H', encodeAddressed('c-ghost', new Uint8Array([1])))).toEqual([])
  })

  it('drops a client payload when no host is present', () => {
    expect(planData([client('A', 'c-a')], 'A', new Uint8Array([1]))).toEqual([])
  })

  it('drops data from an unknown sender', () => {
    expect(planData(state, 'nobody', new Uint8Array([1]))).toEqual([])
  })
})

describe('planClose — departures', () => {
  it('a departing client notifies only the host', () => {
    const state = [host('H'), client('A', 'c-a'), client('B', 'c-b')]
    expect(planClose(state, 'A')).toEqual([{ kind: 'send', conn: 'H', data: { t: 'peer-', id: 'c-a', reason: 'remote' } }])
  })

  it('a departing host notifies every client', () => {
    const state = [host('H'), client('A', 'c-a'), client('B', 'c-b')]
    const out = controls(planClose(state, 'H', 'error'))
    expect(out).toEqual([
      { conn: 'A', data: { t: 'host-', reason: 'error' } },
      { conn: 'B', data: { t: 'host-', reason: 'error' } },
    ])
  })

  it('a client leaving with no host present is a no-op', () => {
    expect(planClose([client('A', 'c-a')], 'A')).toEqual([])
  })

  it('ignores a close for an unknown conn', () => {
    expect(planClose([host('H')], 'ghost')).toEqual([])
  })

  it('defaults the drop reason to remote', () => {
    const out = planClose([host('H'), client('A', 'c-a')], 'A')
    expect(out[0]).toMatchObject({ data: { reason: 'remote' } })
  })
})
