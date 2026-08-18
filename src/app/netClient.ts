import type { Entity } from '../game/entity'
import { generateLevel } from '../game/levelgen/generate'
import type { Level } from '../game/levelgen/level'
import { isSolidTile } from '../game/levelgen/level'
import { moveAndCollide } from '../game/systems/movement'
import { SIM_DT, type InputCmd, type SimEvent } from '../game/types'
import type { InputSource } from '../input/input'
import { SendQueue } from '../net/channel/sendQueue'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { StreamReader } from '../net/framing/chunkedStream'
import {
  applyWireEntity,
  decodeSnapshot,
  encodeInput,
  type EventsMsg,
  type GameStartMsg,
  type GoMsg,
  type InventoryMsg,
  type LobbyStateMsg,
  type StateMsg,
  type WelcomeMsg,
  type WireSnapshot,
} from '../net/protocol/messages'
import { isKnownMsgType, MsgType, PROTOCOL_VERSION, type Transport } from '../net/types'
import type { RenderView, Session } from './session'

/**
 * Remote entities ease toward the last position a snapshot gave them. Snapshots
 * are 10 Hz against a 30 Hz sim (`SNAPSHOT_INTERVAL_TICKS = 3`), so that target
 * is stale by up to a full interval: the error being chased GROWS for three
 * ticks and collapses when the next snapshot lands. Easing a fixed fraction of
 * a sawtooth error draws a sawtooth SPEED. Measured on a clean link with ZERO
 * packet loss, a teammate walking at a constant 4.50 tiles/s was drawn at
 * 7.16 -> 3.94 -> 2.17 -> 7.16 tiles/s, a 3.3x pulse repeating at 10 Hz for as
 * long as they walked. Packet loss then compounds it: against a target that
 * stopped updating, the entity coasts to a near standstill (0.38 tiles/s) and
 * then darts at 12.44 tiles/s when the next snapshot arrives.
 *
 * So aim at where the entity is GOING, not where it last was: project the target
 * forward along the velocity the last two snapshots imply. That velocity is
 * inferred HERE rather than sent — deliberately. Two bytes per entity on a 10B
 * record takes a typical snapshot from 2 BLE packets to 3, and losing any one
 * fragment loses the whole message, so whole-snapshot loss at 5% packet loss
 * would rise 9.75% -> 14.3%: it would manufacture more of the very gaps it is
 * meant to cover.
 */
const SMOOTH = 0.3 // fraction of the remaining error a remote entity closes per tick
/**
 * Projectiles keep the OLD, tighter, unprojected chase. They fly at 7-9 tiles/s
 * (`data/items.ts`), so a 400 ms gap already carries them 3.6 tiles — past
 * `SNAP_DIST` — and they honestly teleport. Projecting them would instead slide
 * them fast PAST the impact point, on the one entity class whose exact position
 * is about to matter, and they are too short-lived for a two-snapshot velocity
 * estimate to be worth much anyway.
 */
const SMOOTH_PROJECTILE = 0.45
const SNAP_DIST = 2.5
/**
 * Ceiling on how far ahead of its last snapshot a target may be projected:
 * 150 ms at 30 Hz. Past this the projection freezes, so a link that stops
 * delivering degrades to "the sprite stands still" — never "the sprite keeps
 * walking off through a wall forever".
 */
const PROJECT_CAP_TICKS = 4.5

/**
 * Is `tick` strictly newer than `prev` on the u32 wire counter?
 *
 * BLE packet loss desynchronises the framing layer, which resynchronises IN-BAND
 * (`StreamReader.onDesync`) — and that is exactly how a client is handed a
 * DUPLICATED or REORDERED frame. Ordering therefore has to be decided from the
 * payload, not from arrival order.
 *
 * `encodeSnapshot` writes the tick as u32 (`ByteWriter.u32` masks with `>>> 0`),
 * so the counter wraps at 2^32 — ~4.5 years at 30 Hz, but a plain `tick > prev`
 * would wedge a client FOREVER on the far side of that wrap. Serial-number
 * comparison (RFC 1982) instead: newer iff the unsigned forward distance is
 * non-zero and shorter than half the space. Equal ticks are NOT newer, so a
 * verbatim duplicate is rejected too.
 */
