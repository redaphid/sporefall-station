import { describe, expect, it } from 'vitest'
import { encodeAddressed } from '../net/transport/wsWire'
import {
  type Action,
  admit,
  CLOSE_HOST_TAKEN,
  CLOSE_REJECTED,
  CLOSE_TOO_BIG,
  type Conn,
  MAX_CONTROL_FRAME,
  MAX_DATA_FRAME,
  MAX_ROOM_CLIENTS,
  planClose,
  planData,
  planFrame,
  planOpen,
} from './roomRelay'
import { MAX_PLAYERS } from '../net/types'

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

  it('client joining a room with no host is told so at once', () => {
    expect(planOpen([client('A', 'c-a')], 'A')).toEqual([{ kind: 'send', conn: 'A', data: { t: 'nohost' } }])
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

describe('admit — refused before the upgrade', () => {
  const room = (n: number): Conn[] => [host('H'), ...Array.from({ length: n }, (_, i) => client(`C${i}`, `c-${i}`))]

  it('the room holds the game ceiling of clients and refuses the next with 409', () => {
    expect(MAX_ROOM_CLIENTS).toBe(MAX_PLAYERS)
    expect(admit(room(MAX_ROOM_CLIENTS - 1), 'client')).toEqual({ ok: true })
    expect(admit(room(MAX_ROOM_CLIENTS), 'client')).toEqual({ ok: false, status: 409, reason: 'room is full' })
  })

  it('a second host is refused, and a full room still takes its host back', () => {
    expect(admit(room(0), 'host')).toEqual({ ok: false, status: 409, reason: 'room already has a host' })
    expect(admit(room(MAX_ROOM_CLIENTS).slice(1), 'host')).toEqual({ ok: true })
  })
})

describe('planFrame — sizes and host commands', () => {
  const state = [host('H'), client('A', 'c-a'), client('B', 'c-b')]

  it('routes a data frame right at the limit and closes the sender one byte over', () => {
    const atLimit = encodeAddressed('c-a', new Uint8Array(MAX_DATA_FRAME - 1 - 'c-a'.length))
    expect(atLimit.length).toBe(MAX_DATA_FRAME)
    const routed = planFrame(state, 'H', atLimit)
    expect(routed).toHaveLength(1)
    expect(routed[0]).toMatchObject({ kind: 'send', conn: 'A' })
    expect(planFrame(state, 'A', new Uint8Array(MAX_DATA_FRAME + 1))).toEqual([
      { kind: 'close', conn: 'A', code: CLOSE_TOO_BIG, reason: 'frame too big' },
    ])
  })

  it('closes the sender of an oversized text frame, host or client', () => {
    const big = 'x'.repeat(MAX_CONTROL_FRAME + 1)
    for (const conn of ['H', 'A'])
      expect(planFrame(state, conn, big)).toEqual([{ kind: 'close', conn, code: CLOSE_TOO_BIG, reason: 'frame too big' }])
    expect(planFrame(state, 'A', 'x'.repeat(MAX_CONTROL_FRAME))).toEqual([])
  })

  it("a host's drop closes exactly that client", () => {
    expect(planFrame(state, 'H', JSON.stringify({ t: 'drop', id: 'c-b' }))).toEqual([
      { kind: 'close', conn: 'B', code: CLOSE_REJECTED, reason: 'refused by host' },
    ])
  })

  it.each([
    ['from a client', 'A', { t: 'drop', id: 'c-b' }],
    ['naming an unknown peer', 'H', { t: 'drop', id: 'c-zz' }],
    ['naming no peer', 'H', { t: 'drop' }],
    ['of another kind', 'H', { t: 'host-', reason: 'remote' }],
  ])('a drop %s does nothing', (_label, from, cmd) => {
    expect(planFrame(state, from, JSON.stringify(cmd))).toEqual([])
  })

  it('garbage text is ignored, not routed', () => {
    expect(planFrame(state, 'H', '{not json')).toEqual([])
  })
})
