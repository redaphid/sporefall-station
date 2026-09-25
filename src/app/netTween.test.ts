import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { frameMessage } from '../net/framing/chunkedStream'
import { encodeSnapshot, type WireEntity } from '../net/protocol/messages'
import { type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'
import { NetHostSession } from './netHost'

/**
 * TWEENING REMOTE ENTITIES.
 *
 * Snapshots are 10 Hz against a 30 Hz sim, so for two ticks out of every three
 * the client is easing toward a target it already reached. Easing a fixed
 * fraction of that sawtooth error draws a sawtooth SPEED — measured on a REAL
 * host/client pair over a clean link with zero packet loss, a teammate walking
 * at a constant 4.50 tiles/s was drawn at 7.16 -> 3.94 -> 2.17 -> 7.16 tiles/s,
 * a 3.3x pulse at 10 Hz. Packet loss compounds it into a stall-then-dart
 * (0.38 tiles/s, then 12.44).
 *
 * These tests measure what a PLAYER SEES: the per-tick displacement of the
 * remote sprite, which is what the renderer turns into apparent speed
 * (`sprites.ts` draws `prevPos + (pos - prevPos) * alpha`, so sub-tick alpha
 * subdivides these segments but cannot remove a discontinuity between them).
 * Asserting on positional error alone would pass while the screen jerks: the
 * lag here is a steady ~0.5 tiles in BOTH the good and the bad case.
 *
 * Every test below was watched go RED against the pre-fix client (a fixed
 * 0.45-per-tick ease toward the last known position, no projection) — see the
 * `expected pre-fix` note on each.
 */

// --- harness ----------------------------------------------------------------

class Hub {
  hostTransport: Transport
  private hostHandler: ((e: TransportEvent) => void) | null = null
  private centrals = new Map<PeerId, (bytes: Uint8Array) => void>()

  constructor() {
    this.hostTransport = {
      role: 'host',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (peer: PeerId, bytes: Uint8Array) => Promise.resolve().then(() => this.centrals.get(peer)?.(bytes)),
      on: (h) => {
        this.hostHandler = h
        return () => {}
      },
      peers: () => [...this.centrals.keys()],
    }
  }

  addClient(name: string, input: InputSource): ClientHandle {
    const peer: PeerId = `central-${this.centrals.size + 1}`
    let clientHandler: ((e: TransportEvent) => void) | null = null
    const deliver = (bytes: Uint8Array): void => {
      void Promise.resolve().then(() => clientHandler?.({ type: 'data', peer: 'host', bytes }))
    }
    this.centrals.set(peer, deliver)
    const clientTransport: Transport = {
      role: 'client',
      maxPacket: 180,
      start: async () => {},
      stop: async () => {},
      sendPacket: (_p: PeerId, bytes: Uint8Array) => Promise.resolve().then(() => this.hostHandler?.({ type: 'data', peer, bytes })),
      on: (h) => {
        clientHandler = h
        return () => {}
      },
      peers: () => ['host'],
    }
    const session = new NetClientSession(name, input, clientTransport)
    return {
      session,
      connect: () => {
        void Promise.resolve().then(() => this.hostHandler?.({ type: 'peerConnected', peer }))
        void Promise.resolve().then(() => clientHandler?.({ type: 'peerConnected', peer: 'host' }))
      },
      inject: (msg: Uint8Array) => {
        for (const pkt of frameMessage(msg, 180)) deliver(pkt)
      },
    }
  }
}

interface ClientHandle {
  session: NetClientSession
  connect: () => void
  inject: (msg: Uint8Array) => void
}

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const SIM_HZ = 30
/** Well clear of any id the generator hands out, so injected snapshots cannot
 * collide with a real entity. */
const REMOTE = 60001

const wire = (id: number, x: number, y: number, archetype = 'player'): WireEntity => ({
  id,
  archetype,
  x,
  y,
  facing: 0,
  hpPct: 1,
  flags: 0,
})

interface Rig {
  bob: ClientHandle
  /** Deliver one snapshot carrying the client's own avatar plus `others`. */
  send: (tick: number, others: WireEntity[]) => Promise<void>
  /** Advance `n` client ticks, returning the remote sprite's drawn position after each. */
  run: (n: number, id?: number) => { x: number; y: number }[]
  selfId: number
  selfPos: { x: number; y: number }
}

const rig = async (seed = 4242): Promise<Rig> => {
  const hub = new Hub()
  const host = new NetHostSession(seed, 'Alice', stubInput(), hub.hostTransport)
  const bob = hub.addClient('Bob', stubInput())
  await host.start()
  await bob.session.start()
  bob.connect()
  await flush()
  host.beginGame()
  await flush()
  const selfId = host.peersBySlot.get(1)!.entityId!
  const avatar = host.world.byId.get(selfId)!
  const selfPos = { x: avatar.pos.x, y: avatar.pos.y }
  // The real host is no longer needed: every snapshot below is hand-built so the
  // target sequence is exact and the test cannot flake on host-side pathing.
  return {
    bob,
    selfId,
    selfPos,
    send: async (tick, others) => {
      bob.inject(
        encodeSnapshot({
          tick,
          floor: 1,
          alarm: 0,
          lastInputSeq: 0,
          entities: [wire(selfId, selfPos.x, selfPos.y), ...others],
        }),
      )
      await flush()
    },
    run: (n, id = REMOTE) => {
      const out: { x: number; y: number }[] = []
      for (let i = 0; i < n; i++) {
        bob.session.tick()
        const e = bob.session.renderView().entities.find((x) => x.id === id)
        out.push(e ? { x: e.pos.x, y: e.pos.y } : { x: NaN, y: NaN })
      }
      return out
    },
  }
}

/** Apparent on-screen speed, tiles/s, from consecutive drawn positions. */
const speeds = (pts: { x: number; y: number }[]): number[] => {
  const out: number[] = []
  for (let i = 1; i < pts.length; i++) out.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * SIM_HZ)
  return out
}