export const isNewerTick = (tick: number, prev: number): boolean => {
  const forward = (tick - prev) >>> 0
  return forward !== 0 && forward < 0x8000_0000
}

export type ClientPhase =
  | 'connecting'
  | 'lobby'
  | 'starting'
  | 'playing'
  | 'reconnecting'
  | 'ended'
  | 'rejected'
  /** Gave up on the join handshake: the link is up but the host never answered. */
  | 'unreachable'

const RECONNECT_ATTEMPTS = 30
const RECONNECT_SPACING_MS = 2000

/**
 * JOIN HANDSHAKE RETRANSMISSION.
 *
 * Admission is four messages — Hello up, then Welcome / GameStart / Go down —
 * and NONE of them is acknowledged. Both BLE transports notify with
 * `type: 'withoutResponse'` (bleTransport.ts, webBluetoothTransport.ts), and
 * the "reliable" lane (net/channel/sendQueue.ts) is reliable only in the sense
 * that it never DROPS a queued message: it retries once on a `sendPacket`
 * throw and then kills the link. Nothing on the wire ever says "I got that".
 *
 * So a single lost packet in either direction used to end the join, silently
 * and permanently: the client sat on "Looking for a host…" with the BLE link
 * still healthy, so nothing errored, nothing timed out and nothing retried.
 * Measured against the real sessions (e2e/net-recovery-probes.mts --probe a),
 * 2% packet loss failed ~6% of joins and 10% failed ~25% — and not one of them
 * ever recovered, however long the host kept simulating.
 *
 * The fix is the cheapest one that works: ASK AGAIN. The client re-sends the
 * same Hello on a timer while it is still waiting on a reply, and the host
 * answers a duplicate Hello idempotently (netHost.ts `reanswerAdmission` — no
 * new slot, no second avatar, just the same admission replayed). Retries stop
 * the instant the handshake completes, so a joined client puts ZERO extra
 * bytes on the wire — there is no keepalive here.
 *
 * Bounded on purpose. Retrying forever with nothing on screen is the same
 * silent hang wearing a different hat, so after `HELLO_MAX_ATTEMPTS` the phase
 * goes to `unreachable` and main.ts tells the player, in words, that the host
 * did not answer.
 */
const HELLO_FIRST_RETRY_MS = 1000
const HELLO_RETRY_MS = 2000
/** 1 initial Hello + 8 retries ≈ 15s before we admit defeat out loud. */
const HELLO_MAX_ATTEMPTS = 9

/**
 * Client: predicts its own avatar with the shared movement code,
 * smooths everyone else toward snapshot targets, renders host state.
 */
export class NetClientSession implements Session {
  phase: ClientPhase = 'connecting'
  rejectReason = ''
  slot = -1
  onPhaseChange?: (phase: ClientPhase) => void
  onLobbyChange?: (msg: LobbyStateMsg) => void
  onLevelChange?: (level: Level) => void

