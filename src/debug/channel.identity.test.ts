// STABLE debug game identity. The hub used to assign a FRESH `g#` every time a game
// registered, so every death / New-Seed / reload churned the live id (g4→g5→g6…) and
// broke `--game <id>` continuity across a death. The fix: the client persists a stable
// per-browser/tab id in localStorage and re-sends it on every (re)connect; the hub
// treats a re-registration under an existing id as a RECONNECTION of the same logical
// game — reusing the id and evicting the prior socket — so the id survives death.
//
// Three halves, mirroring hub.test.ts / channel.newseed.test.ts:
//   1. Pure `resolveDebugGameId` unit tests — generate-once/persist, legacy migration.
//   2. Integration over a REAL in-process hub (no mocks): reconnect/New-Seed keep the
//      SAME id with no zombie accumulation; distinct ids are distinct games; a no-id
//      client still auto-registers; `--game <stableId>` resolves across a reconnect.
//   3. A deterministic FakeWS unit test: rebind re-sends the SAME gameId in `hello`.

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import { type AddressInfo } from 'node:net'
import type { LocalStorageLike } from '../app/storageMigration'
import { startHub } from '../../tools/debug-hub/hub'
import { createWorld, tickWorld } from '../game/world'
import { DEBUG_GAME_ID_KEY, LEGACY_DEBUG_GAME_ID_KEY, resolveDebugGameId, startDebugLink, type DebugLink } from './channel'

const WS = WebSocket as unknown as typeof globalThis.WebSocket

// --- pure resolver ----------------------------------------------------------

/** Minimal in-memory localStorage stand-in. */
const memStore = (seed: Record<string, string> = {}): LocalStorageLike & { map: Map<string, string> } => {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('resolveDebugGameId (pure)', () => {
  it('mints a UUID once, persists it, and returns the SAME id on every later call', () => {
    const store = memStore()
    let n = 0
    const gen = (): string => `uuid-${++n}`

    const first = resolveDebugGameId(store, gen)
    expect(first).toBe('uuid-1')
    expect(store.getItem(DEBUG_GAME_ID_KEY)).toBe('uuid-1')

    // A reload / New-Seed / death resolves against the SAME store → SAME id, no re-mint.
    expect(resolveDebugGameId(store, gen)).toBe('uuid-1')
    expect(resolveDebugGameId(store, gen)).toBe('uuid-1')
    expect(n).toBe(1) // generated exactly once
  })

  it('migrates a legacy `sor.debugGameId` value forward and reclaims the old slot', () => {
    const store = memStore({ [LEGACY_DEBUG_GAME_ID_KEY]: 'legacy-id' })
    const id = resolveDebugGameId(store, () => 'fresh')
    expect(id).toBe('legacy-id') // kept the existing identity, did not mint a new one
    expect(store.getItem(DEBUG_GAME_ID_KEY)).toBe('legacy-id') // migrated forward
    expect(store.getItem(LEGACY_DEBUG_GAME_ID_KEY)).toBeNull() // legacy slot reclaimed
  })

  it('a DIFFERENT store (different browser) yields a DIFFERENT id — genuinely distinct instances', () => {
    let n = 0
    const gen = (): string => `uuid-${++n}`
    expect(resolveDebugGameId(memStore(), gen)).toBe('uuid-1')
    expect(resolveDebugGameId(memStore(), gen)).toBe('uuid-2')
  })

  it('with no store (headless) falls back to an ephemeral id — hub then auto-assigns', () => {
    expect(resolveDebugGameId(undefined, () => 'ephemeral')).toBe('ephemeral')
    expect(resolveDebugGameId(undefined, () => undefined)).toBeUndefined()
  })
})

// --- integration over a real loopback hub -----------------------------------

let servers: WebSocketServer[] = []
let sockets: WebSocket[] = []
let links: DebugLink[] = []

afterEach(async () => {
  for (const l of links) l.stop()
  links = []
  for (const s of sockets) s.terminate()
  sockets = []
  for (const srv of servers) await new Promise((r) => srv.close(r))
  servers = []
})

const startTestHub = async (): Promise<string> => {
  const wss = startHub(0, { log: () => {}, now: () => Date.now(), staleMs: 60_000, frozenMs: 60_000 })
  servers.push(wss)
  await new Promise((r) => wss.on('listening', r))
  const port = (wss.address() as AddressInfo).port
  return `ws://127.0.0.1:${port}`
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60))