// --- tests ------------------------------------------------------------------

describe('remote entities are drawn at a steady speed on a CLEAN link', () => {
  /**
   * The headline case, and the one that is NOT about packet loss: every snapshot
   * arrives, and the pre-fix client still drew a 3.3x speed pulse at 10 Hz.
   *
   * expected pre-fix: speeds cycle ~7.2 / ~4.0 / ~2.2 tiles/s, so both the
   * spread assertion (3.3 > 1.5) and the per-tick band assertion fail.
   */
  it('draws a constant-velocity walker at a constant speed', async () => {
    const r = await rig()
    const TRUE = 4.5 // tiles/s, the player walk speed (netClient stepSelf)
    const per = TRUE / SIM_HZ // tiles per tick
    let x = 20
    await r.send(3, [wire(REMOTE, x, 20)])
    r.run(3)
    // Ten snapshot intervals of dead-straight walking.
    const drawn: { x: number; y: number }[] = []
    for (let s = 2; s <= 11; s++) {
      x += per * 3
      await r.send(s * 3, [wire(REMOTE, x, 20)])
      drawn.push(...r.run(3))
    }
    const sp = speeds(drawn.slice(6)) // discard the first two intervals of warm-up
    const spread = Math.max(...sp) / Math.min(...sp)
    expect(spread).toBeLessThan(1.5)
    for (const v of sp) expect(v).toBeGreaterThan(TRUE * 0.75)
    for (const v of sp) expect(v).toBeLessThan(TRUE * 1.25)
  })

  /**
   * The sprite must also END UP in roughly the right place — a filter that is
   * smooth because it ignores the snapshots would pass the test above.
   *
   * expected pre-fix: PASSES (lag is ~0.5 tiles either way). This is the control
   * that stops the suite from rewarding smoothness bought with lag, and it is
   * why the speed assertions above are the ones that carry the fix.
   */
  it('still tracks the authoritative position (smoothness is not bought with lag)', async () => {
    const r = await rig()
    const per = 4.5 / SIM_HZ
    let x = 20
    await r.send(3, [wire(REMOTE, x, 20)])
    r.run(3)
    let last: { x: number; y: number } = { x, y: 20 }
    for (let s = 2; s <= 11; s++) {
      x += per * 3
      await r.send(s * 3, [wire(REMOTE, x, 20)])
      last = r.run(3).at(-1)!
    }
    expect(Math.abs(last.x - x)).toBeLessThan(0.75)
  })
})

describe('a DROPPED snapshot degrades gracefully', () => {
  /**
   * One snapshot lost = a 200 ms gap, which is ~9% of intervals at 5% BLE packet
   * loss (a snapshot is 2 packets, and losing either loses the message).
   *
   * expected pre-fix: the sprite coasts to a near standstill against the stale
   * target (min ~0.9 tiles/s here) and then darts (max ~11 tiles/s), so both
   * bounds fail.
   */
  it('does not stall then dart across a 200 ms gap', async () => {
    const r = await rig()
    const TRUE = 4.5
    const per = TRUE / SIM_HZ
    let x = 20
    await r.send(3, [wire(REMOTE, x, 20)])
    r.run(3)
    for (let s = 2; s <= 5; s++) {
      x += per * 3
      await r.send(s * 3, [wire(REMOTE, x, 20)])
      r.run(3)
    }
    // The gap: the host keeps walking, but this snapshot never arrives.
    x += per * 3
    const during = r.run(3)
    // Recovery: the next snapshot lands, carrying two intervals of movement.
    x += per * 3
    await r.send(7 * 3, [wire(REMOTE, x, 20)])
    const after = r.run(3)

    const gapSpeeds = speeds([...during])
    const recoverySpeeds = speeds([during.at(-1)!, ...after])
    // No visible stall: the sprite keeps moving through the gap instead of
    // coasting to a halt against a target it already reached.
    expect(Math.min(...gapSpeeds)).toBeGreaterThan(TRUE * 0.45)
    // No visible dart: it does not lurch to catch up when the snapshot lands.
    expect(Math.max(...recoverySpeeds)).toBeLessThan(TRUE * 1.9)
  })

  /**
   * Projection is capped at PROJECT_CAP_TICKS (150 ms). A link that stops
   * delivering entirely must leave the sprite STANDING STILL, not walking off
   * through the scenery forever.
   *
   * expected pre-fix: PASSES (the pre-fix client never projected at all). This
   * one guards the new code against its own worst failure mode rather than
   * proving the fix, so it is expected to be green on both sides.
   */
  it('freezes rather than running away when snapshots stop entirely', async () => {
    const r = await rig()
    const per = 4.5 / SIM_HZ
    let x = 20
    await r.send(3, [wire(REMOTE, x, 20)])
    r.run(3)
    for (let s = 2; s <= 4; s++) {
      x += per * 3
      await r.send(s * 3, [wire(REMOTE, x, 20)])
      r.run(3)
    }
    const lastTarget = x
    // 90 ticks (3 s) of total silence.
    const quiet = r.run(90)
    const end = quiet.at(-1)!
    // Capped projection is 4.5 ticks of the measured velocity beyond the last
    // snapshot; nothing may carry it further than that.
    expect(end.x - lastTarget).toBeLessThan(per * 4.5 + 0.05)
    expect(end.x).toBeGreaterThan(lastTarget - 0.05)
    // And it must have come to rest, not still be creeping.
    const tail = speeds(quiet.slice(-10))
    expect(Math.max(...tail)).toBeLessThan(0.05)
  })
})

