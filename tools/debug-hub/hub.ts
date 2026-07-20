// The debug hub — a tiny WebSocket relay you run on the laptop. The phone's
// webview cannot listen for connections but can dial OUT, so everyone connects
// here: games register as `game`, CLIs/MCP register as `debugger`. A verb from a
// debugger is forwarded to the SELECTED game; the game's reply is routed back to
// the debugger that asked; game-pushed events fan out to every debugger.
//
// Multi-game by design (shared dev server, co-op, several developers): the hub
// keeps a registry of ALL connected games and NEVER evicts one just because a
// newer one connected ("newest wins" is explicitly wrong). A game leaves only
// when its socket closes or it fails the liveness check (stale/frozen). A
// debugger lists games (`games`), selects one (`use <id>` / a `target` field),
// and — with exactly one live game — needs no selection at all.
//
//   npx tsx tools/debug-hub/hub.ts [port]        (default 7810, or DEBUG_HUB_PORT)

import { WebSocketServer, type WebSocket } from 'ws'
import { DEFAULT_HUB_PORT, type DebugMsg, type GameInfo } from '../../src/debug/protocol'

const send = (sock: WebSocket, msg: DebugMsg): void => sock.send(JSON.stringify(msg))

export const DEFAULT_STALE_MS = 4000
export const DEFAULT_FROZEN_MS = 3000

export interface LivenessOpts {
  /** No heartbeat/traffic within this window → dead. */
  staleMs: number
  /** A reported tick that has not advanced within this window → frozen. */
  frozenMs: number
}

/** One registered game. `tick` is `null` for the headless harness (which reports
 * no tick and so is judged live purely by freshness). */
export interface GameEntry {
  id: string
  name: string
  connectedAt: number
  lastSeen: number
  tick: number | null
  lastTickAt: number
  gameOver: boolean
}

/** Dead-vs-alive by liveness, NOT age. Freshness (recent heartbeat) is the ONLY
 * liveness signal: as long as the channel keeps heart-beating, the game is a
 * valid target for inspection/mutation — even when its tick has stopped
 * (game-over, pause, or a backgrounded/throttled webview whose sim loop halted).
 * The channel's heartbeat runs on an independent timer, not the sim loop, so a
 * frozen world still reports in; only a genuinely disconnected/orphaned game
 * stops heart-beating and goes stale.
 *
 * `ticking` is a SEPARATE, advisory signal (surfaced to the human, never used to
 * refuse verbs): a real-time game that reports a tick is "not ticking" once that
 * tick stops advancing; a harness reports no tick, so `ticking` is `null`. */
export const liveness = (e: GameEntry, now: number, opts: LivenessOpts): { live: boolean; ticking: boolean | null } => {
  const live = now - e.lastSeen <= opts.staleMs
  const ticking = e.tick === null ? null : now - e.lastTickAt <= opts.frozenMs
  return { live, ticking }
}

interface InternalGame extends GameEntry {
  socket: WebSocket
}

export interface HubOpts {
  log?: (m: string) => void
  /** Injectable clock (tests drive liveness deterministically). */
  now?: () => number
  staleMs?: number
  frozenMs?: number
}

/** Start the relay on `port`. Returns the server (call `.close()` to stop). The
 * second arg is `HubOpts`, or a bare log fn for backward compatibility. */