  private level!: Level
  private seed = 0
  private floor = 1
  private entities = new Map<number, Entity>()
  /** Per remote entity: the newest snapshot position, the one before it, and the
   * client ticks each landed on — everything client-side velocity inference needs. */
  private targets = new Map<number, { x: number; y: number; px: number; py: number; t: number; pt: number }>()
  private selfId = -1
  private self?: Entity
  private queue!: SendQueue
  /** Packet loss can desynchronise the framing while the transport link stays
   * UP, so nothing would ever fire peerDisconnected. The reader detects that
   * itself and resynchronises in-band; these counters surface it. */
  streamDesyncs = 0
  private reader = new StreamReader({
    isValidStart: isKnownMsgType,
    onDesync: (reason) => {
      this.streamDesyncs++
      this.onStreamDesync?.(reason)
    },
  })
  /** Diagnostics hook (the on-screen co-op debug log wires this up). */
  onStreamDesync?: (reason: string) => void
  private tickCount = 0
  /**
   * Wire tick of the newest snapshot APPLIED, or -1 before the first one of a
   * run. Snapshot ticks are u32 on the wire (`encodeSnapshot`), so they are
   * compared with serial arithmetic rather than `>` — see `isNewerTick`.
   *
   * Snapshots ride a LATEST-WINS lane (SendQueue's capacity-1 slot), so one that
   * turns up behind a newer one carries nothing but stale truth: applying it
   * drags every remote entity back to where they used to be, winds `lastAckedSeq`
   * backwards so already-acked inputs get replayed, and — worst — a stale `floor`
   * would re-run `changeFloor`, regenerating the previous level and wiping every
   * entity on the live one. (`changeFloor` is independently guarded against that
   * last one; this guard stops the other two.)
   *
   * Re-baselined to -1 on BOTH `GameStart` and `Go`, which are the only points at
   * which the host's tick counter may legitimately go backwards (a "play again"
   * rebuilds its world at tick 0).
   */
  private lastSnapTick = -1
  /** The exact Hello bytes for this link, kept so a retry re-asks identically. */
  private helloBytes: Uint8Array | null = null
  private helloAttempts = 0
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * A snapshot has landed on this link. It is the only proof a lobby-phase
   * client gets that the host has ALREADY STARTED — i.e. that our GameStart/Go
   * was lost, rather than the host simply not having pressed Start yet. Without
   * it, "still in the lobby" and "silently stranded" look identical and we
   * would either re-ask forever in a healthy lobby or never re-ask at all.
   */
  private sawSnapshot = false
  private inputSeq = 0
  private pendingInputs: { seq: number; cmd: InputCmd }[] = []
  private pendingEdges = { attack: false, interact: false, special: false, roll: false, throwItem: false }
  /** Hotbar slot tapped since the last input packet went out (-1 = none). Latched
   * so a tap between send-ticks isn't dropped — the host applies it as an edge. */
  private pendingHotbar = -1
  private lastAckedSeq = 0
  /** Our OWN player's authoritative inventory, streamed by the host on change. */
  private localInv?: InventoryMsg
  private eventsOut: SimEvent[] = []
  private state: StateMsg = {
    floor: 1,
    missionText: 'Connecting…',
    missionComplete: false,
    gameOver: false,
    alarm: 0,
    huds: {},
  }

  private rejoinToken = ''

  constructor(
    private name: string,
    private localInput: InputSource,
    private transport: Transport,
  ) {
    transport.on((ev) => {
      if (ev.type === 'peerConnected') this.onConnected()
      else if (ev.type === 'peerDisconnected') this.onDisconnected()
      else if (ev.type === 'data') this.reader.push(ev.bytes, (m) => this.onMessage(m))
    })
  }

  private onDisconnected(): void {
    this.reader.reset() // a fresh link starts a fresh byte stream
    // Mid-game drop with a rejoin token and a reconnect-capable transport:
    // keep trying quietly; the host holds our avatar for 90s.
    if (this.phase === 'playing' && this.rejoinToken && this.transport.reconnect) {
      this.setPhase('reconnecting')
      void this.reconnectLoop()
      return
    }
    if (this.phase !== 'reconnecting') this.setPhase('ended')
  }

  private async reconnectLoop(): Promise<void> {
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS && this.phase === 'reconnecting'; attempt++) {
      await new Promise((r) => setTimeout(r, RECONNECT_SPACING_MS))
      if (this.phase !== 'reconnecting') return
      try {
        await this.transport.reconnect!()
        // Some transports resolve before the link is confirmed — give the
        // peerConnected event a moment, then check.
        await new Promise((r) => setTimeout(r, 1000))
        if (this.transport.peers().length > 0) return // peerConnected handler sent the rejoin Hello
      } catch {
        // radio still gone — try again
      }
    }
    if (this.phase === 'reconnecting') this.setPhase('ended')
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  private setPhase(phase: ClientPhase): void {
    this.phase = phase
    // Every phase change is a chance to arm the handshake retry (we just moved
    // into a state that is waiting on the host) or to shut it off for good.
    this.syncHelloRetry()
    this.onPhaseChange?.(phase)
  }

