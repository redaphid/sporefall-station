// The netlab bench page: the real NetHostSession and NetClientSession on the
// real transports (RtcTransport over WsTransport), ticking at 30 Hz with no
// renderer. The guest plays a scripted walk with attack taps and rolls, and
// records what the player would feel: round trips, snapshot arrival gaps, and
// how often a snapshot pulled its predicted avatar back (rubber-banding).
// Bundled by measure.mjs; see README.md.

import { NetClientSession } from '../../src/app/netClient'
import { NetHostSession } from '../../src/app/netHost'
import { createWorld } from '../../src/game/world'
import { emptyInput, type InputCmd } from '../../src/game/types'
import { encodeJson } from '../../src/net/framing/codec'
import { RtcTransport } from '../../src/net/transport/rtcTransport'
import { WsTransport } from '../../src/net/transport/wsTransport'
import { MsgType } from '../../src/net/types'

interface RoleOpts {
  room: string
  wsBase: string
  p2p: boolean
  seed: number
  iceTimeoutMs?: number
  /** Guest script: `w` walks, `a` taps attack, `r` rolls. Default `wa`: the client does not predict a roll, so rolls snap on any link. */
  script?: string
}

const TICK_MS = 1000 / 30
const now = (): number => performance.now()

/** Run `tick` at 30 Hz on a fixed step, catching up after a late timer. */
const loop = (tick: () => void): (() => void) => {
  let next = now()
  const timer = setInterval(() => {
    for (let guard = 0; now() >= next && guard < 5; guard++) {
      tick()
      next += TICK_MS
    }
    if (now() - next > 200) next = now()
  }, 4)
  return () => clearInterval(timer)
}

const transport = (role: 'host' | 'client', o: RoleOpts): RtcTransport =>
  new RtcTransport(new WsTransport(role, o.room, o.wsBase), { p2p: o.p2p, iceServers: [], iceTimeoutMs: o.iceTimeoutMs, log: (m) => console.log(`${Math.round(performance.timeOrigin + performance.now()) % 100000} [${role}] ${m}`) })

const host = async (o: RoleOpts) => {
  const t = transport('host', o)
  const session = new NetHostSession(o.seed, 'Host', { sample: () => emptyInput() }, t, 'casual', now, (seed, mode) =>
    createWorld(seed, 1, mode, false),
  )
  let attackEdges = 0
  let prevAttack = false
  session.onTickInputs = (inputs) => {
    const cmd = inputs.get(1)
    if (!cmd) return
    if (cmd.attack && !prevAttack) attackEdges++
    prevAttack = cmd.attack
  }
  session.onLobbyChange = (players) => {
    if (players.length >= 2 && !session.started) session.beginGame()
  }
  await session.start()
  const stop = loop(() => session.tick())
  return {
    stats: () => ({ tick: session.world.tick, attackEdges, link: session.linkStatus() }),
    stop: async () => {
      stop()
      await session.close()
    },
  }
}

const DIRS = [
  [1, 0],
  [0.7, 0.7],
  [0, 1],
  [-0.7, 0.7],
  [-1, 0],
  [-0.7, -0.7],
  [0, -1],
  [0.7, -0.7],
]

const guest = async (o: RoleOpts) => {
  const script = o.script ?? 'wa'
  const t = transport('client', o)
  let n = 0
  let taps = 0
  let quiet = false
  const input = {
    sample: (): InputCmd => {
      n++
      const [mx, my] = DIRS[Math.floor(n / 45) % DIRS.length]
      const tap = !quiet && script.includes('a') && n % 9 === 0
      if (tap) taps++
      const walk = script.includes('w')
      return { ...emptyInput(), moveX: walk ? mx : 0, moveY: walk ? my : 0, aimX: mx, aimY: my, attack: tap, roll: !quiet && script.includes('r') && n % 90 === 45 }
    },
  }
  const session = new NetClientSession('Guest', input, t)
  const rtts: number[] = []
  /** Per snapshot: arrival time, and how late it was against the host tick it carries (offset unknown, so only its spread means anything). */
  const arrivals: number[] = []
  const lateness: number[] = []
  let recording = false
  const s = session as unknown as {
    handleMessage: (m: Uint8Array) => void
    queue?: { queueProbe: (m: Uint8Array) => void }
  }
  const handle = s.handleMessage.bind(session)
  s.handleMessage = (m) => {
    if (recording && m[0] === MsgType.Snapshot) {
      const tick = new DataView(m.buffer, m.byteOffset).getUint32(1, true)
      arrivals.push(now())
      lateness.push(now() - tick * TICK_MS)
    }
    if (recording && m[0] === MsgType.Pong) {
      const sent = JSON.parse(new TextDecoder().decode(m.subarray(1))).t as number
      rtts.push(now() - sent)
    }
    handle(m)
  }
  // Ten pings a second instead of the game's one, for enough samples per run.
  const pinger = setInterval(() => {
    if (session.phase === 'playing') s.queue?.queueProbe(encodeJson(MsgType.Ping, { t: now() }))
  }, 100)
  await session.start()
  const stop = loop(() => session.tick())
  let corrections0 = 0
  let t0 = 0
  return {
    phase: () => session.phase,
    path: () => session.linkStatus().path ?? null,
    begin: () => {
      recording = true
      corrections0 = session.predictionCorrections
      t0 = now()
    },
    quiet: () => {
      quiet = true
      recording = false
    },
    stats: () => ({
      rtts,
      arrivals,
      lateness,
      corrections: session.predictionCorrections - corrections0,
      seconds: (now() - t0) / 1000,
      taps,
      phase: session.phase,
      link: session.linkStatus(),
      simTick: session.renderView().simTick,
    }),
    stop: async () => {
      clearInterval(pinger)
      stop()
      await session.close()
    },
  }
}

Object.assign(window, { bench: { host, guest } })
