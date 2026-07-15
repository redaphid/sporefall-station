// In-app debug bridge. Loaded only behind the `?debug` flag (dynamic import in
// main.ts), so it is a no-op — and not even bundled — in normal builds. It opens
// an OUTBOUND WebSocket to the hub on the laptop (the webview can't listen),
// registers as the `game`, and answers verbs against the live world.
//
// Sim-safety: verbs that mutate are queued and drained in `afterTick()` — a safe
// point between the sim step and render — mirroring the C# harness marshaling
// mutations onto the main thread. Reads answer immediately (JS is single-
// threaded: a socket callback never interleaves with a tick or a render).

import type { SimEvent } from '../game/types'
import type { World } from '../game/world'
import type { DebugMsg } from './protocol'
import { runVerb, verbName, WRITE_VERBS } from './verbs'

export interface DebugChannel {
  /** Call once per sim tick, after `session.tick()`: stream this tick's events
   * and drain any queued mutations. */
  afterTick(): void
  stop(): void
}

const MAX_EVENTS = 256

export const startDebugChannel = (world: World, url: string, log: (m: string) => void = console.log): DebugChannel => {
  const ws = new WebSocket(url)
  const pending: Array<() => void> = []
  const recentEvents: SimEvent[] = []
  let ready = false

  const send = (msg: DebugMsg): void => {
    if (ready) ws.send(JSON.stringify(msg))
  }
  const reply = (id: number, ok: boolean, body: string): void => send({ t: 'rep', id, ok, body })

  ws.onopen = () => {
    ready = true
    send({ t: 'hello', role: 'game' })
    log(`[debug] connected to ${url}`)
  }
  ws.onclose = () => {
    ready = false
  }
  ws.onerror = () => log(`[debug] socket error (${url}) — is the hub running?`)

  ws.onmessage = (ev) => {
    let msg: DebugMsg
    try {
      msg = JSON.parse(String(ev.data)) as DebugMsg
    } catch {
      return
    }
    if (msg.t !== 'req') return
    const { id, verb } = msg
    const run = (): void => {
      try {
        reply(id, true, runVerb(world, verb, { events: recentEvents }))
      } catch (e) {
        reply(id, false, e instanceof Error ? e.message : String(e))
      }
    }
    if (WRITE_VERBS.has(verbName(verb))) pending.push(run)
    else run()
  }

  const afterTick = (): void => {
    // Drain queued mutations FIRST: they run between ticks (sim-safe) and may
    // push their own events (a `kill` emits `death`) into world.events, which
    // the next tick would otherwise clear before we ever stream them.
    if (pending.length) for (const fn of pending.splice(0)) fn()
    for (const e of world.events) {
      recentEvents.push(e)
      send({ t: 'event', body: JSON.stringify({ tick: world.tick, ...e }) })
    }
    while (recentEvents.length > MAX_EVENTS) recentEvents.shift()
  }

  return { afterTick, stop: () => ws.close() }
}