  /**
   * Are we waiting on an admission reply that nothing will ever re-send?
   *
   *  • `connecting` — Hello or Welcome was lost.
   *  • `starting`   — GameStart landed, Go did not. (The commonest failure in
   *                   the loss probe after a lost Hello.)
   *  • `lobby` + a snapshot — the run is demonstrably UNDER WAY and we are not
   *                   in it, so our GameStart/Go went missing. A lobby with no
   *                   snapshots is a healthy client waiting for the host to
   *                   press Start; re-asking there would burn bytes for as long
   *                   as the lobby stays open, so it deliberately does not.
   *
   * `reconnecting` is excluded on purpose: `reconnectLoop` already owns a
   * bounded retry for that path (30 × 2s, then `ended`), and a second state
   * machine racing it would fight over the phase.
   */
  private awaitingAdmission(): boolean {
    if (this.phase === 'connecting' || this.phase === 'starting') return true
    return this.phase === 'lobby' && this.sawSnapshot
  }

  /** Arm the retry iff we are still owed a reply; otherwise make sure it is off. */
  private syncHelloRetry(): void {
    if (!this.awaitingAdmission() || !this.helloBytes) {
      if (this.helloTimer) clearTimeout(this.helloTimer)
      this.helloTimer = null
      return
    }
    if (this.helloTimer) return // already armed; don't restart the clock
    this.helloTimer = setTimeout(
      () => {
        this.helloTimer = null
        if (!this.awaitingAdmission()) return
        if (this.helloAttempts >= HELLO_MAX_ATTEMPTS) {
          // Out of attempts with the link still up. Say so — a join that keeps
          // retrying behind a frozen status line is the bug, not the fix.
          this.setPhase('unreachable')
          return
        }
        this.sendHello()
      },
      this.helloAttempts <= 1 ? HELLO_FIRST_RETRY_MS : HELLO_RETRY_MS,
    )
  }

  /**
   * Put the Hello on the wire (again). Byte-identical every time: the host
   * treats a duplicate as "say it again", and an identical one can never be
   * mistaken for a second player. Re-framed by the SendQueue each time, so the
   * 20-byte `maxPacket` floor (bleTransport's MTU fallback, where the handshake
   * becomes 4+ packets per message and loss compounds) retries as a whole
   * message, not as whichever fragment went missing.
   */
  private sendHello(): void {
    if (!this.helloBytes || !this.queue) return
    this.helloAttempts++
    this.queue.queueReliable(this.helloBytes)
    this.syncHelloRetry()
  }

  private onConnected(): void {
    this.queue = new SendQueue(this.transport, 'host', () => this.onDisconnected())
    const rejoining = this.phase === 'reconnecting' && this.rejoinToken && this.slot >= 0
    // A fresh link is a fresh handshake: new bytes, attempts back to zero, and
    // no stale "we already saw the run running" from the previous connection.
    this.helloBytes = encodeJson(MsgType.Hello, {
      v: PROTOCOL_VERSION,
      name: this.name,
      ...(rejoining ? { rejoin: { slot: this.slot, token: this.rejoinToken } } : {}),
    })
    this.helloAttempts = 0
    this.sawSnapshot = false
    this.sendHello()
  }

  private onMessage(msg: Uint8Array): void {
    try {
      this.handleMessage(msg)
    } catch {
      // A truncated/garbage/hostile packet (bad JSON, a snapshot whose declared
      // entity count runs past the buffer) must never take the client down: drop
      // it and keep rendering. Without this, the throw also wedges the StreamReader
      // (its buffer never advances past the bad frame), stalling every later message.
    }
  }

