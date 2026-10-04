import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyInput } from '../game/types'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { frameMessage, StreamReader } from '../net/framing/chunkedStream'
import type { GameStartMsg, GoMsg, PingMsg, WelcomeMsg } from '../net/protocol/messages'
import { isKnownMsgType, MsgType, type DropReason, type LinkMedium, type Transport, type TransportEvent } from '../net/types'
import { DEGRADED_AFTER_MS, linkChip, linkHealth, PING_INTERVAL_MS, STALLED_AFTER_MS } from './linkHealth'
import { NetClientSession, RECONNECT_GIVE_UP_MS } from './netClient'

/**
 * The client's online link watchdog, driven against a scripted host: the test
 * speaks the host's half of the protocol byte for byte, so no world is built
 * here at all. Time is a hand-cranked clock plus vitest's fake timers (the
 * reconnect loop sleeps on setTimeout), always advanced together.
 */

const MAX_PACKET = 180

interface Rig {
  client: NetClientSession
  sent: Uint8Array[]
  reconnects: number
  /** The host's half: frame `msg` and deliver it to the client. */
  hostSays: (msg: Uint8Array) => void
  drop: (reason: DropReason) => void
  /** What the relay says when a reconnect opens: the host is there, it has
   * left ('nohost', reported as a `left` drop), or nothing arrives in time. */
  onReopen: { value: 'host' | 'nohost' | 'silent' }
  advance: (ms: number) => Promise<void>
}

let clock = 0

const rig = (medium: LinkMedium): Rig => {
  let handler: ((e: TransportEvent) => void) | null = null
  const sent: Uint8Array[] = []
  const reader = new StreamReader({ isValidStart: isKnownMsgType })
  const onReopen: Rig['onReopen'] = { value: 'host' }
  const r: Rig = {
    client: undefined as unknown as NetClientSession,
    sent,
    reconnects: 0,
    hostSays: (msg) => {
      for (const bytes of frameMessage(msg, MAX_PACKET)) handler?.({ type: 'data', peer: 'host', bytes })
    },
    drop: (reason) => handler?.({ type: 'peerDisconnected', peer: 'host', reason }),
    onReopen,
    advance: async (ms) => {
      const step = 100
      for (let done = 0; done < ms; done += step) {
        clock += Math.min(step, ms - done)
        await vi.advanceTimersByTimeAsync(Math.min(step, ms - done))
        r.client.tick()
      }
    },
  }
  let linked = true
  const transport: Transport = {
    role: 'client',
    medium,
    maxPacket: MAX_PACKET,
    start: async () => {},
    stop: async () => {},
    sendPacket: async (_peer, bytes) => {
      reader.push(bytes, (m) => sent.push(m))
    },
    on: (h) => {
      handler = h
      return () => {}
    },
    peers: () => (linked ? ['host'] : []),
    reconnect: async () => {
      r.reconnects++
      linked = onReopen.value === 'host'
      if (onReopen.value === 'host') handler?.({ type: 'peerConnected', peer: 'host' })
      if (onReopen.value === 'nohost') handler?.({ type: 'peerDisconnected', peer: 'host', reason: 'left' })
    },
  }
  r.client = new NetClientSession('Guest', { sample: () => emptyInput() }, transport, () => clock)
  return r
}

/** Walk the scripted host through Hello → Welcome → GameStart → Go. */
const admit = async (r: Rig): Promise<void> => {
  await r.client.start()
  ;(r.client as unknown as { onConnected: () => void }).onConnected()
  await vi.advanceTimersByTimeAsync(0)
  const welcome: WelcomeMsg = { slot: 1, token: 'tok', players: [] } as unknown as WelcomeMsg
  r.hostSays(encodeJson(MsgType.Welcome, welcome))
  const start: GameStartMsg = { seed: 7, epoch: 0, players: [], floor: 1 }
  r.hostSays(encodeJson(MsgType.GameStart, start))
  const go: GoMsg = { startTick: 0, entityIds: { 1: 42 } }
  r.hostSays(encodeJson(MsgType.Go, go))
  expect(r.client.phase).toBe('playing')
}

const pings = (r: Rig): PingMsg[] => r.sent.filter((m) => m[0] === MsgType.Ping).map((m) => decodeJson<PingMsg>(m))

