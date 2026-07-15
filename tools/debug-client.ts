// Shared debugger-side client used by the CLI and the MCP bridge. Connects to
// the hub as a `debugger`, correlates each verb with its reply by id, and fans
// pushed events out to subscribers. Uses Node's built-in global WebSocket
// (Node 22+) so it needs no dependency of its own.

import { DEFAULT_HUB_PORT, hubUrl, type DebugMsg } from '../src/debug/protocol'

export interface DebugClient {
  /** Send one verb line; resolve with the game's text reply (reject on error). */
  raw(verb: string, timeoutMs?: number): Promise<string>
  onEvent(cb: (event: unknown) => void): void
  close(): void
}

export const defaultHubUrl = (): string =>
  process.env.DEBUG_HUB_URL ?? hubUrl('127.0.0.1', Number(process.env.DEBUG_HUB_PORT ?? DEFAULT_HUB_PORT))

export const connectDebugger = (url = defaultHubUrl()): Promise<DebugClient> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const waiters = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>()
    const eventCbs: Array<(e: unknown) => void> = []
    let seq = 1

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'debugger' } satisfies DebugMsg))
      resolve(client)
    })
    ws.addEventListener('error', () => reject(new Error(`could not connect to the hub at ${url}`)))
    ws.addEventListener('message', (ev) => {
      let msg: DebugMsg
      try {
        msg = JSON.parse(String((ev as MessageEvent).data)) as DebugMsg
      } catch {
        return
      }
      if (msg.t === 'rep') {
        const w = waiters.get(msg.id)
        if (!w) return
        waiters.delete(msg.id)
        msg.ok ? w.resolve(msg.body) : w.reject(new Error(msg.body))
      } else if (msg.t === 'event') {
        for (const cb of eventCbs) cb(JSON.parse(msg.body))
      }
    })

    const client: DebugClient = {
      raw: (verb, timeoutMs = 5000) =>
        new Promise((res, rej) => {
          const id = seq++
          waiters.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ t: 'req', id, verb } satisfies DebugMsg))
          setTimeout(() => {
            if (waiters.delete(id)) rej(new Error(`verb timed out (${timeoutMs}ms): ${verb}`))
          }, timeoutMs)
        }),
      onEvent: (cb) => eventCbs.push(cb),
      close: () => ws.close(),
    }
  })