  private handleMessage(msg: Uint8Array): void {
    switch (msg[0]) {
      case MsgType.Snapshot:
        this.applySnapshot(decodeSnapshot(msg))
        break
      case MsgType.Welcome: {
        const welcome = decodeJson<WelcomeMsg>(msg)
        this.slot = welcome.slot
        this.rejoinToken = welcome.token
        // During a rejoin the host follows up with GameStart+Go; stay out of lobby.
        //
        // A Welcome can now arrive a SECOND time — the host re-answers a retried
        // Hello idempotently, and our retry can cross its reply in flight. It
        // must never drag a client that is already past the lobby back to the
        // lobby screen: `starting` would lose its GameStart, and `playing` would
        // put a live player back on "waiting for host to start" mid-run. Only
        // ever promote FORWARD out of `connecting`; the other exclusions keep
        // the pre-existing behaviour for every phase that already reached here.
        if (this.phase !== 'reconnecting' && this.phase !== 'starting' && this.phase !== 'playing') this.setPhase('lobby')
        break
      }
      case MsgType.Reject:
        this.rejectReason = decodeJson<{ reason: string }>(msg).reason
        this.setPhase('rejected')
        break
      case MsgType.LobbyState:
        this.onLobbyChange?.(decodeJson<LobbyStateMsg>(msg))
        break
      case MsgType.GameStart: {
        const start = decodeJson<GameStartMsg>(msg)
        const sameRun = start.seed === this.seed
        this.seed = start.seed
        if (start.mode) this.state.mode = start.mode
        // A GameStart while we are reconnecting normally replays the run we were
        // ALREADY in (the host repeats it after a ghost reclaim), so the level is
        // already live and snapshots resync the floor. But if the SEED changed,
        // the host is running a DIFFERENT run — its app restarted, or it
        // re-seeded while we were off the air. Keeping our old level would leave
        // us walking a map the host is not simulating: we collide with walls that
        // are not there and never reach an exit, with no error anywhere to
        // explain it. Fall through and rebuild from the new seed.
        if (this.phase === 'reconnecting' && sameRun) break
        // A lobby start is always floor 1, but a LATE join drops us into a run
        // already in progress. Build the floor the host is actually on, or we
        // render floor 1's map — and the walls we collide against — until the
        // first snapshot happens to arrive and correct us. Absent means an older
        // host that only ever starts from the lobby: floor 1.
        //
        // This is a DIRECT assignment, deliberately not `changeFloor`: that is
        // guarded to move strictly DEEPER, and a new run legitimately restarts at
        // floor 1 after a party reached floor 5. GameStart is the one message
        // that re-baselines the floor in either direction.
        this.floor = start.floor ?? 1
        this.level = generateLevel(this.seed, this.floor)
        // Keep the HUD's floor number honest from the first frame too; otherwise
        // it reads "1" over a floor-3 map until the next State message. This also
        // resets the monotonic HUD clamp in the `State` handler, so a new run's
        // floor 1 is not held up at the old run's floor 5.
        this.state.floor = this.floor
        // Fresh run (initial start OR a host "play again" after game-over): drop
        // the previous run's entities so nothing stale lingers before snapshots.
        this.entities.clear()
        this.targets.clear()
        this.self = undefined
        // ...AND the id we bind `self` by. This used to be the one thing GameStart
        // did NOT reset, and it was load-bearing: `Go` is a SEPARATE message, so a
        // snapshot of the NEW world that lands in between was matched against the
        // PREVIOUS run's entity id. In the new world that id is whatever the
        // generator happened to hand it — measured at 1.6% of seed pairs it is a
        // door — and `self` bound to a non-player made renderView throw, which
        // (before the frame loop was made crash-proof) ended that phone's rendering
        // for the whole session. Unbound until Go says otherwise.
        this.selfId = -1
        this.localInv = undefined // fresh run: wait for the host's authoritative inventory
        // "Play again" rebuilds the host's world from scratch (netHost.restart →
        // createWorld), so its tick counter goes back to 0. Re-baseline, or every
        // snapshot of the new run would look older than the last one of the old
        // run and be rejected as a replay — a permanently frozen screen.
        this.lastSnapTick = -1
        this.onLevelChange?.(this.level)
        this.setPhase('starting')
        break
      }
      case MsgType.Go: {
        const go = decodeJson<GoMsg>(msg)
        this.selfId = go.entityIds[this.slot] ?? -1
        // Go is the last message of every admission — fresh start, late join AND
        // ghost rejoin — and each one may hand us a host whose tick counter bears
        // no relation to the previous one's. Deliberately belt-and-braces with the
        // GameStart reset above (Go always follows it, so either alone covers
        // "play again" today): a rejoin takes the `reconnecting` early-break out
        // of GameStart and never reaches that line, and the failure mode this
        // averts is a client frozen on a dead screen for the rest of the run.
        this.lastSnapTick = -1
        this.setPhase('playing')
        break
      }
      case MsgType.Events: {
        const ev = decodeJson<EventsMsg>(msg)
        for (const e of ev.events as SimEvent[]) {
          this.eventsOut.push(e)
          if (e.type === 'floorChange') this.changeFloor(e.floor)
        }
        break
      }
      case MsgType.State: {
        const next = decodeJson<StateMsg>(msg)
        this.changeFloor(next.floor) // guarded: only a DEEPER floor rebuilds the level
        // The HUD floor rides this message, and a replayed State would walk the
        // number back under a map we are no longer allowed to regenerate — map
        // says 3, HUD says 2. Never let the displayed floor go backwards; a fresh
        // run resets it above, in GameStart.
        this.state = { ...next, floor: Math.max(next.floor, this.state.floor) }
        break
      }
      case MsgType.Inventory: {
        const inv = decodeJson<InventoryMsg>(msg)
        // The host only ships us our own, but guard the slot defensively.
        if (inv.slot === this.slot) this.localInv = inv
        break
      }
    }
  }