export const startHub = (port = DEFAULT_HUB_PORT, opts: HubOpts | ((m: string) => void) = {}): WebSocketServer => {
  const o: HubOpts = typeof opts === 'function' ? { log: opts } : opts
  const log = o.log ?? ((m) => console.log(`[hub] ${m}`))
  const now = o.now ?? Date.now
  const live: LivenessOpts = { staleMs: o.staleMs ?? DEFAULT_STALE_MS, frozenMs: o.frozenMs ?? DEFAULT_FROZEN_MS }

  const wss = new WebSocketServer({ port })
  const games = new Map<WebSocket, InternalGame>()
  const byId = new Map<string, InternalGame>()
  const debuggers = new Set<WebSocket>()
  // Each debugger's sticky game selection (id or name).
  const selection = new Map<WebSocket, string>()
  // hub-assigned request id → the debugger waiting for the reply + its own id.
  const pending = new Map<number, { socket: WebSocket; origId: number }>()
  let seq = 1
  let gameSeq = 0

  const info = (g: InternalGame): GameInfo => {
    const { live: isLive, ticking } = liveness(g, now(), live)
    return { id: g.id, name: g.name, live: isLive, ticking, tick: g.tick, gameOver: g.gameOver, lastSeenMs: now() - g.lastSeen, ageMs: now() - g.connectedAt }
  }
  const liveGames = (): InternalGame[] => [...games.values()].filter((g) => liveness(g, now(), live).live)

  /** Resolve the game a debugger's verb should hit. An explicit target routes to
   * that game if it exists at all (you may want to poke a stale one — the CLI
   * warns). No target → the single live game, else an error naming the choices. */
  const resolveTarget = (target: string | undefined): { game: InternalGame } | { error: string } => {
    if (target) {
      const g = byId.get(target) ?? [...games.values()].find((x) => x.name === target)
      return g ? { game: g } : { error: `no game "${target}" connected` }
    }
    const alive = liveGames()
    if (alive.length === 1) return { game: alive[0] }
    if (alive.length === 0) return { error: 'no live game connected to the hub' }
    return { error: `multiple games connected: ${alive.map((g) => g.id).join(', ')} — select one with --game <id> (or the "use <id>" verb)` }
  }

  wss.on('connection', (sock) => {
    let role: 'game' | 'debugger' | null = null

    sock.on('message', (data) => {
      let msg: DebugMsg
      try {
        msg = JSON.parse(data.toString()) as DebugMsg
      } catch {
        return
      }
      // Any traffic from a game is proof of life.
      const g = games.get(sock)
      if (g) g.lastSeen = now()

      switch (msg.t) {
        case 'hello':
          role = msg.role
          if (role === 'game') {
            const id = `g${++gameSeq}`
            const entry: InternalGame = { id, name: msg.name ?? id, socket: sock, connectedAt: now(), lastSeen: now(), tick: null, lastTickAt: now(), gameOver: false }
            games.set(sock, entry)
            byId.set(id, entry)
            log(`game connected: ${id}${entry.name !== id ? ` (${entry.name})` : ''} — ${games.size} total`)
          } else {
            debuggers.add(sock)
            log(`debugger connected (${debuggers.size} total)`)
          }
          break
        case 'ping':
          if (g) {
            if (typeof msg.tick === 'number') {
              if (g.tick === null || msg.tick > g.tick) g.lastTickAt = now()
              g.tick = msg.tick
            }
            if (typeof msg.gameOver === 'boolean') g.gameOver = msg.gameOver
          }
          break
        case 'req': {
          const first = msg.verb.trim().split(/\s+/)[0]
          // Hub control verbs are handled here, never forwarded to a game.
          if (first === 'games') {
            send(sock, { t: 'rep', id: msg.id, ok: true, body: JSON.stringify([...games.values()].map(info)) })
            return
          }
          if (first === 'use' || first === 'target') {
            const id = msg.verb.trim().split(/\s+/)[1]
            if (!id) {
              const cur = selection.get(sock)
              send(sock, { t: 'rep', id: msg.id, ok: true, body: JSON.stringify({ target: cur ?? null }) })
              return
            }
            const r = resolveTarget(id)
            if ('error' in r) return void send(sock, { t: 'rep', id: msg.id, ok: false, body: r.error })
            selection.set(sock, id)
            return void send(sock, { t: 'rep', id: msg.id, ok: true, body: JSON.stringify(info(r.game)) })
          }
          const r = resolveTarget(msg.target ?? selection.get(sock))
          if ('error' in r) return void send(sock, { t: 'rep', id: msg.id, ok: false, body: r.error })
          if (msg.target) selection.set(sock, msg.target)
          const hubId = seq++
          pending.set(hubId, { socket: sock, origId: msg.id })
          send(r.game.socket, { t: 'req', id: hubId, verb: msg.verb })
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
      const g = games.get(sock)
      if (g) {
        games.delete(sock)
        byId.delete(g.id)
        log(`game disconnected: ${g.id} — ${games.size} remaining`)
      }
      debuggers.delete(sock)
      selection.delete(sock)
    })
  })

  log(`listening on ws://0.0.0.0:${port} (games + debuggers)`)
  return wss
}

// Run directly (`npx tsx tools/debug-hub/hub.ts [port]`) → start immediately.
if (import.meta.url === `file://${process.argv[1]}`) {
  startHub(Number(process.argv[2] ?? process.env.DEBUG_HUB_PORT ?? DEFAULT_HUB_PORT))
}