const openDebugger = async (url: string): Promise<WebSocket> => {
  const s = await new Promise<WebSocket>((res) => {
    const sock = new WebSocket(url)
    sockets.push(sock)
    sock.on('open', () => res(sock))
  })
  s.send(JSON.stringify({ t: 'hello', role: 'debugger' }))
  await settle()
  return s
}

/** A bare game socket (no DebugLink) so we can exercise the raw `hello` wire — used
 * for the backward-compat (no gameId) path. Replies to every verb with its own id. */
const openBareGame = async (url: string, hello: Record<string, unknown>): Promise<WebSocket> => {
  const s = await new Promise<WebSocket>((res) => {
    const sock = new WebSocket(url)
    sockets.push(sock)
    sock.on('open', () => res(sock))
  })
  s.send(JSON.stringify({ t: 'hello', role: 'game', ...hello }))
  await settle()
  return s
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

const games = async (dbg: WebSocket): Promise<Array<{ id: string; name: string }>> => JSON.parse((await rpc(dbg, 'games')).body)

describe('stable debug identity (integration over a real hub)', () => {
  it('a New-Seed / death rebind KEEPS the same id and rebinds it to the fresh world — no g# churn', async () => {
    const url = await startTestHub()
    const store = memStore()
    // First boot: link resolves + persists a stable id, dials the hub bound to seed 1111.
    const oldWorld = createWorld(1111, 1)
    for (let i = 0; i < 5; i++) tickWorld(oldWorld, new Map())
    const stableId = resolveDebugGameId(store, () => 'stable-A')!

    const link = startDebugLink(oldWorld, url, () => {}, { WebSocketImpl: WS, name: 'run', heartbeatMs: 0, gameId: stableId })
    links.push(link)
    await settle()
    const dbg = await openDebugger(url)

    const before = await games(dbg)
    expect(before).toHaveLength(1)
    expect(before[0].id).toBe('stable-A') // the hub adopted the STABLE id, not `g1`
    expect(JSON.parse((await rpc(dbg, 'state')).body).seed).toBe(1111)

    // Death → New-Seed: swap in a fresh world; the link re-dials with the SAME id.
    link.rebind(createWorld(2222, 1))
    await settle()

    const after = await games(dbg)
    expect(after).toHaveLength(1) // no zombie accumulated
    expect(after[0].id).toBe('stable-A') // SAME id retained across the death
    expect(JSON.parse((await rpc(dbg, 'state')).body).seed).toBe(2222) // bound to the fresh run
  })

  it('a full reload (brand-new link) reusing the persisted id re-registers under the SAME id — length stays 1', async () => {
    const url = await startTestHub()
    const store = memStore() // survives the "reload": same localStorage
    const id1 = resolveDebugGameId(store, () => 'stable-B')!

    const link1 = startDebugLink(createWorld(7, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: id1 })
    links.push(link1)
    await settle()
    const dbg = await openDebugger(url)
    expect((await games(dbg))[0].id).toBe('stable-B')

    // Simulate a page reload: stop the old link (old socket closes), start a fresh one
    // that re-resolves the SAME persisted id.
    link1.stop()
    await settle()
    const id2 = resolveDebugGameId(store, () => 'should-not-be-used')!
    expect(id2).toBe('stable-B') // persisted → identical across the reload
    const link2 = startDebugLink(createWorld(7, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: id2 })
    links.push(link2)
    await settle()

    const list = await games(dbg)
    expect(list).toHaveLength(1) // reconnection replaced the prior registration, no pile-up
    expect(list[0].id).toBe('stable-B')
  })

  it('a reconnect while the OLD socket is still open EVICTS the stale one — id stays single', async () => {
    const url = await startTestHub()
    const dbg = await openDebugger(url)

    // Two independent links sharing ONE stable id (models an overlapping reconnect where
    // the old socket has not yet been torn down): the second must evict the first.
    const a = startDebugLink(createWorld(1, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: 'dup' })
    links.push(a)
    await settle()
    const b = startDebugLink(createWorld(2, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: 'dup' })
    links.push(b)
    await settle()

    const list = await games(dbg)
    expect(list.filter((g) => g.id === 'dup')).toHaveLength(1) // exactly one entry under the id
    expect(list).toHaveLength(1)
    expect(JSON.parse((await rpc(dbg, 'state')).body).seed).toBe(2) // the survivor is the newest
  })

  it('DIFFERENT stable ids are DIFFERENT games (two ids → two games)', async () => {
    const url = await startTestHub()
    const one = startDebugLink(createWorld(1, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: 'id-one' })
    const two = startDebugLink(createWorld(2, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: 'id-two' })
    links.push(one, two)
    await settle()
    const dbg = await openDebugger(url)

    const list = await games(dbg)
    expect(list.map((g) => g.id).sort()).toEqual(['id-one', 'id-two'])
  })

  it('a legacy / no-id client still registers with an auto-assigned id (backward compatible)', async () => {
    const url = await startTestHub()
    const dbg = await openDebugger(url)
    await openBareGame(url, { name: 'legacy' }) // hello WITHOUT gameId

    const list = await games(dbg)
    expect(list).toHaveLength(1)
    expect(list[0].id).toMatch(/^g\d+$/) // fell back to connection-order id
    expect(list[0].name).toBe('legacy')
  })

  it('`--game <stableId>` (target) resolves the same game before AND after a reconnect', async () => {
    const url = await startTestHub()
    // A SECOND game is present so default (no-target) routing is ambiguous — proving the
    // target field, not just the single-live fallback, is what resolves the stable id.
    const other = startDebugLink(createWorld(999, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: 'other' })
    links.push(other)
    const link = startDebugLink(createWorld(1111, 1), url, () => {}, { WebSocketImpl: WS, heartbeatMs: 0, gameId: 'stable-C' })
    links.push(link)
    await settle()
    const dbg = await openDebugger(url)

    // Before: --game stable-C hits the 1111 world.
    expect(JSON.parse((await rpc(dbg, 'state', { target: 'stable-C' })).body).seed).toBe(1111)

    // Reconnect (death/New-Seed) under the SAME id, now bound to seed 3333.
    link.rebind(createWorld(3333, 1))
    await settle()

    // After: the SAME --game stable-C still resolves — now to the fresh run.
    const r = await rpc(dbg, 'state', { target: 'stable-C' })
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.body).seed).toBe(3333)
  })
})