beforeEach(() => {
  clock = 0
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('linkHealth', () => {
  it.each([
    [0, 'good'],
    [DEGRADED_AFTER_MS - 1, 'good'],
    [DEGRADED_AFTER_MS, 'degraded'],
    [STALLED_AFTER_MS - 1, 'degraded'],
    [STALLED_AFTER_MS, 'stalled'],
    [Number.POSITIVE_INFINITY, 'stalled'],
  ] as const)('%d ms of silence is %s', (ms, health) => {
    expect(linkHealth(ms)).toBe(health)
  })

  it('the chip shows the round trip when healthy and a warning otherwise', () => {
    expect(linkChip({ health: 'good', rttMs: 83.6, session: 'live' })).toEqual({ tone: 'good', text: '84 ms' })
    expect(linkChip({ health: 'good', rttMs: 400, session: 'live' }).tone).toBe('fair')
    expect(linkChip({ health: 'good', rttMs: null, session: 'live' }).text).toBe('Online')
    expect(linkChip({ health: 'degraded', rttMs: 40, session: 'live' })).toEqual({ tone: 'bad', text: 'Weak connection' })
    expect(linkChip({ health: 'good', rttMs: 40, session: 'reconnecting' }).text).toBe('Reconnecting…')
    expect(linkChip({ health: 'good', rttMs: 40, session: 'ended' })).toEqual({ tone: 'bad', text: 'Disconnected' })
  })

  it('the chip names the path when the transport has one', () => {
    expect(linkChip({ health: 'good', rttMs: 41.7, path: 'p2p', session: 'live' })).toEqual({ tone: 'good', text: 'P2P 42 ms' })
    expect(linkChip({ health: 'good', rttMs: 88, path: 'relay', session: 'live' })).toEqual({ tone: 'good', text: 'Relay 88 ms' })
    expect(linkChip({ health: 'good', rttMs: null, path: 'relay', session: 'live' })).toEqual({ tone: 'fair', text: 'Relay' })
    expect(linkChip({ health: 'degraded', rttMs: 40, path: 'p2p', session: 'live' }).text).toBe('Weak connection')
  })
})

describe('online client: silence on an open socket', () => {
  it('reads degraded after 2 s, then reconnects after 5 s, with the socket never closing', async () => {
    const r = rig('online')
    await admit(r)
    await r.advance(DEGRADED_AFTER_MS - 100)
    expect(r.client.linkStatus().health).toBe('good')
    await r.advance(200)
    expect(r.client.linkStatus().health).toBe('degraded')
    expect(r.client.phase).toBe('playing')
    await r.advance(STALLED_AFTER_MS - DEGRADED_AFTER_MS)
    expect(r.client.phase).toBe('reconnecting')
    expect(r.client.renderView().missionText).not.toMatch(/bluetooth/i)
    await r.advance(3000)
    expect(r.reconnects).toBe(1)
  })

  it('steady traffic keeps the link good for as long as it flows', async () => {
    const r = rig('online')
    await admit(r)
    for (let s = 0; s < 20; s++) {
      await r.advance(900)
      r.hostSays(encodeJson(MsgType.Pong, { t: clock - 50 }))
    }
    expect(r.client.phase).toBe('playing')
    expect(r.client.linkStatus()).toEqual({ health: 'good', rttMs: 50, session: 'live' })
  })

  it('pings once a second and reports its round trip in the next ping', async () => {
    const r = rig('online')
    await admit(r)
    await r.advance(PING_INTERVAL_MS / 2)
    expect(pings(r)).toHaveLength(1)
    const first = pings(r)[0]
    expect(first.rtt).toBeUndefined()
    clock = first.t + 120
    r.hostSays(encodeJson(MsgType.Pong, { t: first.t }))
    expect(r.client.linkStatus().rttMs).toBe(120)
    await r.advance(PING_INTERVAL_MS)
    expect(pings(r).length).toBeGreaterThanOrEqual(2)
    expect(pings(r)[1].rtt).toBe(120)
  })

  it("a reconnect where the relay says there is no host ends as host left", async () => {
    const r = rig('online')
    await admit(r)
    r.onReopen.value = 'nohost'
    await r.advance(STALLED_AFTER_MS + 2000 + 200)
    expect(r.reconnects).toBe(1)
    expect(r.client.phase).toBe('ended')
    expect(r.client.hostLeft).toBe(true)
  })

  it('a reconnect that hears nothing in time keeps trying: a late frame never ends the run', async () => {
    const r = rig('online')
    await admit(r)
    r.onReopen.value = 'silent'
    await r.advance(STALLED_AFTER_MS + 20_000)
    expect(r.client.phase).toBe('reconnecting')
    expect(r.client.hostLeft).toBe(false)
    expect(r.reconnects).toBeGreaterThan(3)
    r.onReopen.value = 'host'
    await r.advance(3500)
    r.hostSays(encodeJson(MsgType.Welcome, { slot: 1, token: 'tok', players: [] }))
    r.hostSays(encodeJson(MsgType.GameStart, { seed: 7, players: [], floor: 1 }))
    r.hostSays(encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 42 } }))
    expect(r.client.phase).toBe('playing')
  })

  it('a host the relay still lists but that never answers gives up as a lost connection', async () => {
    const r = rig('online')
    await admit(r)
    await r.advance(RECONNECT_GIVE_UP_MS - 1000)
    expect(r.client.phase).toBe('reconnecting')
    await r.advance(2000)
    expect(r.client.phase).toBe('ended')
    expect(r.client.hostLeft).toBe(false)
    expect(r.client.renderView().missionText).toBe('Lost the connection to the host')
  })

  it('traffic after a stall-triggered rejoin returns the client to play', async () => {
    const r = rig('online')
    await admit(r)
    await r.advance(STALLED_AFTER_MS + 2500)
    expect(r.client.phase).toBe('reconnecting')
    r.hostSays(encodeJson(MsgType.Welcome, { slot: 1, token: 'tok', players: [] }))
    r.hostSays(encodeJson(MsgType.GameStart, { epoch: 0, seed: 7, players: [], floor: 1 }))
    r.hostSays(encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 42 } }))
    expect(r.client.phase).toBe('playing')
    await r.advance(1000)
    expect(r.client.linkStatus().health).toBe('good')
  })
})