  /**
   * Rebuild the level for a floor the host has moved to. Layout never crosses
   * the wire, so this one number is the whole map — and rebuilding it wipes the
   * entity set, because those entities belong to the floor we are leaving.
   *
   * Inside a run the floor only ever goes UP (`w.floor++`, systems/missions.ts);
   * a new run arrives as GameStart, which resets `this.floor` directly. So a
   * floor that is not strictly deeper than the current one can ONLY be a stale
   * or duplicate delivery, and acting on it regenerates a floor the host has
   * already left and vanishes every entity on screen. Ignore it.
   *
   * A genuinely deeper floor still applies — including a multi-floor jump for a
   * client that missed the events entirely, which is how a snapshot self-heals
   * a client onto the right map.
   */
  private changeFloor(floor: number): void {
    if (floor <= this.floor) return
    this.floor = floor
    this.level = generateLevel(this.seed, floor)
    this.entities.clear()
    this.targets.clear()
    this.self = undefined
    this.onLevelChange?.(this.level)
  }

  private applySnapshot(snap: WireSnapshot): void {
    // Snapshots are the host SIMULATING, which means the run has started. If we
    // are still sitting in the lobby, our GameStart/Go was lost and no one will
    // send it again unasked — re-open the handshake retry. Set before the
    // staleness guard below: even a replayed snapshot proves the run is live.
    if (!this.sawSnapshot) {
      this.sawSnapshot = true
      this.syncHelloRetry()
    }
    // A replayed snapshot is a time machine: every entity is restored to where it
    // stood seconds ago, and `reconcile` hauls the PREDICTED avatar back with them
    // (measured at 5.56 tiles). `lastInputSeq` is stale too, so it would re-arm
    // inputs the host has long since consumed. Drop anything not strictly newer —
    // duplicates included — and let the next real snapshot self-heal as before.
    if (this.lastSnapTick >= 0 && !isNewerTick(snap.tick, this.lastSnapTick)) return
    this.lastSnapTick = snap.tick
    this.changeFloor(snap.floor) // guarded: only a DEEPER floor rebuilds the level
    this.lastAckedSeq = snap.lastInputSeq
    const seen = new Set<number>()
    for (const we of snap.entities) {
      seen.add(we.id)
      let e = this.entities.get(we.id)
      const isNew = !e
      e = applyWireEntity(e, we, this.tickCount)
      if (isNew) {
        e.pos.x = we.x
        e.pos.y = we.y
        e.prevPos.x = we.x
        e.prevPos.y = we.y
        this.entities.set(we.id, e)
      }
      // Bind by id AND by "is actually a player". The id reset above closes the
      // known hole; this closes the CLASS of them — every consumer of `self`
      // (renderView's HUD merge, stepSelf, reconcile) assumes a playerCtl, so a
      // mismatched id must leave us unbound rather than piloting the scenery.
      if (we.id === this.selfId && e.playerCtl) {
        this.self = e
        this.reconcile(we)
      } else {
        const prev = this.targets.get(we.id)
        this.targets.set(we.id, {
          x: we.x,
          y: we.y,
          // First sighting: previous == current, so the span below is 0 and
          // nothing is projected until a SECOND snapshot has measured a velocity.
          px: prev?.x ?? we.x,
          py: prev?.y ?? we.y,
          t: this.tickCount,
          pt: prev?.t ?? this.tickCount,
        })
      }
    }
    for (const id of this.entities.keys()) {
      if (!seen.has(id)) {
        this.entities.delete(id)
        this.targets.delete(id)
      }
    }
  }