// --- deterministic FakeWS unit test -----------------------------------------

class FakeWS {
  static instances: FakeWS[] = []
  static reset(): void {
    FakeWS.instances = []
  }
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  sent: string[] = []
  closed = false
  constructor(readonly url: string) {
    FakeWS.instances.push(this)
  }
  send(s: string): void {
    this.sent.push(s)
  }
  close(): void {
    this.closed = true
    this.onclose?.()
  }
  fireOpen(): void {
    this.onopen?.()
  }
  hellos(): Array<{ t: string; gameId?: string }> {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'hello')
  }
}

describe('startDebugLink stable id on the wire (unit)', () => {
  it('sends the SAME gameId in `hello` on the initial dial AND after a rebind', () => {
    FakeWS.reset()
    const opts = { WebSocketImpl: FakeWS as unknown as typeof globalThis.WebSocket, heartbeatMs: 0, name: 'run', gameId: 'fixed-id' }
    const link = startDebugLink(createWorld(1, 1), 'ws://x', () => {}, opts)
    FakeWS.instances[0].fireOpen()
    expect(FakeWS.instances[0].hellos()[0]).toMatchObject({ t: 'hello', gameId: 'fixed-id' })

    link.rebind(createWorld(2, 1))
    FakeWS.instances[1].fireOpen()
    // The fresh socket re-announces the SAME id → hub sees a reconnection, not a new game.
    expect(FakeWS.instances[1].hellos()[0]).toMatchObject({ t: 'hello', gameId: 'fixed-id' })
    link.stop()
  })
})
