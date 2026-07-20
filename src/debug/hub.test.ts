// Hub registry + liveness + multi-game routing (issue #45). Two halves:
//   1. Pure `liveness()` unit tests — dead-vs-alive by heartbeat freshness, plus
//      a real-time game additionally dead once its tick freezes; the harness
//      (tick = null) stays live on freshness alone.
//   2. Integration over a real ws loopback with an injected clock, proving the
//      hub keeps ALL games, never evicts on new-connect, routes to the selected/
//      only-live one, and excludes a stale game — no phone/adb.

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import { type AddressInfo } from 'node:net'
import { liveness, startHub, type GameEntry } from '../../tools/debug-hub/hub'

const OPTS = { staleMs: 1000, frozenMs: 1000 }
const base = (over: Partial<GameEntry>): GameEntry => ({ id: 'g1', name: 'g1', connectedAt: 0, lastSeen: 1000, tick: null, lastTickAt: 1000, gameOver: false, ...over })

describe('liveness (pure)', () => {
  it('fresh heartbeat with advancing tick → live + ticking', () => {
    expect(liveness(base({ tick: 50, lastTickAt: 1000 }), 1500, OPTS)).toEqual({ live: true, ticking: true })
  })
  it('fresh heartbeat but frozen tick → STILL live (game-over/paused), just not ticking', () => {
    // A game-over or paused world stops advancing its tick but keeps heart-beating
    // on its independent timer. It must remain a valid target — only `ticking`
    // flips false (advisory), never `live`.
    expect(liveness(base({ tick: 50, lastTickAt: 1000, lastSeen: 3000 }), 3000, OPTS)).toEqual({ live: true, ticking: false })
  })
  it('missed heartbeats (stale) → dead', () => {
    expect(liveness(base({ tick: 50, lastTickAt: 5000, lastSeen: 1000 }), 5000, OPTS).live).toBe(false)
  })
  it('harness (tick = null) stays live on freshness alone → ticking null', () => {
    expect(liveness(base({ tick: null, lastSeen: 1000 }), 1500, OPTS)).toEqual({ live: true, ticking: null })
  })
  it('harness gone stale is dead', () => {
    expect(liveness(base({ tick: null, lastSeen: 1000 }), 5000, OPTS).live).toBe(false)
  })
})

// --- integration over a real loopback ---------------------------------------

interface GameInfoRow {
  id: string
  name: string
  live: boolean
  ticking: boolean | null
}

let servers: WebSocketServer[] = []
let clients: WebSocket[] = []
const clock = { t: 1000 }

afterEach(async () => {
  for (const c of clients) c.terminate()
  clients = []
  for (const s of servers) await new Promise((r) => s.close(r))
  servers = []
})

const startTestHub = async (): Promise<{ url: string }> => {
  clock.t = 1000
  const wss = startHub(0, { log: () => {}, now: () => clock.t, staleMs: 1000, frozenMs: 1000 })
  servers.push(wss)
  await new Promise((r) => wss.on('listening', r)) // port 0 is assigned on listen
  const port = (wss.address() as AddressInfo).port
  return { url: `ws://127.0.0.1:${port}` }
}

const open = (url: string): Promise<WebSocket> =>
  new Promise((res) => {
    const s = new WebSocket(url)
    clients.push(s)
    s.on('open', () => res(s))
  })

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

/** A game that replies to every verb with its own name — so routing is provable
 * by which name comes back. */
const connectGame = async (url: string, name?: string): Promise<WebSocket> => {
  const s = await open(url)
  s.send(JSON.stringify({ t: 'hello', role: 'game', ...(name ? { name } : {}) }))
  s.on('message', (data) => {
    const m = JSON.parse(data.toString())
    if (m.t === 'req') s.send(JSON.stringify({ t: 'rep', id: m.id, ok: true, body: name ?? 'anon' }))
  })
  await settle()
  return s
}

const ping = async (s: WebSocket, body: { tick?: number } = {}): Promise<void> => {
  s.send(JSON.stringify({ t: 'ping', ...body }))
  await settle()
}

let seq = 0
const rpc = (s: WebSocket, verb: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; body: string }> =>
  new Promise((res) => {
    const id = ++seq
    const onMsg = (data: Buffer): void => {
      const m = JSON.parse(data.toString())
      if (m.t === 'rep' && m.id === id) {
        s.off('message', onMsg)
        res({ ok: m.ok, body: m.body })
      }
    }
    s.on('message', onMsg)
    s.send(JSON.stringify({ t: 'req', id, verb, ...extra }))
  })