describe('host departure', () => {
  it.each(['online', 'bluetooth', 'local'] as const)('a %s drop marked left ends at once as host left, no reconnect', async (medium) => {
    const r = rig(medium)
    await admit(r)
    r.drop('left')
    expect(r.client.phase).toBe('ended')
    expect(r.client.hostLeft).toBe(true)
    await r.advance(5000)
    expect(r.reconnects).toBe(0)
    expect(r.client.renderView().missionText).toBe('The host left the game')
    expect(r.client.linkStatus().session).toBe('ended')
  })

  it('a plain error drop online is a reconnect, not a departure', async () => {
    const r = rig('online')
    await admit(r)
    r.drop('error')
    expect(r.client.phase).toBe('reconnecting')
    expect(r.client.hostLeft).toBe(false)
  })
})

describe('copy follows the medium', () => {
  it.each([
    ['online', /^Connection lost — reconnecting/],
    ['bluetooth', /^Bluetooth dropped — reconnecting/],
    ['local', /^Host tab went quiet/],
  ] as const)('%s reconnecting says %s', async (medium, text) => {
    const r = rig(medium)
    await admit(r)
    r.drop('error')
    expect(r.client.renderView().missionText).toMatch(text)
  })

  it('online text never mentions Bluetooth in any phase it reaches', async () => {
    const seen: string[] = []
    const r = rig('online')
    await admit(r)
    for (let i = 0; i < 70; i++) {
      await r.advance(1000)
      seen.push(r.client.renderView().missionText)
    }
    expect(r.client.phase).toBe('ended')
    expect(seen.join(' ')).not.toMatch(/bluetooth/i)
  })
})

describe('Bluetooth is left alone', () => {
  it('ten silent seconds over Bluetooth neither pings nor forces a reconnect', async () => {
    const r = rig('bluetooth')
    await admit(r)
    await r.advance(10_000)
    expect(r.client.phase).toBe('playing')
    expect(pings(r)).toEqual([])
    expect(r.reconnects).toBe(0)
  })
})

