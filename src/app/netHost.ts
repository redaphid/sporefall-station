import { spawnPlayer } from '../game/player'
import { playerSpawnPoint } from '../game/spawnPlacement'
import { populateWorld } from '../game/populate'
import { setupFloor } from '../game/systems/missions'
import { createWorld, stationAlerted, tickWorld, type RunMode, type World } from '../game/world'
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
  type InventoryMsg,
  type LobbyPlayer,
  type StateMsg,
  type WireEntity,
} from '../net/protocol/messages'
import { isKnownMsgType, MsgType, PROTOCOL_VERSION, SNAPSHOT_INTERVAL_TICKS, type PeerId, type Transport } from '../net/types'
import type { RenderView, Session } from './session'

const INTEREST_RADIUS = 14 // tiles around each player's avatar
const STATE_INTERVAL_TICKS = 15 // 2Hz

/**
 * Hard ceiling on entities in ONE snapshot. Bounds the packet: 10B header +
 * 10B/entity = 490B, which is 25 packets at the 20-byte BLE MTU floor and 3 at
 * 244B. The wire count is a u8, so this can never exceed 255.
 */
export const SNAPSHOT_ENTITY_CAP = 48

/**
 * Max simultaneous players in one run (host + clients). Slots run 0..MAX_PLAYERS-1;
 * the host always owns slot 0, so up to MAX_PLAYERS-1 remote clients may join.
 * Raised from 4→8 for large local groups (stress/8-players). NOTE: over BLE the
 * host peripheral's radio caps concurrent centrals well below this (commonly ~7,
 * device-specific) — this constant is the protocol/sim ceiling, not a promise the
 * transport can carry it. The BroadcastChannel/web path has no such radio limit.
 */
export const MAX_PLAYERS = 8
const MAX_SLOT = MAX_PLAYERS - 1

interface PeerState {
  slot: number
  name: string
  token: string
  queue: SendQueue
  reader: StreamReader
  lastInputSeq: number
  latestCmd: InputCmd
  pendingEdges: number
  /** Hotbar slot the client tapped since the last tick consumed one (-1 = none).
   * Edge-triggered like the button edges: applied once, then reset, so a single
   * tap equips exactly once instead of re-equipping every tick. */
  pendingHotbar: number
  /** Signature of the last inventory we shipped this peer — send only on change. */
  lastInvSig: string
  entityId?: number
}

/** A dropped mid-game player who may still rejoin. */
interface Ghost {
  slot: number
  name: string
  token: string
  entityId: number
  expiresAtTick: number
}

const REJOIN_GRACE_TICKS = 90 * 30

/**
 * Authoritative host: runs the sim, accepts joins pre-start,
 * fans out per-peer snapshots, applies remote inputs.
 */
export class NetHostSession implements Session {
  world: World
  /** Client->host framing desyncs recovered in-band (see chunkedStream.ts). */
  streamDesyncs = 0
  self!: Entity
  readonly peersBySlot = new Map<number, PeerState>()
  private peers = new Map<PeerId, PeerState>()
  private ghosts = new Map<number, Ghost>()
  private inputs = new Map<number, InputCmd>()
  started = false
  onLobbyChange?: (players: LobbyPlayer[]) => void
  /** Test/telemetry counter: how many per-client Inventory messages we've sent. */
  debugInventorySends = 0

  constructor(
    /** Mutable so "New Seed" (restart(seed)) can re-seed the run in place; the
     * next GameStart broadcasts the new seed to every still-connected peer. */
    public seed: number,
    private hostName: string,
    private localInput: InputSource,
    private transport: Transport,
    /** Difficulty rules for the run — `casual` keeps death forgiving (kid mode). */
    private mode: RunMode = 'normal',
  ) {
    this.world = createWorld(seed, 1, mode)
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
    const players: LobbyPlayer[] = [{ slot: 0, name: this.hostName }]
    // Only admitted peers belong in the lobby; a peer that has connected but not
    // yet completed a valid Hello still carries slot -1 and must not be listed
    // (nor shipped in GameStart's player list).
    for (const p of this.peers.values()) {
      if (p.slot >= 0) players.push({ slot: p.slot, name: p.name })
    }
    players.sort((a, b) => a.slot - b.slot)
    return players
  }

  /**
   * The one place `GameStart` is built. Three sites send it — the lobby Start,
   * a ghost rejoin and a fresh late join — and they must agree, because `floor`
   * is read at SEND time. A late joiner's client builds its level from
   * `seed`+`floor` alone, so a stale or missing floor here is the joiner staring
   * at the wrong map.
   */
  private gameStartMsg(): GameStartMsg {
    return { seed: this.seed, players: this.lobbyPlayers(), mode: this.world.mode, floor: this.world.floor }
  }

