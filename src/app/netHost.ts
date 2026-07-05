import { spawnPlayer } from '../game/player'
import { populateWorld } from '../game/populate'
import { setupFloor } from '../game/systems/missions'
import { createWorld, tickWorld, type World } from '../game/world'
import type { Entity } from '../game/entity'
import type { InputCmd } from '../game/types'
import type { InputSource } from '../input/input'
import { SendQueue } from '../net/channel/sendQueue'
import { decodeJson, encodeJson } from '../net/framing/codec'
import { StreamReader } from '../net/framing/chunkedStream'
import {
  encodeSnapshot,
  decodeInput,
  toWireEntity,
  type GameStartMsg,
  type GoMsg,
  type HelloMsg,
  type LobbyPlayer,
  type StateMsg,
  type WireEntity,
} from '../net/protocol/messages'
import { MsgType, PROTOCOL_VERSION, SNAPSHOT_INTERVAL_TICKS, type PeerId, type Transport } from '../net/types'
import type { RenderView, Session } from './session'

const INTEREST_RADIUS = 14 // tiles around each player's avatar
const STATE_INTERVAL_TICKS = 15 // 2Hz

interface PeerState {
  slot: number
  name: string
  classId: string
  queue: SendQueue
  reader: StreamReader
  lastInputSeq: number
  latestCmd: InputCmd
  pendingEdges: number
  entityId?: number
}

/**
 * Authoritative host: runs the sim, accepts joins pre-start,
 * fans out per-peer snapshots, applies remote inputs.
 */
export class NetHostSession implements Session {
  world: World
  self!: Entity
  readonly peersBySlot = new Map<number, PeerState>()
  private peers = new Map<PeerId, PeerState>()
  private inputs = new Map<number, InputCmd>()
  started = false
  onLobbyChange?: (players: LobbyPlayer[]) => void

