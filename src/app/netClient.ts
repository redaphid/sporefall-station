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
import type { KeyValueStore } from './persistence'
import { REJOIN_VERSION, clearRejoin, readRejoin, writeRejoin, type RejoinRecord } from './rejoinStore'
import type { RenderView, Session } from './session'

const SMOOTH = 0.45 // remote entities chase their snapshot target per tick
const SNAP_DIST = 2.5

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

export type ClientPhase = 'connecting' | 'lobby' | 'starting' | 'playing' | 'reconnecting' | 'ended' | 'rejected'

const RECONNECT_ATTEMPTS = 30
const RECONNECT_SPACING_MS = 2000

/**
 * How often (in client ticks, ~30 Hz) the persisted rejoin claim's timestamp is
 * refreshed while we are in a run. ~5 s: the record is ~100 bytes, so this is
 * nothing next to the host's own every-1.5 s world save, and it keeps the claim
 * young enough that the TTL measures "how long since we were last in this run"
 * rather than "how long since we joined it" — a two-hour session must not age
 * its own token out from under itself.
 */
const REJOIN_TOUCH_TICKS = 150

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
  private targets = new Map<number, { x: number; y: number }>()
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
  /** Identity of the host session that issued `rejoinToken` (see netHost.runId).
   * Sent back with a claim so a token can never be matched against a live ghost
   * belonging to a DIFFERENT run. Empty against a pre-runId host. */
  private runId = ''
  /**
   * A claim recovered from durable storage on a COLD boot — the app was killed
   * and relaunched, so `rejoinToken`/`slot` are gone but the seat may still be
   * held for us. Deliberately kept out of `this.slot`: until the host actually
   * answers we own nothing, and a speculative slot would have the HUD reading
   * another player's row. Cleared the moment a Welcome (or a refusal) lands.
   */
  private storedClaim: RejoinRecord | null = null
  /** Did the Hello on THIS link carry a seat claim? Only then is a Reject worth
   * retrying without one. */
  private claimSent = false
  /** One retry per link, so a host that refuses everything cannot be looped. */
  private claimRetried = false
  private lastRejoinTouchTick = -Infinity
  private store?: KeyValueStore
  private now: () => number

  constructor(
    private name: string,
    private localInput: InputSource,
    private transport: Transport,
    /** `store` is durable local storage for the rejoin claim (localStorage in
     * the app; omitted in tests and anywhere storage is unavailable, in which
     * case the token lives in memory only and an app restart loses it — exactly
     * the behaviour that predates this seam). `now` is injected wall clock. */
    opts: { store?: KeyValueStore; now?: () => number } = {},
  ) {
    this.store = opts.store
    this.now = opts.now ?? (() => Date.now())
    // Read the claim ONCE, at construction: this is the only moment that tells a
    // relaunch apart from a fresh join, and `readRejoin` drops anything corrupt
    // or aged out rather than handing us something unusable.
    if (this.store) this.storedClaim = readRejoin(this.store, this.now())
    transport.on((ev) => {
      if (ev.type === 'peerConnected') this.onConnected()
      else if (ev.type === 'peerDisconnected') this.onDisconnected()
      else if (ev.type === 'data') this.reader.push(ev.bytes, (m) => this.onMessage(m))
    })
  }

  /**
   * The seat we are entitled to ask for, or `undefined` to join as a newcomer.
   *
   * Two sources, in priority order. A LIVE reconnect (the radio dropped, the app
   * never died) still uses the in-memory token — it is authoritative and always
   * current. A COLD boot has only what survived in storage, and that is the case
   * this whole feature exists for: without it the host cannot tell a returning
   * player from a stranger, and hands out a new slot and a new avatar while the
   * old ghost keeps the previous seat reserved for the rest of its 90 s grace.
   */
  private rejoinClaim(): { slot: number; token: string; runId?: string } | undefined {
    if (this.phase === 'reconnecting' && this.rejoinToken && this.slot >= 0) {
      return { slot: this.slot, token: this.rejoinToken, ...(this.runId ? { runId: this.runId } : {}) }
    }
    const stored = this.storedClaim
    return stored ? { slot: stored.slot, token: stored.token, runId: stored.runId } : undefined
  }

  /** Write the current seat down so it survives the app being killed. No-op
   * without a store, or before the host has admitted us to anything. */
  private persistRejoin(): void {
    if (!this.store || !this.rejoinToken || this.slot < 0) return
    writeRejoin(this.store, {
      v: REJOIN_VERSION,
      runId: this.runId,
      slot: this.slot,
      token: this.rejoinToken,
      savedAt: this.now(),
    })
    this.lastRejoinTouchTick = this.tickCount
  }

  /** Throw the claim away, in memory and on disk. Called when the host has told
   * us the seat is not ours: a token we know to be dead must never be offered
   * again, or every later join re-runs the same refusal. */
  private forgetRejoin(): void {
    this.storedClaim = null
    this.rejoinToken = ''
    this.runId = ''
    if (this.store) clearRejoin(this.store)
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
    this.onPhaseChange?.(phase)
  }

  private onConnected(): void {
    this.queue = new SendQueue(this.transport, 'host', () => this.onDisconnected())
    const claim = this.rejoinClaim()
    this.claimSent = claim !== undefined
    this.claimRetried = false // a fresh link gets a fresh retry budget
    this.queue.queueReliable(
      encodeJson(MsgType.Hello, {
        v: PROTOCOL_VERSION,
        name: this.name,
        ...(claim ? { rejoin: claim } : {}),
      }),
    )
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
        this.runId = welcome.runId ?? ''
        // The host has spoken: whatever we asked for, THIS is the seat we hold.
        // Write it down before anything else can go wrong, so a kill one second
        // from now still comes back to the same body.
        this.storedClaim = null
        this.claimSent = false
        this.persistRejoin()
        // During a rejoin the host follows up with GameStart+Go; stay out of lobby.
        if (this.phase !== 'reconnecting') this.setPhase('lobby')
        break
      }
      case MsgType.Reject: {
        const reason = decodeJson<{ reason: string }>(msg).reason
        // A refused SEAT CLAIM is not a refused PLAYER. Now that the token
        // outlives the run that minted it, a stale one will be presented sooner
        // or later — the grace expired while the app was being relaunched, a
        // teammate got there first, the parked avatar did not survive. Every one
        // of those used to end here, on a dead "rejected" screen, for someone the
        // host would happily have admitted as a newcomer one message later.
        // Drop the dead token and ask again as a stranger, once. The host leaves
        // a refused peer at slot -1 precisely so a follow-up Hello still works.
        if (this.claimSent && !this.claimRetried && this.queue) {
          this.claimRetried = true
          this.claimSent = false
          this.forgetRejoin()
          this.queue.queueReliable(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: this.name }))
          break
        }
        this.rejectReason = reason
        this.setPhase('rejected')
        break
      }
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
      if (we.id === this.selfId) {
        this.self = e
        this.reconcile(we)
      } else {
        this.targets.set(we.id, { x: we.x, y: we.y })
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

    // Keep the stored claim young while we are actually in the run — see
    // REJOIN_TOUCH_TICKS. Without this the TTL would count from the moment we
    // joined, and a long session would expire its own seat mid-play.
    if (this.tickCount - this.lastRejoinTouchTick >= REJOIN_TOUCH_TICKS) this.persistRejoin()

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

    // Everyone else eases toward their snapshot target
    for (const [id, target] of this.targets) {
      const e = this.entities.get(id)
      if (!e || id === this.selfId) continue
      const dx = target.x - e.pos.x
      const dy = target.y - e.pos.y
      if (Math.hypot(dx, dy) > SNAP_DIST) {
        e.pos.x = target.x
        e.pos.y = target.y
        e.prevPos.x = target.x
        e.prevPos.y = target.y
      } else {
        e.pos.x += dx * SMOOTH
        e.pos.y += dy * SMOOTH
      }
    }
  }

  renderView(): RenderView {
    const events = this.eventsOut
    this.eventsOut = []
    const hud = this.state.huds[this.slot]
    if (this.self && hud) {
      // Surface host-tracked HUD numbers on our local entity for the HUD widget
      this.self.playerCtl!.cash = hud.cash
      this.self.playerCtl!.abilityCooldown = hud.abilityCd
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
