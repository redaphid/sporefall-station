// A WebSocket proxy between the game and the relay under `wrangler dev`, for
// making the bad networks online play has to survive. Point a page at it with
// `?ws=ws://localhost:<port>/ws`. Faults apply per role (`host` / `client`, read
// from the relay URL's ?role):
//
//   freeze(role, true)  hold every frame in both directions with the socket left
//                       OPEN, and hold new upgrades too: a phone switching from
//                       wifi to cell. freeze(role, false) releases it all in order.
//   kill(role)          terminate the sockets with no close frame: a host whose
//                       network vanished mid-run.
//   delay(ms, jitter)   one-way latency on every frame, order preserved.

import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const roleOf = (url) => new URL(url, 'http://x').searchParams.get('role') ?? 'client'

export const startFaultProxy = (listenPort, upstreamPort) =>
  new Promise((resolve) => {
    const frozen = new Set()
    const live = new Set()
    const parkedUpgrades = []
    let delayMs = 0
    let jitterMs = 0

    const ordered = () => {
      let last = 0
      return (fn) => {
        const at = Math.max(last, Date.now() + delayMs + Math.random() * jitterMs)
        last = at
        setTimeout(fn, Math.max(0, at - Date.now()))
      }
    }

    const server = http.createServer((_req, res) => res.end('fault proxy'))
    const wss = new WebSocketServer({
      server,
      // A frozen network cannot complete a handshake either.
      verifyClient: (info, done) => {
        if (frozen.has(roleOf(info.req.url))) parkedUpgrades.push({ role: roleOf(info.req.url), done })
        else done(true)
      },
    })
    wss.on('connection', (down, req) => {
      const role = roleOf(req.url)
      const up = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`)
      const held = []
      const pending = []
      const toUp = ordered()
      const toDown = ordered()
      const pair = {
        role,
        down,
        up,
        flush: () => {
          for (const fn of held.splice(0)) fn()
        },
      }
      live.add(pair)
      const sendUp = (data, binary) => {
        if (up.readyState === WebSocket.OPEN) up.send(data, { binary })
        else if (up.readyState === WebSocket.CONNECTING) pending.push([data, binary])
      }
      const sendDown = (data, binary) => down.readyState === WebSocket.OPEN && down.send(data, { binary })
      up.on('open', () => {
        for (const [d, b] of pending.splice(0)) up.send(d, { binary: b })
      })
      down.on('message', (data, binary) => {
        if (frozen.has(role)) held.push(() => sendUp(data, binary))
        else toUp(() => sendUp(data, binary))
      })
      up.on('message', (data, binary) => {
        if (frozen.has(role)) held.push(() => sendDown(data, binary))
        else toDown(() => sendDown(data, binary))
      })
      const end = () => {
        live.delete(pair)
        down.terminate()
        up.terminate()
      }
      for (const s of [up, down]) {
        s.on('close', end)
        s.on('error', end)
      }
      up.on('unexpected-response', end)
    })

    const api = {
      freeze: (role, on) => {
        if (on) {
          frozen.add(role)
          return
        }
        frozen.delete(role)
        for (const p of live) if (p.role === role) p.flush()
        for (const u of parkedUpgrades.splice(0)) u.done(true)
      },
      kill: (role) => {
        for (const p of [...live]) {
          if (p.role !== role) continue
          p.down.terminate()
          p.up.terminate()
        }
      },
      delay: (ms, jitter = 0) => {
        delayMs = ms
        jitterMs = jitter
      },
      close: () =>
        new Promise((done) => {
          for (const p of live) p.down.terminate()
          wss.close()
          server.close(() => done())
        }),
    }
    server.listen(listenPort, () => resolve(api))
  })