  /** Rewind to the authoritative position and replay unacked inputs. */
  private reconcile(we: { x: number; y: number }): void {
    const self = this.self!
    this.pendingInputs = this.pendingInputs.filter((p) => p.seq > this.lastAckedSeq)
    const px = self.pos.x
    const py = self.pos.y
    self.pos.x = we.x
    self.pos.y = we.y
    for (const pending of this.pendingInputs) {
      this.stepSelf(pending.cmd)
    }
    // If the replayed result is close to where we already were, keep the smooth version.
    if (Math.hypot(self.pos.x - px, self.pos.y - py) < 0.5) {
      self.pos.x = px
      self.pos.y = py
    }
  }

  private blocked = (tx: number, ty: number): boolean => {
    if (isSolidTile(this.level, tx, ty)) return true
    for (const e of this.entities.values()) {
      if (e.door && !e.door.open && Math.floor(e.pos.x) === tx && Math.floor(e.pos.y) === ty) return true
    }
    return false
  }

  private stepSelf(cmd: InputCmd): void {
    const self = this.self
    if (!self || self.playerCtl?.downed) return
    const len = Math.hypot(cmd.moveX, cmd.moveY)
    if (len < 0.01) return
    const norm = len > 1 ? 1 / len : 1
    const speed = 4.5 // class speeds vary ±1; mispredictions get reconciled
    self.facing = Math.atan2(cmd.moveY * norm, cmd.moveX * norm)
    moveAndCollide(self, cmd.moveX * norm * speed * SIM_DT, cmd.moveY * norm * speed * SIM_DT, this.blocked)
  }

  tick(): void {
    this.tickCount++
    if (this.phase !== 'playing') return

    const cmd = this.localInput.sample()
    cmd.seq = ++this.inputSeq
    this.pendingEdges.attack ||= cmd.attack
    this.pendingEdges.interact ||= cmd.interact
    this.pendingEdges.special ||= cmd.special
    this.pendingEdges.roll ||= cmd.roll
    this.pendingEdges.throwItem ||= cmd.throwItem
    // Hotbar/Use are taps that can land on a non-send tick — latch them so the
    // next packet still carries the equip/throw instead of dropping it.
    if (cmd.hotbar >= 0) this.pendingHotbar = cmd.hotbar

    // Send at ~15Hz (every 2nd tick). Movement/aim ride the capacity-1 snapshot
    // lane (latest-wins — a stale queued input is fine to drop). But roll / throw /
    // hotbar are PURE edges with no held-state fallback: if their packet were
    // dropped by a newer one overwriting the slot during a BLE stall, the tap would
    // be silently lost (the #57 class of bug). Ship those on the reliable lane so
    // they can never be overwritten; the host still gates them by seq so a delayed
    // reliable input can't re-fire. attack/interact/special keep the snapshot lane —
    // their held bit re-conveys intent on the next packet, and sustained fire would
    // otherwise flood the reliable FIFO every tick.
    if (this.tickCount % 2 === 0 && this.queue) {
      const packet = encodeInput({ ...cmd, hotbar: this.pendingHotbar }, this.pendingEdges)
      const hasPureEdge = this.pendingEdges.roll || this.pendingEdges.throwItem || this.pendingHotbar >= 0
      if (hasPureEdge) this.queue.queueReliable(packet)
      else this.queue.queueSnapshot(packet)
      this.pendingEdges = { attack: false, interact: false, special: false, roll: false, throwItem: false }
      this.pendingHotbar = -1
    }

    // Predict own movement immediately
    for (const e of this.entities.values()) {
      e.prevPos.x = e.pos.x
      e.prevPos.y = e.pos.y
    }
    this.stepSelf(cmd)
    this.pendingInputs.push({ seq: cmd.seq, cmd })
    if (this.pendingInputs.length > 60) this.pendingInputs.shift()

    // Everyone else eases toward their snapshot target, projected forward along
    // the velocity the last two snapshots imply so it is not a stale one.
    for (const [id, target] of this.targets) {
      const e = this.entities.get(id)
      if (!e || id === this.selfId) continue
      const stepX = target.x - target.px
      const stepY = target.y - target.py
      const span = target.t - target.pt
      // A step longer than SNAP_DIST was a TELEPORT (respawn, floor change, a
      // host-side shove), not motion. Inferring a velocity from it would fling
      // the sprite across the room at the speed of the teleport.
      const projectable =
        span > 0 && e.kind !== 'projectile' && Math.hypot(stepX, stepY) <= SNAP_DIST
      let tx = target.x
      let ty = target.y
      if (projectable) {
        const ahead = Math.min(Math.max(0, this.tickCount - target.t), PROJECT_CAP_TICKS)
        tx += (stepX / span) * ahead
        ty += (stepY / span) * ahead
      }
      const dx = tx - e.pos.x
      const dy = ty - e.pos.y
      if (Math.hypot(dx, dy) > SNAP_DIST) {
        e.pos.x = tx
        e.pos.y = ty
        e.prevPos.x = tx
        e.prevPos.y = ty
      } else {
        const k = e.kind === 'projectile' ? SMOOTH_PROJECTILE : SMOOTH
        e.pos.x += dx * k
        e.pos.y += dy * k
      }
    }
  }

