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
  type GoMsg,
  type LobbyStateMsg,
  type StateMsg,
  type WelcomeMsg,
  type WireSnapshot,
} from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, type Transport } from '../net/types'
import type { RenderView, Session } from './session'

const SMOOTH = 0.45 // remote entities chase their snapshot target per tick
const SNAP_DIST = 2.5

export type ClientPhase = 'connecting' | 'lobby' | 'starting' | 'playing' | 'ended' | 'rejected'

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
  private reader = new StreamReader()
  private tickCount = 0
  private inputSeq = 0
  private pendingInputs: { seq: number; cmd: InputCmd }[] = []
  private pendingEdges = { attack: false, interact: false, special: false }
  private lastAckedSeq = 0
  private eventsOut: SimEvent[] = []
  private state: StateMsg = {
    floor: 1,
    missionText: 'Connecting…',
    missionComplete: false,
    gameOver: false,
    alarm: 0,
    huds: {},
  }

  constructor(
    private name: string,
    private classId: string,
    private localInput: InputSource,
    private transport: Transport,
  ) {
    transport.on((ev) => {
      if (ev.type === 'peerConnected') this.onConnected()
      else if (ev.type === 'peerDisconnected') this.setPhase('ended')
      else if (ev.type === 'data') this.reader.push(ev.bytes, (m) => this.onMessage(m))
    })
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  private setPhase(phase: ClientPhase): void {
    this.phase = phase
    this.onPhaseChange?.(phase)
  }

  private onConnected(): void {
    this.queue = new SendQueue(this.transport, 'host', () => this.setPhase('ended'))
    this.queue.queueReliable(encodeJson(MsgType.Hello, { v: PROTOCOL_VERSION, name: this.name, classId: this.classId }))
  }

  private onMessage(msg: Uint8Array): void {
    switch (msg[0]) {
      case MsgType.Snapshot:
        this.applySnapshot(decodeSnapshot(msg))
        break
      case MsgType.Welcome:
        this.slot = decodeJson<WelcomeMsg>(msg).slot
        this.setPhase('lobby')
        break
      case MsgType.Reject:
        this.rejectReason = decodeJson<{ reason: string }>(msg).reason
        this.setPhase('rejected')
        break
      case MsgType.LobbyState:
        this.onLobbyChange?.(decodeJson<LobbyStateMsg>(msg))
        break
      case MsgType.GameStart: {
        const start = decodeJson<{ seed: number }>(msg)
        this.seed = start.seed
        this.floor = 1
        this.level = generateLevel(this.seed, 1)
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

    // Send at ~15Hz (every 2nd tick), latest-wins on the wire
    if (this.tickCount % 2 === 0 && this.queue) {
      this.queue.queueSnapshot(encodeInput(cmd, this.pendingEdges))
      this.pendingEdges = { attack: false, interact: false, special: false }
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
      this.self.playerCtl!.classId = this.classId
      if (this.self.combat) this.self.combat.weapon = hud.weapon
      else this.self.combat = { weapon: hud.weapon, cooldown: 0 }
      this.self.playerCtl!.inventory = [
        ...Array.from({ length: hud.bandages }, () => ({ itemId: 'bandage', qty: 1 })),
        ...(hud.briefcase ? [{ itemId: 'briefcase', qty: 1 }] : []),
      ]
    }
    return {
      entities: [...this.entities.values()],
      events,
      tick: this.tickCount,
      level: this.level ?? emptyLevel(),
      floor: this.state.floor,
      missionText: this.state.missionText,
      missionComplete: this.state.missionComplete,
      gameOver: this.state.gameOver,
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