  /** Host presses Start: build the world, spawn everyone, tell clients. */
  beginGame(): void {
    if (this.started) return
    this.started = true
    populateWorld(this.world)
    setupFloor(this.world)
    const hostAt = playerSpawnPoint(this.world.level, 0)
    this.self = spawnPlayer(this.world, 0, hostAt.x, hostAt.y)
    const entityIds: Record<number, number> = { 0: this.self.id }
    for (const p of this.peers.values()) {
      // A peer whose link is up but whose Hello has not landed yet still carries
      // slot -1. Spawning it would put a PHANTOM avatar (playerId -1) in the
      // world: absent from the lobby, driven by nobody, shipped in every
      // snapshot — and, because nothing can ever down it, it permanently blocks
      // missionSystem's run-over check, so a co-op wipe never ends the run. It
      // also strands a zombie body once the real Hello finally arrives and takes
      // a proper slot. Admitted peers only; the late-join path spawns the rest.
      if (p.slot < 0) continue
      // A COLLISION-CHECKED spot, not a blind offset: the old `spawn.x + slot * 0.6`
      // put 18.6% of slots inside a solid tile, and a body that starts in a wall can
      // never step out of it (see game/spawnPlacement.ts). `playerSpawnPoint` is a
      // pure function of (level, slot), so the late-join branch below re-derives the
      // SAME point for the same slot and no client can disagree about it.
      const at = playerSpawnPoint(this.world.level, p.slot)
      const e = spawnPlayer(this.world, p.slot, at.x, at.y)
      p.entityId = e.id
      entityIds[p.slot] = e.id
    }
    const start: GameStartMsg = this.gameStartMsg()
    const go: GoMsg = { startTick: this.world.tick, entityIds }
    this.broadcastJson(MsgType.GameStart, start)
    this.broadcastJson(MsgType.Go, go)
  }

  /**
   * Play again after a game-over WITHOUT dropping the transport. Rebuild the
   * world from the seed and re-run beginGame, so every still-connected peer just
   * receives a fresh GameStart/Go over the existing BLE link and resumes — no
   * reconnect, no re-pairing, no app restart. Game state and connection state are
   * kept separate: this resets the former and leaves the latter untouched.
   */
  restart(seed?: number): void {
    if (seed !== undefined) this.seed = seed >>> 0
    this.world = createWorld(this.seed, 1, this.mode)
    this.ghosts.clear()
    // Force a fresh inventory push after respawn: the new loadout must reach every
    // client even if it happens to hash-match the pre-restart one.
    for (const p of this.peers.values()) p.lastInvSig = ''
    this.started = false
    this.beginGame()
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
      cmd.roll = (p.pendingEdges & 8) !== 0 // edge only — never a sticky held bit
      cmd.throwItem = (p.pendingEdges & 16) !== 0 // Use/Throw is a tap, not a sticky held bit
      // Hotbar equip is edge-triggered too: apply the tapped slot once, then clear
      // it, so a single tap doesn't re-equip every tick until the next packet.
      cmd.hotbar = p.pendingHotbar
      p.pendingHotbar = -1
      p.pendingEdges = 0
      this.inputs.set(p.slot, cmd)
    }
    tickWorld(this.world, this.inputs)
    this.expireGhosts()