describe('an announced leave is never shown as a lost connection first', () => {
  /** Every phase the client enters, with whether it already knew the host left. */
  const watch = (r: Rig): { phase: string; hostLeft: boolean }[] => {
    const seen: { phase: string; hostLeft: boolean }[] = []
    r.client.onPhaseChange = (phase) => seen.push({ phase, hostLeft: r.client.hostLeft })
    return seen
  }
  const ended = (seen: { phase: string; hostLeft: boolean }[]) => seen.filter((s) => s.phase === 'ended')

  it.each(['online', 'bluetooth', 'local'] as const)('%s: Bye, then the link drops', async (medium) => {
    const r = rig(medium)
    await admit(r)
    const seen = watch(r)
    r.hostSays(encodeJson(MsgType.Bye, {}))
    r.drop('remote')
    await r.advance(3000)
    expect(ended(seen)).toEqual([{ phase: 'ended', hostLeft: true }])
    expect(seen.map((s) => s.phase)).not.toContain('reconnecting')
  })

  it.each(['online', 'bluetooth', 'local'] as const)('%s: the drop overtakes the Bye', async (medium) => {
    const r = rig(medium)
    await admit(r)
    const seen = watch(r)
    r.drop('error')
    r.hostSays(encodeJson(MsgType.Bye, {}))
    await r.advance(3000)
    expect(ended(seen).every((s) => s.hostLeft)).toBe(true)
    expect(r.client.hostLeft).toBe(true)
  })

  it('online: the relay says the host left, and the Bye arrives after', async () => {
    const r = rig('online')
    await admit(r)
    const seen = watch(r)
    r.drop('left')
    r.hostSays(encodeJson(MsgType.Bye, {}))
    expect(ended(seen)).toEqual([{ phase: 'ended', hostLeft: true }])
  })
})

describe('the net menu title', () => {
  it('reads MENU mid-run, HOST LEFT once the host leaves, CONNECTION LOST when the link dies', async () => {
    const live = rig('online')
    await admit(live)
    expect(live.client.menuTitle()).toBe('MENU')

    const left = rig('online')
    await admit(left)
    left.hostSays(encodeJson(MsgType.Bye, {}))
    expect(left.client.menuTitle()).toBe('HOST LEFT')

    const lost = rig('bluetooth')
    await admit(lost)
    ;(lost.client as unknown as { transport: Transport }).transport.reconnect = undefined
    lost.drop('error')
    expect(lost.client.menuTitle()).toBe('CONNECTION LOST')
  })

  it('quitting from the HOST LEFT menu keeps HOST LEFT, never flashing CONNECTION LOST', async () => {
    const r = rig('online')
    await admit(r)
    r.drop('left')
    const titles: string[] = [r.client.menuTitle()]
    const closing = r.client.close()
    titles.push(r.client.menuTitle())
    r.drop('local')
    await closing
    titles.push(r.client.menuTitle())
    expect(titles).toEqual(['HOST LEFT', 'HOST LEFT', 'HOST LEFT'])
    expect(r.client.hostLeft).toBe(true)
  })

  it('a guest quitting a live run reads LEAVING…, and its own hang-up is not a lost connection', async () => {
    const r = rig('online')
    await admit(r)
    const closing = r.client.close()
    r.drop('local')
    await closing
    await r.advance(6000)
    expect(r.client.menuTitle()).toBe('LEAVING…')
    expect(r.client.phase).not.toBe('reconnecting')
    expect(r.reconnects).toBe(0)
  })
})

describe('host-left while already reconnecting', () => {
  it('a departure reported mid-reconnect ends the run as host left, and the loop stops', async () => {
    const r = rig('online')
    await admit(r)
    r.onReopen.value = 'silent'
    await r.advance(STALLED_AFTER_MS + 3500)
    expect(r.client.phase).toBe('reconnecting')
    const attempts = r.reconnects
    r.drop('left')
    expect(r.client.phase).toBe('ended')
    expect(r.client.hostLeft).toBe(true)
    await r.advance(10_000)
    expect(r.reconnects).toBe(attempts)
    expect(r.client.menuTitle()).toBe('HOST LEFT')
  })
})