  constructor(
    readonly seed: number,
    private hostClassId: string,
    private hostName: string,
    private localInput: InputSource,
    private transport: Transport,
  ) {
    this.world = createWorld(seed, 1)
    transport.on((ev) => {
      if (ev.type === 'peerConnected') this.onPeerConnected(ev.peer)
      else if (ev.type === 'peerDisconnected') this.onPeerLost(ev.peer)
      else if (ev.type === 'data') this.onData(ev.peer, ev.bytes)
    })
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  lobbyPlayers(): LobbyPlayer[] {
    const players: LobbyPlayer[] = [{ slot: 0, name: this.hostName, classId: this.hostClassId }]
    for (const p of this.peers.values()) players.push({ slot: p.slot, name: p.name, classId: p.classId })
    players.sort((a, b) => a.slot - b.slot)
    return players
  }

  /** Host presses Start: build the world, spawn everyone, tell clients. */
  beginGame(): void {
    if (this.started) return
    this.started = true
    populateWorld(this.world)
    setupFloor(this.world)
    this.self = spawnPlayer(this.world, 0, this.hostClassId, this.world.level.spawn.x, this.world.level.spawn.y)
    const entityIds: Record<number, number> = { 0: this.self.id }
    for (const p of this.peers.values()) {
      const e = spawnPlayer(this.world, p.slot, p.classId, this.world.level.spawn.x + p.slot * 0.6, this.world.level.spawn.y)
      p.entityId = e.id
      entityIds[p.slot] = e.id
    }
    const start: GameStartMsg = { seed: this.seed, players: this.lobbyPlayers() }
    const go: GoMsg = { startTick: this.world.tick, entityIds }
    this.broadcastJson(MsgType.GameStart, start)
    this.broadcastJson(MsgType.Go, go)
  }

  tick(): void {
    if (!this.started) return
    this.inputs.clear()
    this.inputs.set(0, this.localInput.sample())
    for (const p of this.peers.values()) {
      // Edges accumulated between input packets get OR-ed into this tick's command.
      const cmd = { ...p.latestCmd }
      cmd.attack ||= (p.pendingEdges & 1) !== 0
      cmd.interact ||= (p.pendingEdges & 2) !== 0
      cmd.special ||= (p.pendingEdges & 4) !== 0
      p.pendingEdges = 0
      this.inputs.set(p.slot, cmd)
    }
    tickWorld(this.world, this.inputs)

    if (this.world.events.length > 0) {
      this.broadcastJson(MsgType.Events, { tick: this.world.tick, events: this.world.events })
    }
    if (this.world.tick % SNAPSHOT_INTERVAL_TICKS === 0) this.sendSnapshots()
    if (this.world.tick % STATE_INTERVAL_TICKS === 0) this.sendState()
  }

  private sendSnapshots(): void {
    for (const p of this.peers.values()) {
      if (p.entityId === undefined) continue
      const avatar = this.world.byId.get(p.entityId)
      const entities: WireEntity[] = []
      for (const e of this.world.entities) {
        if (e.dead) continue
        const isPlayer = e.playerCtl !== undefined
        const near =
          avatar !== undefined &&
          Math.abs(e.pos.x - avatar.pos.x) < INTEREST_RADIUS &&
          Math.abs(e.pos.y - avatar.pos.y) < INTEREST_RADIUS
        if (!isPlayer && !near) continue
        entities.push(toWireEntity(e, this.world.tick))
        if (entities.length >= 48) break
      }
      p.queue.queueSnapshot(
        encodeSnapshot({
          tick: this.world.tick,
          floor: this.world.floor,
          alarm: this.world.alarm,
          lastInputSeq: p.lastInputSeq,
          entities,
        }),
      )
    }
  }

  private sendState(): void {
    const huds: StateMsg['huds'] = {}
    for (const e of this.world.entities) {
      if (!e.playerCtl) continue
      huds[e.playerCtl.playerId] = {
        cash: e.playerCtl.cash,
        weapon: e.combat?.weapon ?? 'fists',
        abilityCd: e.playerCtl.abilityCooldown,
        bandages: e.playerCtl.inventory.filter((s) => s.itemId !== 'briefcase').reduce((n, s) => n + s.qty, 0),
        briefcase: e.playerCtl.inventory.some((s) => s.itemId === 'briefcase'),
      }
    }
    const state: StateMsg = {
      floor: this.world.floor,
      missionText: this.world.mission.description,
      missionComplete: this.world.mission.complete,
      gameOver: this.world.gameOver,
      alarm: this.world.alarm,
      huds,
    }
    this.broadcastJson(MsgType.State, state)
  }

  renderView(): RenderView {
    return {
      entities: this.world.entities,
      events: this.world.events,
      tick: this.world.tick,
      level: this.world.level,
      floor: this.world.floor,
      missionText: this.world.mission.description,
      missionComplete: this.world.mission.complete,
      gameOver: this.world.gameOver,
      self: this.self,
    }
  }

  private onPeerConnected(peer: PeerId): void {
    // Slot assigned on HELLO; until then just track the queue/reader.
    const state: PeerState = {
      slot: -1,
      name: '',
      classId: 'soldier',
      queue: new SendQueue(this.transport, peer, () => this.onPeerLost(peer)),
      reader: new StreamReader(),
      lastInputSeq: 0,
      latestCmd: { seq: 0, moveX: 0, moveY: 0, attack: false, interact: false, special: false, aimX: 1, aimY: 0 },
      pendingEdges: 0,
    }
    this.peers.set(peer, state)
  }

  private onPeerLost(peer: PeerId): void {
    const p = this.peers.get(peer)
    if (!p) return
    p.queue.stop()
    this.peers.delete(peer)
    if (p.slot >= 0) this.peersBySlot.delete(p.slot)
    // Their avatar stands stunned; a rejoin flow can reclaim it later.
    if (p.entityId !== undefined) {
      const avatar = this.world.byId.get(p.entityId)
      if (avatar?.status) avatar.status.stun = 90 * 30
    }
    this.onLobbyChange?.(this.lobbyPlayers())
    this.broadcastJson(MsgType.LobbyState, { players: this.lobbyPlayers() })
  }

  private onData(peer: PeerId, bytes: Uint8Array): void {
    const p = this.peers.get(peer)
    if (!p) return
    p.reader.push(bytes, (msg) => this.onMessage(peer, p, msg))
  }

  private onMessage(_peer: PeerId, p: PeerState, msg: Uint8Array): void {
    const type = msg[0]
    if (type === MsgType.Input) {
      const { cmd, edges } = decodeInput(msg)
      if (cmd.seq > p.lastInputSeq || p.lastInputSeq - cmd.seq > 30000) {
        p.lastInputSeq = cmd.seq
        p.latestCmd = cmd
      }
      p.pendingEdges |= edges
      return
    }
    if (type === MsgType.Hello) {
      const hello = decodeJson<HelloMsg>(msg)
      if (hello.v !== PROTOCOL_VERSION) {
        p.queue.queueReliable(encodeJson(MsgType.Reject, { reason: 'version mismatch — update the game' }))
        return
      }
      if (this.started || this.peers.size > 3) {
        p.queue.queueReliable(encodeJson(MsgType.Reject, { reason: this.started ? 'game already running' : 'lobby full' }))
        return
      }
      const used = new Set([0, ...[...this.peers.values()].map((q) => q.slot)])
      let slot = 1
      while (used.has(slot)) slot++
      p.slot = slot
      p.name = hello.name
      p.classId = hello.classId
      this.peersBySlot.set(slot, p)
      p.queue.queueReliable(encodeJson(MsgType.Welcome, { slot }))
      this.onLobbyChange?.(this.lobbyPlayers())
      this.broadcastJson(MsgType.LobbyState, { players: this.lobbyPlayers() })
    }
  }

  private broadcastJson(type: number, payload: unknown): void {
    const bytes = encodeJson(type, payload)
    for (const p of this.peers.values()) {
      if (p.slot >= 0) p.queue.queueReliable(bytes)
    }
  }
}
