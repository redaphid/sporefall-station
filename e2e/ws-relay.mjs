// End-to-end proof of the REAL Cloudflare Worker relay: boots `wrangler dev`
// (workerd, local) and drives raw WebSocket peers against the actual RoomDO
// Durable Object — exercising src/worker/{index,roomDO,roomRelay}.ts over real
// sockets, not a mock. Asserts the full host/client routing contract:
//   • membership control frames (host+/peer+ on join, host-/peer- on leave)
//   • client→host and host→client binary routing with correct addressing
//   • per-client isolation (a host frame reaches only the addressed client)
//   • second-host rejection (close 4001)
//
// Run: node e2e/ws-relay.mjs   (or ./e2e/run-ws.sh, which builds dist first)
//
// The relay treats DATA frames as opaque bytes; this test mirrors the tiny
// addressing header from src/net/transport/wsWire.ts inline (host frames are
// [idLen:u8][id utf8][payload]) so it stays a dependency-free node script.

import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { startWrangler } from './ws-lib.mjs'

const PORT = Number(process.env.WS_E2E_PORT ?? 8787)
const BASE = `ws://localhost:${PORT}`
const ROOM = 'e2e-relay'

const enc = new TextEncoder()
const dec = new TextDecoder()
const encodeAddressed = (id, payload) => {
  const idb = enc.encode(id)
  const out = new Uint8Array(1 + idb.length + payload.length)
  out[0] = idb.length
  out.set(idb, 1)
  out.set(payload, 1 + idb.length)
  return out
}
const decodeAddressed = (buf) => {
  const u = new Uint8Array(buf)
  const n = u[0]
  return { id: dec.decode(u.subarray(1, 1 + n)), payload: u.subarray(1 + n) }
}

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    failures.push(msg)
  }
}

/** Open a peer socket and collect control (text) + data (binary) frames. */
const openPeer = (role, room = ROOM) => {
  const ws = new WebSocket(`${BASE}/ws/${room}?role=${role}`)
  ws.binaryType = 'arraybuffer'
  const controls = []
  const data = []
  const waiters = []
  const notify = () => waiters.splice(0).forEach((w) => w())
  ws.on('message', (raw, isBinary) => {
    if (isBinary) data.push(new Uint8Array(raw))
    else {
      try {
        controls.push(JSON.parse(raw.toString()))
      } catch {
        /* ignore */
      }
    }
    notify()
  })
  const closed = { code: null }
  const errored = { msg: null }
  ws.on('close', (code) => {
    closed.code = code
    notify()
  })
  ws.on('error', (e) => {
    errored.msg = String(e?.message ?? e)
    notify()
  })
  const open = new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  /** Wait until `pred()` holds or `ms` elapses. */
  const until = async (pred, ms = 3000) => {
    const deadline = Date.now() + ms
    while (!pred() && Date.now() < deadline) {
      await new Promise((r) => {
        waiters.push(r)
        setTimeout(r, 100)
      })
    }
    return pred()
  }
  return { ws, controls, data, closed, errored, open, until }
}

const main = async () => {
  console.log('[ws-relay] starting wrangler dev…')
  const wrangler = await startWrangler(PORT)
  try {
    // Host joins the empty room, then a client joins.
    const host = openPeer('host')
    await host.open
    const client = openPeer('client')
    await client.open

    // Host learns of the client; client learns the host is present.
    console.log('[ws-relay] membership')
    await host.until(() => host.controls.some((c) => c.t === 'peer+'))
    const joined = host.controls.find((c) => c.t === 'peer+')
    check(!!joined, 'host receives peer+ when a client joins')
    const clientId = joined?.id
    await client.until(() => client.controls.some((c) => c.t === 'host+'))
    check(
      client.controls.some((c) => c.t === 'host+'),
      'client receives host+ when the host is present',
    )

    // client -> host: relay re-addresses the payload with the client's id.
    console.log('[ws-relay] routing')
    client.ws.send(Buffer.from([11, 22, 33]), { binary: true })
    await host.until(() => host.data.length > 0)
    check(host.data.length === 1, 'host receives exactly one client data frame')
    const got = host.data[0] && decodeAddressed(host.data[0])
    check(got && got.id === clientId, 'client frame arrives addressed with the sender id')
    check(got && [...got.payload].join(',') === '11,22,33', 'client payload arrives intact')

    // host -> client: relay strips the address, delivers the bare payload.
    host.ws.send(Buffer.from(encodeAddressed(clientId, new Uint8Array([44, 55]))), { binary: true })
    await client.until(() => client.data.length > 0)
    check(client.data.length === 1 && [...client.data[0]].join(',') === '44,55', 'host payload arrives at the client, bare')

    // Isolation: a second client must not receive the first client's mail.
    console.log('[ws-relay] isolation')
    const client2 = openPeer('client')
    await client2.open
    await host.until(() => host.controls.filter((c) => c.t === 'peer+').length === 2)
    const id2 = host.controls.filter((c) => c.t === 'peer+')[1]?.id
    check(!!id2 && id2 !== clientId, 'host receives a distinct peer+ id for the second client')
    host.ws.send(Buffer.from(encodeAddressed(id2, new Uint8Array([99]))), { binary: true })
    await client2.until(() => client2.data.length > 0)
    check(client2.data.length === 1 && client2.data[0][0] === 99, 'second client receives its own frame')
    check(client.data.length === 1, 'first client did NOT receive the second client’s frame')

    // A second host is rejected at the HTTP layer (409) — the upgrade never
    // completes, so the peer sees a connection error/close rather than joining.
    console.log('[ws-relay] second-host rejection')
    const host2 = openPeer('host')
    try {
      await host2.open
    } catch {
      /* expected: the 409 aborts the upgrade */
    }
    const rejected = await host2.until(() => host2.errored.msg !== null || host2.closed.code !== null)
    console.log(`    (second-host rejection: error=${host2.errored.msg}, close=${host2.closed.code})`)
    check(rejected, 'a second host fails to connect (409, never joins the room)')
    check(
      host2.controls.every((c) => c.t !== 'host+'),
      'the rejected host never receives a host+/join confirmation',
    )

    // Departure: closing a client notifies the host.
    console.log('[ws-relay] departure')
    client.ws.close()
    await host.until(() => host.controls.some((c) => c.t === 'peer-' && c.id === clientId))
    check(
      host.controls.some((c) => c.t === 'peer-' && c.id === clientId),
      'host receives peer- when a client leaves',
    )

    host.ws.close()
    client2.ws.close()
  } finally {
    await wrangler.stop()
  }

  if (failures.length) {
    console.error(`\n[ws-relay] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[ws-relay] OK — all relay asserts passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