describe('hub registry + routing (integration)', () => {
  it('lists every connected game; a new game never evicts an existing one', async () => {
    const { url } = await startTestHub()
    await connectGame(url, 'alice')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    // alice is the single live game.
    let list = JSON.parse((await rpc(dbg, 'games')).body) as GameInfoRow[]
    expect(list.map((g) => g.name)).toEqual(['alice'])

    await connectGame(url, 'bob')
    list = JSON.parse((await rpc(dbg, 'games')).body) as GameInfoRow[]
    // BOTH present — bob connecting did NOT evict alice ("newest wins" rejected).
    expect(list.map((g) => g.name).sort()).toEqual(['alice', 'bob'])
    expect(list.every((g) => g.live)).toBe(true)
  })

  it('routes to the single live game with no target', async () => {
    const { url } = await startTestHub()
    await connectGame(url, 'solo')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()
    expect((await rpc(dbg, 'state')).body).toBe('solo')
  })

  it('with multiple live games, no-target errors; a target routes to the chosen one', async () => {
    const { url } = await startTestHub()
    await connectGame(url, 'alice')
    await connectGame(url, 'bob')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    const ambiguous = await rpc(dbg, 'state')
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.body).toMatch(/multiple games/)

    expect((await rpc(dbg, 'state', { target: 'g1' })).body).toBe('alice') // by id
    expect((await rpc(dbg, 'state', { target: 'bob' })).body).toBe('bob') // by name
  })

  it('sticky selection via `use` routes subsequent verbs', async () => {
    const { url } = await startTestHub()
    await connectGame(url, 'alice')
    await connectGame(url, 'bob')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    expect((await rpc(dbg, 'use bob')).ok).toBe(true)
    expect((await rpc(dbg, 'state')).body).toBe('bob') // sticky, no per-call target
  })

  it('excludes a stale game from listing-liveness and default routing', async () => {
    const { url } = await startTestHub()
    const alice = await connectGame(url, 'alice')
    const bob = await connectGame(url, 'bob')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    // Advance past staleMs; only bob keeps heartbeating.
    clock.t = 1000 + 2000
    await ping(bob)
    void alice // alice stays silent → stale

    const list = JSON.parse((await rpc(dbg, 'games')).body) as GameInfoRow[]
    expect(list.find((g) => g.name === 'alice')!.live).toBe(false)
    expect(list.find((g) => g.name === 'bob')!.live).toBe(true)

    // With one live game, default routing picks bob — the stale alice is ignored.
    expect((await rpc(dbg, 'state')).body).toBe('bob')
  })

  it('drops a game when its socket closes', async () => {
    const { url } = await startTestHub()
    const alice = await connectGame(url, 'alice')
    await connectGame(url, 'bob')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    alice.close()
    await settle()
    const list = JSON.parse((await rpc(dbg, 'games')).body) as GameInfoRow[]
    expect(list.map((g) => g.name)).toEqual(['bob'])
  })

  it('flags a frozen (non-advancing tick) game as not-ticking but STILL live + routable', async () => {
    const { url } = await startTestHub()
    const alice = await connectGame(url, 'alice')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    await ping(alice, { tick: 100 }) // establishes a tick at t=1000
    clock.t = 1000 + 1500 // past frozenMs
    await ping(alice, { tick: 100 }) // fresh heartbeat, SAME tick → frozen but connected

    const list = JSON.parse((await rpc(dbg, 'games')).body) as GameInfoRow[]
    const row = list.find((g) => g.name === 'alice')!
    expect(row.ticking).toBe(false) // advisory: tick stopped
    expect(row.live).toBe(true) // still heart-beating → connected → live

    // A frozen-but-connected game is the sole live game → default routing hits it
    // with no --game, exactly when an agent wants to inspect/revive it.
    expect((await rpc(dbg, 'state')).body).toBe('alice')
  })

  it('a game-over world (frozen tick, gameOver flag) still serves verbs with no --game', async () => {
    const { url } = await startTestHub()
    const solo = await connectGame(url, 'solo')
    const dbg = await open(url)
    dbg.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
    await settle()

    await ping(solo, { tick: 500 }) // ticked while alive at t=1000
    clock.t = 1000 + 2000 // past frozenMs: the sim loop halted on game-over
    await ping(solo, { tick: 500, gameOver: true } as { tick: number }) // heartbeat continues, tick frozen

    const row = (JSON.parse((await rpc(dbg, 'games')).body) as GameInfoRow[]).find((g) => g.name === 'solo')!
    expect(row.ticking).toBe(false)
    expect(row.live).toBe(true)

    // state / dump / set must all route without --game on the game-over world.
    expect((await rpc(dbg, 'state')).body).toBe('solo')
    expect((await rpc(dbg, 'dump')).body).toBe('solo')
    expect((await rpc(dbg, 'set 5 {"health":{"hp":1}}')).body).toBe('solo')
  })
})
