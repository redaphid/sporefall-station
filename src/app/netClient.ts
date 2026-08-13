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

const SMOOTH = 0.45 // remote entities chase their snapshot target per tick
const SNAP_DIST = 2.5

export type ClientPhase = 'connecting' | 'lobby' | 'starting' | 'playing' | 'reconnecting' | 'ended' | 'rejected'

const RECONNECT_ATTEMPTS = 30
const RECONNECT_SPACING_MS = 2000

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
    this.onPhaseChange?.(phase)
  }

  private onConnected(): void {
    this.queue = new SendQueue(this.transport, 'host', () => this.onDisconnected())
    const rejoining = this.phase === 'reconnecting' && this.rejoinToken && this.slot >= 0
    this.queue.queueReliable(
      encodeJson(MsgType.Hello, {
        v: PROTOCOL_VERSION,
        name: this.name,
        ...(rejoining ? { rejoin: { slot: this.slot, token: this.rejoinToken } } : {}),
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
        // During a rejoin the host follows up with GameStart+Go; stay out of lobby.
        if (this.phase !== 'reconnecting') this.setPhase('lobby')
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
        this.seed = start.seed
        if (start.mode) this.state.mode = start.mode
        if (this.phase === 'reconnecting') break // level already live; snapshots resync the floor
        // A lobby start is always floor 1, but a LATE join drops us into a run
        // already in progress. Build the floor the host is actually on, or we
        // render floor 1's map — and the walls we collide against — until the
        // first snapshot happens to arrive and correct us. Absent means an older
        // host that only ever starts from the lobby: floor 1.
        this.floor = start.floor ?? 1
        this.level = generateLevel(this.seed, this.floor)
        // Keep the HUD's floor number honest from the first frame too; otherwise
        // it reads "1" over a floor-3 map until the next State message.
        this.state.floor = this.floor
        // Fresh run (initial start OR a host "play again" after game-over): drop
        // the previous run's entities so nothing stale lingers before snapshots.
        this.entities.clear()
        this.targets.clear()
        this.self = undefined
        this.localInv = undefined // fresh run: wait for the host's authoritative inventory
        this.onLevelChange?.(this.level)
        this.setPhase('starting')
        break
      }
      case MsgType.Go: {
        const go = decodeJson<GoMsg>(msg)
        this.selfId = go.entityIds[this.slot] ?? -1
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
        this.state = decodeJson<StateMsg>(msg)
        if (this.state.floor !== this.floor) this.changeFloor(this.state.floor)
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

  private changeFloor(floor: number): void {
    this.floor = floor
    this.level = generateLevel(this.seed, floor)
    this.entities.clear()
    this.targets.clear()
    this.self = undefined
    this.onLevelChange?.(this.level)
  }

  private applySnapshot(snap: WireSnapshot): void {
    if (snap.floor !== this.floor) this.changeFloor(snap.floor)
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
