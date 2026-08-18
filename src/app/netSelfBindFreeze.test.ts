import { describe, expect, it } from 'vitest'
import { emptyInput, type InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { encodeJson } from '../net/framing/codec'
import { frameMessage } from '../net/framing/chunkedStream'
import { encodeSnapshot, type WireEntity } from '../net/protocol/messages'
import { MsgType, type PeerId, type Transport, type TransportEvent } from '../net/types'
import { NetClientSession } from './netClient'

/**
 * A CLIENT-SIDE PERMANENT FREEZE: `renderView()` throws, and main.ts's frame
 * loop reschedules `requestAnimationFrame` as its LAST statement (main.ts:865)
 * with no try/catch anywhere in `frame()`. One throw therefore does not drop a
 * frame — it ends that phone's rendering for the rest of the session, while the
 * host keeps simulating happily. The player still walks around (client-side
 * prediction is the only thing that survives), so it reads as
 * "everybody ELSE froze".
 *
 * The throw is netClient.ts:473-474:
 *
 *     this.self.playerCtl!.cash = hud.cash
 *
 * a non-null assertion on a component that `applyWireEntity` only ever creates
 * for `archetype === 'player'` (messages.ts:383-401). So the crash needs exactly
 * one thing: `self` bound to an entity that is not a player.
 *
 * That is reachable because `GameStart` clears `self` and the entity map but
 * NEVER resets `selfId` (netClient.ts:252-262) — only `Go` does, and `Go` is a
 * SEPARATE message. `applySnapshot` binds `self` purely on `we.id === selfId`
 * (netClient.ts:356), so any snapshot processed between GameStart and Go binds
 * `self` to whatever the NEW world happens to have given that id.
 *
 * Both halves are measured, not assumed:
 *  - the real SendQueue emits GameStart -> Snapshot -> Go whenever GameStart
 *    lands 4th in a RELIABLE_BURST (scripts/test/interleave-sweep.mts: reliable
 *    backlog 3 and 7 of 0..8 -> i.e. ~1 in 4 arbitrary queue depths);
 *  - after "New Seed" the stale id lands on a non-player that is inside the
 *    first snapshot for 57/3540 = 1.6% of seed pairs
 *    (scripts/test/selfid-collision-sweep.mts), e.g. oldSeed=1 newSeed=48,
 *    where stale selfId 257 is a `door` in the new world.
 */

const stubInput = (cmd: Partial<InputCmd> = {}): InputSource => ({ sample: () => ({ ...emptyInput(), ...cmd }) })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/** A client wired to a transport we can feed byte-exact, in a chosen order. */
const makeClient = () => {
  let handler: ((e: TransportEvent) => void) | null = null
  const sent: Uint8Array[] = []
  const transport: Transport = {
    role: 'client',
    maxPacket: 180,
    start: async () => {},
    stop: async () => {},
    sendPacket: (_p: PeerId, bytes: Uint8Array) => {
      sent.push(bytes)
      return Promise.resolve()
    },
    on: (h) => {
      handler = h
      return () => {}
    },
    peers: () => ['host'],
  }
  const session = new NetClientSession('Friend', stubInput(), transport)
  /** Deliver a whole message the way the host's SendQueue would: framed, in
   *  180-byte packets, in order. */
  const deliver = (msg: Uint8Array): void => {
    for (const packet of frameMessage(msg, 180)) handler?.({ type: 'data', peer: 'host', bytes: packet })
  }
  return { session, connect: () => handler?.({ type: 'peerConnected', peer: 'host' }), deliver }
}

const wire = (id: number, archetype: string, x = 5, y = 5): WireEntity => ({
  id,
  archetype,
  x,
  y,
  facing: 0,
  hpPct: 1,
  flags: 0,
})

const STALE_SELF_ID = 257 // the client's avatar id in the FIRST run (oldSeed=1)

describe('a client survives a snapshot that arrives between GameStart and Go', () => {
  it('does not bind `self` to a non-player entity, and renderView never throws', async () => {
    const c = makeClient()
    await c.session.start()
    c.connect()
    await flush()

    // --- run 1: normal admission -------------------------------------------
    c.deliver(encodeJson(MsgType.Welcome, { slot: 1, token: 'tok' }))
    c.deliver(encodeJson(MsgType.GameStart, { seed: 1, players: [{ slot: 1, name: 'Friend' }], floor: 1 }))
    c.deliver(encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: STALE_SELF_ID } }))
    c.deliver(
      encodeSnapshot({ tick: 10, floor: 1, alarm: 0, lastInputSeq: 0, entities: [wire(STALE_SELF_ID, 'player')] }),
    )
    c.deliver(
      encodeJson(MsgType.State, {
        floor: 1,
        missionText: 'go',
        missionComplete: false,
        gameOver: false,
        alarm: 0,
        huds: { 1: { cash: 0, weapon: 'pistol', abilityCd: 0, bandages: 0, briefcase: false } },
      }),
    )
    await flush()
    expect(c.session.phase).toBe('playing')
    expect(() => c.session.renderView()).not.toThrow() // healthy baseline

    // --- the party wipes; the host presses "New Seed" -----------------------
    // GameStart re-baselines the level, the entity map and lastSnapTick — but
    // NOT selfId. Then a snapshot of the NEW world arrives before Go, and in
    // that world id 257 is a door (measured: oldSeed=1 -> newSeed=48).
    c.deliver(encodeJson(MsgType.GameStart, { seed: 48, players: [{ slot: 1, name: 'Friend' }], floor: 1 }))
    await flush()
    // The ROOT CAUSE, pinned on its own. GameStart re-baselines the level, the
    // entity map, the floor and lastSnapTick — everything about the run except,
    // as shipped, the id `self` is bound by. Without this assertion the test is
    // satisfied by the downstream guards alone, and a later refactor could drop
    // the reset and still look green.
    expect(
      (c.session as unknown as { selfId: number }).selfId,
      "GameStart left the PREVIOUS run's entity id armed",
    ).toBe(-1)
    c.deliver(
      encodeSnapshot({ tick: 3, floor: 1, alarm: 0, lastInputSeq: 0, entities: [wire(STALE_SELF_ID, 'door')] }),
    )
    await flush()

    const self = (c.session as unknown as { self?: { archetype: string; playerCtl?: unknown } }).self
    // This is the freeze: one throw here and main.ts never reschedules rAF.
    expect(() => c.session.renderView(), `self is a '${self?.archetype}', playerCtl=${self?.playerCtl}`).not.toThrow()
    // The fix re-baselines `selfId` on GameStart, so the stale id matches nothing
    // and we stay UNBOUND until Go names our new avatar. Unbound is correct and
    // harmless (the HUD simply has no self for a few frames); bound to a door is
    // the bug. Assert exactly that: never a non-player.
    expect(
      self === undefined || self.playerCtl !== undefined,
      `client bound self to a '${self?.archetype}' — an entity with no playerCtl`,
    ).toBe(true)

    // ...and it RECOVERS: the moment Go names the new avatar and a snapshot
    // carries it, `self` is a real player again. (Without this leg the test would
    // also pass if the client simply never bound `self` to anything ever again.)
    c.deliver(encodeJson(MsgType.Go, { startTick: 0, entityIds: { 1: 512 } }))
    c.deliver(encodeSnapshot({ tick: 4, floor: 1, alarm: 0, lastInputSeq: 0, entities: [wire(512, 'player')] }))
    await flush()
    const healed = (c.session as unknown as { self?: { archetype: string; playerCtl?: unknown } }).self
    expect(healed?.archetype, 'client never re-bound self after the new run started').toBe('player')
    expect(healed?.playerCtl).toBeDefined()
    expect(() => c.session.renderView()).not.toThrow()
  })
})