    if (this.world.events.length > 0) {
      this.broadcastJson(MsgType.Events, { tick: this.world.tick, events: this.world.events })
    }
    if (this.world.tick % SNAPSHOT_INTERVAL_TICKS === 0) this.sendSnapshots()
    if (this.world.tick % STATE_INTERVAL_TICKS === 0) this.sendState()
    this.sendInventories()
  }

  /**
   * Ship each client its OWN player's full inventory over the RELIABLE channel,
   * but ONLY when it changed since we last sent it. Teammates stay summarized in
   * `StateMsg.huds`; this is exclusively the local player's authoritative slots,
   * so a joiner can switch weapons, use items, see mods and read ammo counts.
   * Change-gating (a cheap signature compare) keeps this off the every-tick path
   * and off the snapshot path — a firefight sends one small reliable packet per
   * ammo/slot/mod change, not one per tick.
   */
  private sendInventories(): void {
    for (const p of this.peers.values()) {
      if (p.slot < 0 || p.entityId === undefined) continue
      const avatar = this.world.byId.get(p.entityId)
      const ld = avatar?.loadout
      if (!avatar?.playerCtl || !ld) continue
      const msg: InventoryMsg = {
        slot: p.slot,
        inventory: ld.inventory,
        activeSlot: ld.activeSlot,
        weapon: avatar.combat?.weapon ?? 'fists',
      }
      const sig = JSON.stringify([msg.inventory, msg.activeSlot, msg.weapon])
      if (sig === p.lastInvSig) continue
      p.lastInvSig = sig
      p.queue.queueReliable(encodeJson(MsgType.Inventory, msg))
      this.debugInventorySends++
    }
  }

  /**
   * Per-peer interest set, in two passes.
   *
   * PASS 1 — every live player, unconditionally. The cap is a BANDWIDTH guard,
   * never a visibility rule. `netClient.applySnapshot` prunes any entity a
   * snapshot omits, so an avatar squeezed out by the cap is *deleted* on that
   * client: the player's own sprite and their whole team blink out, prediction
   * stops being reconciled, and they rubber-band when it returns. The old
   * single-pass loop capped in `world.entities` order, and `beginGame` runs
   * `populateWorld` BEFORE `spawnPlayer`, so avatars live at the very END of
   * that array — on a real floor (50–94 props inside one 14-tile window on
   * every seed sampled) the cap was reached before the loop ever saw a player,
   * and snapshots carried ZERO of the 8.
   *
   * PASS 2 — spend what is left of the budget on the CLOSEST in-radius entities.
   * Array order is spawn order, so it favoured whatever the level generator made
   * first: a thug standing on your toes could be dropped in favour of a table
   * thirteen tiles away. Nearest-first with an id tiebreak is deterministic and
   * stable tick to tick, which also stops the selection churning (sprites
   * popping in and out) while the party stands still.
   */
  private sendSnapshots(): void {
    for (const p of this.peers.values()) {
      if (p.entityId === undefined) continue
      const avatar = this.world.byId.get(p.entityId)
      const entities: WireEntity[] = []
      const nearby: { e: Entity; d: number }[] = []
      for (const e of this.world.entities) {
        if (e.dead) continue
        if (e.playerCtl !== undefined) {
          if (entities.length < SNAPSHOT_ENTITY_CAP) entities.push(toWireEntity(e, this.world.tick))
          continue
        }
        if (avatar === undefined) continue
        const dx = Math.abs(e.pos.x - avatar.pos.x)
        const dy = Math.abs(e.pos.y - avatar.pos.y)
        if (dx >= INTEREST_RADIUS || dy >= INTEREST_RADIUS) continue
        nearby.push({ e, d: Math.max(dx, dy) })
      }
      // Only pay for the ordering when the budget is actually oversubscribed.
      if (entities.length + nearby.length > SNAPSHOT_ENTITY_CAP) {
        nearby.sort((a, b) => (a.d === b.d ? a.e.id - b.e.id : a.d - b.d))
      }
      for (const n of nearby) {
        if (entities.length >= SNAPSHOT_ENTITY_CAP) break
        entities.push(toWireEntity(n.e, this.world.tick))
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
        bandages: (e.loadout?.inventory ?? []).filter((s) => s.itemId !== 'briefcase').reduce((n, s) => n + s.qty, 0),
        briefcase: (e.loadout?.inventory ?? []).some((s) => s.itemId === 'briefcase'),
      }
    }
    const state: StateMsg = {
      floor: this.world.floor,
      missionText: this.world.mission.description,
      missionComplete: this.world.mission.complete,
      missionTargetId: this.world.mission.targetEntityId,
      gameOver: this.world.gameOver,
      alarm: this.world.alarm,
      alert: stationAlerted(this.world),
      mode: this.world.mode,
      revivesLeft: this.world.revivesLeft,
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
      missionTargetId: this.world.mission.targetEntityId,
      gameOver: this.world.gameOver,
      alert: stationAlerted(this.world),
      mode: this.world.mode,
      revivesLeft: this.world.revivesLeft,
      self: this.self,
    }
  }

  private onPeerConnected(peer: PeerId): void {
    // Slot assigned on HELLO; until then just track the queue/reader.
    const state: PeerState = {
      slot: -1,
      name: '',
      token: '',
      queue: new SendQueue(this.transport, peer, () => this.onPeerLost(peer)),
      reader: new StreamReader({
        isValidStart: isKnownMsgType,
        onDesync: () => this.streamDesyncs++,
      }),
      lastInputSeq: 0,
      latestCmd: { seq: 0, moveX: 0, moveY: 0, attack: false, interact: false, special: false, aimX: 1, aimY: 0, hotbar: -1, throwItem: false, roll: false },
      pendingEdges: 0,
      pendingHotbar: -1,
      lastInvSig: '',
    }
    this.peers.set(peer, state)
  }

  private onPeerLost(peer: PeerId): void {
    const p = this.peers.get(peer)
    if (!p) return
    p.queue.stop()
    this.peers.delete(peer)
    if (p.slot >= 0) this.peersBySlot.delete(p.slot)
    // Mid-game drop: park the avatar (stunned, invulnerable-ish via stun) and
    // remember the slot so the same player can rejoin within the grace window.
    if (this.started && p.slot >= 0 && p.entityId !== undefined) {
      this.ghosts.set(p.slot, {
        slot: p.slot,
        name: p.name,
        token: p.token,
        entityId: p.entityId,
        expiresAtTick: this.world.tick + REJOIN_GRACE_TICKS,
      })
      const avatar = this.world.byId.get(p.entityId)
      if (avatar?.status) avatar.status.stun = REJOIN_GRACE_TICKS
    }
    this.onLobbyChange?.(this.lobbyPlayers())
    this.broadcastJson(MsgType.LobbyState, { players: this.lobbyPlayers() })
  }

  /** Bleed out ghosts whose grace window expired. */
  private expireGhosts(): void {
    for (const [slot, ghost] of this.ghosts) {
      if (this.world.tick < ghost.expiresAtTick) continue
      this.ghosts.delete(slot)
      const avatar = this.world.byId.get(ghost.entityId)
      if (avatar) avatar.dead = true
    }
  }

  private onData(peer: PeerId, bytes: Uint8Array): void {
    const p = this.peers.get(peer)
    if (!p) return
    p.reader.push(bytes, (msg) => this.onMessage(peer, p, msg))
  }

  private onMessage(_peer: PeerId, p: PeerState, msg: Uint8Array): void {
    try {
      this.handleMessage(p, msg)
    } catch {
      // A malformed or hostile packet (bad JSON, truncated binary, garbage type)
      // must never take the host down: drop it and keep serving other peers.
    }
  }

  private handleMessage(p: PeerState, msg: Uint8Array): void {
    const type = msg[0]
    if (type === MsgType.Input) {
      const { cmd, edges } = decodeInput(msg)
      // Only fold in a packet that actually advances the input sequence (u16 wrap
      // allowed). A stale/reordered/duplicated packet must NOT re-arm its edges —
      // OR-ing them in again would dodge-roll / throw / equip a SECOND time the
      // player never asked for (edges must fire once, not re-fire on a re-delivery).
      if (cmd.seq > p.lastInputSeq || p.lastInputSeq - cmd.seq > 30000) {
        p.lastInputSeq = cmd.seq
        p.latestCmd = cmd
        p.pendingEdges |= edges
        // A hotbar tap is an edge: latch the requested slot so the next tick equips
        // it once even if the packet arrived between ticks (OR-ed like the edges).
        if (cmd.hotbar >= 0) p.pendingHotbar = cmd.hotbar
      }
      return
    }
    if (type === MsgType.Hello) {
      const hello = decodeJson<HelloMsg>(msg)
      if (hello.v !== PROTOCOL_VERSION) {
        p.queue.queueReliable(encodeJson(MsgType.Reject, { reason: 'version mismatch — update the game' }))
        return
      }

      // Duplicate Hello from a peer we've already admitted: ignore it.
      // Reprocessing would reassign the slot, leak a stale peersBySlot entry, and
      // — mid-game — spawn a second avatar for the same connection.
      //
      // This deliberately covers a Hello that carries a `rejoin` block too. A
      // GENUINE rejoin always arrives on a NEW link, and a new link means a new
      // PeerState at slot -1 (onPeerLost deletes the old one), so an admitted
      // peer asking to rejoin is never the legitimate case. Letting it through —
      // as `!hello.rejoin` used to — meant any rejoin field walked past this
      // guard: pre-start it re-slotted a peer and orphaned its old peersBySlot
      // entry (a seat that can never be issued again), and mid-game a live
      // player holding a leaked token could seize someone else's ghost, ending
      // up in two slots at once with its own avatar abandoned in the world.
      if (p.slot >= 0) return

      // Mid-game rejoin: reclaim the ghost slot if the token matches.
      if (this.started && hello.rejoin) {
        const ghost = this.ghosts.get(hello.rejoin.slot)
        if (!ghost || ghost.token !== hello.rejoin.token) {
          p.queue.queueReliable(encodeJson(MsgType.Reject, { reason: 'rejoin window expired' }))
          return
        }
        // The parked avatar is STUNNED, not invulnerable, so a patrol can finish
        // it off while its owner is off the air. Handing the seat back anyway
        // would reply Go with an entityId that no longer exists: the client
        // enters `playing`, never sees itself in a snapshot, and sits there
        // forever with no avatar, no movement and nothing on screen to explain
        // it. Retire the dead ghost and say so — a plain Hello then late-joins
        // with a working body, the same deal any other newcomer gets.
        const parked = this.world.byId.get(ghost.entityId)
        if (!parked || parked.dead) {
          this.ghosts.delete(ghost.slot)
          p.queue.queueReliable(
            encodeJson(MsgType.Reject, { reason: 'your character did not survive — rejoin for a fresh one' }),
          )
          return
        }
        this.ghosts.delete(ghost.slot)
        p.slot = ghost.slot
        p.name = ghost.name
        p.token = ghost.token
        p.entityId = ghost.entityId
        this.peersBySlot.set(p.slot, p)
        if (parked.status) parked.status.stun = 0
        p.queue.queueReliable(encodeJson(MsgType.Welcome, { slot: p.slot, token: p.token }))
        p.queue.queueReliable(encodeJson(MsgType.GameStart, this.gameStartMsg()))
        p.queue.queueReliable(
          encodeJson(MsgType.Go, { startTick: this.world.tick, entityIds: { [p.slot]: ghost.entityId } }),
        )
        this.onLobbyChange?.(this.lobbyPlayers())
        this.broadcastJson(MsgType.LobbyState, { players: this.lobbyPlayers() })
        return
      }

      // Fresh late-join: the run is already going but a slot is open. Spawn a
      // brand-new avatar into the live world (not a ghost reclaim) and hand the
      // client Welcome+GameStart+Go so it drops straight into the running floor.
      //
      // `started` alone is the wrong gate: it stays true after the party wipes
      // (only restart() clears it), so a friend who walks up after a game-over
      // used to be spawned into a dead world and handed a corpse to pilot. Gate
      // on the run being LIVE. When it isn't, fall through to the lobby path
      // below — they get a slot and a Welcome and simply wait, and the host's
      // "play again" (restart → beginGame) spawns them with everyone else.
      // A ghost REJOIN is deliberately left alone above: that player's avatar is
      // already in the finished world and they should see the same ending.
      if (this.started && !this.world.gameOver) {
        const used = new Set([0, ...[...this.peers.values()].map((q) => q.slot), ...this.ghosts.keys()])
        let slot = 1
        while (used.has(slot)) slot++
        if (slot > MAX_SLOT) {
          p.queue.queueReliable(encodeJson(MsgType.Reject, { reason: 'lobby full' }))
          return
        }
        p.slot = slot
        p.name = hello.name
        p.token = Math.random().toString(36).slice(2, 12)
        // Same collision-checked placement as the lobby start (beginGame), and the
        // same function of (level, slot) — a friend who joins mid-run lands where
        // that slot would have landed had they been there from the beginning.
        const at = playerSpawnPoint(this.world.level, slot)
        const avatar = spawnPlayer(this.world, slot, at.x, at.y)
        p.entityId = avatar.id
        this.peersBySlot.set(slot, p)
        p.queue.queueReliable(encodeJson(MsgType.Welcome, { slot, token: p.token }))
        p.queue.queueReliable(encodeJson(MsgType.GameStart, this.gameStartMsg()))
        p.queue.queueReliable(encodeJson(MsgType.Go, { startTick: this.world.tick, entityIds: { [slot]: avatar.id } }))
        this.onLobbyChange?.(this.lobbyPlayers())
        this.broadcastJson(MsgType.LobbyState, { players: this.lobbyPlayers() })
        return
      }

      // Lobby admission — pre-start, and also where a post-game-over joiner waits
      // for "play again". Ghosts count as taken: after a wipe the world can still
      // hold dropped players' reserved slots, and handing one out twice would put
      // two peers on one avatar.
      const used = new Set([0, ...[...this.peers.values()].map((q) => q.slot), ...this.ghosts.keys()])
      let slot = 1
      while (used.has(slot)) slot++
      if (slot > MAX_SLOT) {
        p.queue.queueReliable(encodeJson(MsgType.Reject, { reason: 'lobby full' }))
        return
      }
      p.slot = slot
      p.name = hello.name
      p.token = Math.random().toString(36).slice(2, 12)
      this.peersBySlot.set(slot, p)
      p.queue.queueReliable(encodeJson(MsgType.Welcome, { slot, token: p.token }))
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
