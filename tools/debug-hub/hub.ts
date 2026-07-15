// The debug hub — a tiny WebSocket relay you run on the laptop. The phone's
// webview cannot listen for connections but can dial OUT, so everyone connects
// here: the game registers as `game`, CLIs/MCP register as `debugger`. A verb
// from a debugger is forwarded to the game; the game's reply is routed back to
// the debugger that asked; game-pushed events fan out to every debugger.
//
//   npx tsx tools/debug-hub/hub.ts [port]        (default 7810, or DEBUG_HUB_PORT)

import { WebSocketServer, type WebSocket } from 'ws'
import { DEFAULT_HUB_PORT, type DebugMsg } from '../../src/debug/protocol'

const send = (sock: WebSocket, msg: DebugMsg): void => sock.send(JSON.stringify(msg))

/** Start the relay on `port`. Returns the server (call `.close()` to stop). */
export const startHub = (port = DEFAULT_HUB_PORT, log: (m: string) => void = (m) => console.log(`[hub] ${m}`)): WebSocketServer => {
  const wss = new WebSocketServer({ port })
  let game: WebSocket | null = null
  const debuggers = new Set<WebSocket>()
  // hub-assigned request id → the debugger waiting for the reply + its own id.
  const pending = new Map<number, { socket: WebSocket; origId: number }>()
  let seq = 1

  wss.on('connection', (sock) => {
  let role: 'game' | 'debugger' | null = null

  sock.on('message', (data) => {
    let msg: DebugMsg
    try {
      msg = JSON.parse(data.toString()) as DebugMsg
    } catch {
      return
    }
    switch (msg.t) {
      case 'hello':
        role = msg.role
        if (role === 'game') {
          game = sock
          log('game connected')
        } else {
          debuggers.add(sock)
          log(`debugger connected (${debuggers.size} total)`)
        }
        break
      case 'req': {
        if (!game) {
          send(sock, { t: 'rep', id: msg.id, ok: false, body: 'no game connected to the hub' })
          return
        }
        const hubId = seq++
        pending.set(hubId, { socket: sock, origId: msg.id })
        send(game, { t: 'req', id: hubId, verb: msg.verb })
        break
      }
      case 'rep': {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        send(p.socket, { t: 'rep', id: p.origId, ok: msg.ok, body: msg.body })
        break
      }
      case 'event':
        for (const d of debuggers) send(d, msg)
        break
    }
  })

    sock.on('close', () => {
      if (role === 'game' && game === sock) {
        game = null
        log('game disconnected')
      }
      debuggers.delete(sock)
    })
  })

  log(`listening on ws://0.0.0.0:${port} (game + debuggers)`)
  return wss
}

// Run directly (`npx tsx tools/debug-hub/hub.ts [port]`) → start immediately.
if (import.meta.url === `file://${process.argv[1]}`) {
  startHub(Number(process.argv[2] ?? process.env.DEBUG_HUB_PORT ?? DEFAULT_HUB_PORT))
}