  renderView(): RenderView {
    const events = this.eventsOut
    this.eventsOut = []
    const hud = this.state.huds[this.slot]
    // `playerCtl` is CHECKED, not asserted: rendering must never be the thing
    // that throws. It is the last frame of the session if it does.
    if (this.self?.playerCtl && hud) {
      // Surface host-tracked HUD numbers on our local entity for the HUD widget
      this.self.playerCtl.cash = hud.cash
      this.self.playerCtl.abilityCooldown = hud.abilityCd
      if (this.self.combat) this.self.combat.weapon = hud.weapon
      else this.self.combat = { weapon: hud.weapon, cooldown: 0 }
    }
    // Our OWN player carries the FULL authoritative inventory the host streams us
    // (slots / activeSlot / per-weapon mods / ammo) so weapon switching, item use
    // and mod badges all work as a joiner. Until that first inventory arrives, fall
    // back to the HUD bandage/briefcase summary so nothing phantom-floods the hotbar.
    if (this.self?.playerCtl) {
      const ld = (this.self.loadout ??= { inventory: [], activeSlot: -1 })
      if (this.localInv) {
        ld.inventory = this.localInv.inventory
        ld.activeSlot = this.localInv.activeSlot
        if (this.self.combat) this.self.combat.weapon = this.localInv.weapon
        else this.self.combat = { weapon: this.localInv.weapon, cooldown: 0 }
      } else if (hud) {
        ld.inventory = [
          ...(hud.bandages > 0 ? [{ itemId: 'bandage', qty: hud.bandages }] : []),
          ...(hud.briefcase ? [{ itemId: 'briefcase', qty: 1 }] : []),
        ]
      }
    }
    const missionText =
      this.phase === 'reconnecting'
        ? 'Bluetooth dropped — reconnecting…'
        : this.phase === 'ended' && this.selfId >= 0
          ? 'Connection lost'
          : this.state.missionText
    return {
      entities: [...this.entities.values()],
      events,
      tick: this.tickCount,
      level: this.level ?? emptyLevel(),
      floor: this.state.floor,
      missionText,
      missionComplete: this.state.missionComplete,
      missionTargetId: this.state.missionTargetId,
      gameOver: this.state.gameOver,
      alert: this.state.alert,
      mode: this.state.mode,
      revivesLeft: this.state.revivesLeft,
      self: this.self,
    }
  }
}

let cachedEmpty: Level | null = null
const emptyLevel = (): Level => {
  if (!cachedEmpty) {
    cachedEmpty = {
      w: 1,
      h: 1,
      tiles: new Uint8Array(1),
      solid: new Uint8Array(1),
      buildings: [],
      spawn: { x: 0.5, y: 0.5 },
      exit: { x: 0, y: 0 },
    }
  }
  return cachedEmpty
}