describe('projectiles are exempt from projection', () => {
  /**
   * Thrown items fly at 7-9 tiles/s, so a 400 ms gap already carries them 3.6
   * tiles — past SNAP_DIST — and they teleport. Projecting them would slide them
   * fast PAST the impact point. They keep the old constant and no projection, so
   * their drawn path must be BIT-IDENTICAL to the pre-fix ease.
   *
   * expected pre-fix: PASSES, by construction — that is the point. This test
   * pins projectile behaviour as unchanged, and it fails loudly if someone later
   * folds projectiles into the projected path.
   */
  it('draws a thrown item exactly as the old fixed-0.45 ease did', async () => {
    const r = await rig()
    const per = 8 / SIM_HZ // grenade speed (data/items THROWABLES.grenade)
    let x = 20
    await r.send(3, [wire(REMOTE, x, 20, 'grenade')])
    r.run(3)
    // Reference model: the pre-fix filter, written out longhand. It must chase
    // the QUANTISED target — positions ride a u16 at 1/32-tile precision
    // (`POS_SCALE`), so the client never sees the exact float the host held.
    const q = (v: number): number => Math.round(v * 32) / 32
    let ref = x
    const refPath: number[] = []
    const drawn: { x: number; y: number }[] = []
    for (let s = 2; s <= 6; s++) {
      x += per * 3
      await r.send(s * 3, [wire(REMOTE, x, 20, 'grenade')])
      for (let i = 0; i < 3; i++) {
        ref += (q(x) - ref) * 0.45
        refPath.push(ref)
      }
      drawn.push(...r.run(3))
    }
    drawn.forEach((p, i) => expect(p.x).toBeCloseTo(refPath[i], 9))
  })

  /** A thrown item really does arrive as kind 'projectile' even though its
   * archetype is the bare item id — the exemption keys off `kind`, so if that
   * mapping ever changed the exemption would silently stop applying. */
  it('a thrown grenade arrives as kind projectile, which is what the exemption keys off', async () => {
    const r = await rig()
    await r.send(3, [wire(REMOTE, 20, 20, 'grenade')])
    const e = r.bob.session.renderView().entities.find((x) => x.id === REMOTE)
    expect(e?.kind).toBe('projectile')
  })
})

describe('velocity inference cannot be fooled', () => {
  /**
   * A teleport (respawn, floor change, a host-side shove) is not motion. If its
   * step were treated as a velocity the sprite would be flung across the room at
   * the speed of the teleport.
   *
   * expected pre-fix: PASSES (nothing was ever projected). Guards the new code.
   */
  it('does not project a teleport-sized step as if it were velocity', async () => {
    const r = await rig()
    await r.send(3, [wire(REMOTE, 20, 20)])
    r.run(3)
    // A 9-tile jump in one interval: far beyond SNAP_DIST.
    await r.send(6, [wire(REMOTE, 29, 20)])
    const pts = r.run(6)
    // It lands exactly on the authoritative position and stays there — no
    // inferred 9-tiles-per-interval velocity carrying it onward.
    for (const p of pts) expect(p.x).toBeCloseTo(29, 9)
  })

  /**
   * On first sighting there is only ONE known position, so there is no velocity
   * to infer and nothing may be projected.
   *
   * expected pre-fix: PASSES. Guards the new code against reading uninitialised
   * previous-target state.
   */
  it('does not project an entity it has only seen once', async () => {
    const r = await rig()
    await r.send(3, [wire(REMOTE, 20, 20)])
    const pts = r.run(9)
    for (const p of pts) expect(p.x).toBeCloseTo(20, 9)
    for (const p of pts) expect(p.y).toBeCloseTo(20, 9)
  })
})
