import type { Entity } from '../../game/entity'
import { makeEntity } from '../../game/entity'
import { SnapFlags } from '../../game/snapshot'
import type { InputCmd } from '../../game/types'
import { emptyInput } from '../../game/types'
import { ByteReader, ByteWriter } from '../framing/codec'
import { MsgType } from '../types'

/** Fixed archetype registry — u8 index over the wire. Append only. */
export const ARCHETYPES = [
  'player',
  'thug',
  'cop',
  'civilian',
  'shopkeeper',
  'boss',
  'projectile',
  'grenade',
  'door',
  'pickup.bat',
  'pickup.knife',
  'pickup.pistol',
  'pickup.bandage',
  'pickup.medkit',
  'pickup.cash',
  'pickup.briefcase',
  'gangster',
  'bouncer',
] as const

const archetypeIndex = new Map<string, number>(ARCHETYPES.map((a, i) => [a, i]))

const POS_SCALE = 32 // 1/32-tile precision in u16
const FACING_SCALE = 256 / (Math.PI * 2)

export interface WireEntity {
  id: number
  archetype: string
  x: number
  y: number
  facing: number
  hpPct: number
  flags: number
}

export interface WireSnapshot {
  tick: number
  floor: number
  alarm: number
  lastInputSeq: number
  entities: WireEntity[]
}

export const kindOf = (archetype: string): Entity['kind'] => {
  if (archetype === 'player') return 'player'
  if (archetype === 'door') return 'door'
  if (archetype === 'projectile' || archetype === 'grenade') return 'projectile'
  if (archetype.startsWith('pickup.')) return 'pickup'
  return 'npc'
}

export const encodeSnapshot = (s: WireSnapshot): Uint8Array => {
  const w = new ByteWriter(16 + s.entities.length * 10)
  w.u8(MsgType.Snapshot).u32(s.tick).u16(s.lastInputSeq).u8(s.floor).u8(s.alarm).u8(s.entities.length)
  for (const e of s.entities) {
    w.u16(e.id)
    w.u8(archetypeIndex.get(e.archetype) ?? 0)
    w.u8(e.flags)
    w.u16(Math.round(e.x * POS_SCALE))
    w.u16(Math.round(e.y * POS_SCALE))
    w.u8(Math.round(((e.facing % (Math.PI * 2)) + Math.PI * 2) * FACING_SCALE) & 0xff)
    w.u8(Math.round(e.hpPct * 255))
  }
  return w.finish()
}

export const decodeSnapshot = (bytes: Uint8Array): WireSnapshot => {
  const r = new ByteReader(bytes)
  r.u8() // msgType
  const tick = r.u32()
  const lastInputSeq = r.u16()
  const floor = r.u8()
  const alarm = r.u8()
  const count = r.u8()
  const entities: WireEntity[] = []
  for (let i = 0; i < count; i++) {
    entities.push({
      id: r.u16(),
      archetype: ARCHETYPES[r.u8()] ?? 'player',
      flags: r.u8(),
      x: r.u16() / POS_SCALE,
      y: r.u16() / POS_SCALE,
      facing: r.u8() / FACING_SCALE,
      hpPct: r.u8() / 255,
    })
  }
  return { tick, floor, alarm, lastInputSeq, entities }
}

export const encodeInput = (cmd: InputCmd, edges: { attack: boolean; interact: boolean; special: boolean }): Uint8Array => {
  const w = new ByteWriter(9)
  // Bit 8 carries whether aim is active: the angle byte can't encode a centred
  // stick (atan2(0,0)=0 looks like "aim right"), so this bit lets the far side
  // restore a (0,0) aim and hold the last facing instead of snapping.
  const aimActive = Math.hypot(cmd.aimX, cmd.aimY) > 0.01
  const held = (cmd.attack ? 1 : 0) | (cmd.interact ? 2 : 0) | (cmd.special ? 4 : 0) | (aimActive ? 8 : 0)
  const edge = (edges.attack ? 1 : 0) | (edges.interact ? 2 : 0) | (edges.special ? 4 : 0)
  w.u8(MsgType.Input)
    .u16(cmd.seq & 0xffff)
    .u8(Math.round((cmd.moveX + 1) * 127))
    .u8(Math.round((cmd.moveY + 1) * 127))
    .u8(held)
    .u8(edge)
    .u8(Math.round(((Math.atan2(cmd.aimY, cmd.aimX) % (Math.PI * 2)) + Math.PI * 2) * FACING_SCALE) & 0xff)
  return w.finish()
}

export const decodeInput = (bytes: Uint8Array): { cmd: InputCmd; edges: number } => {
  const r = new ByteReader(bytes)
  r.u8()
  const cmd = emptyInput()
  cmd.seq = r.u16()
  cmd.moveX = r.u8() / 127 - 1
  cmd.moveY = r.u8() / 127 - 1
  const held = r.u8()
  const edges = r.u8()
  const aim = r.u8() / FACING_SCALE
  cmd.attack = (held & 1) !== 0
  cmd.interact = (held & 2) !== 0
  cmd.special = (held & 4) !== 0
  const aimActive = (held & 8) !== 0
  cmd.aimX = aimActive ? Math.cos(aim) : 0
  cmd.aimY = aimActive ? Math.sin(aim) : 0
  return { cmd, edges }
}

/** Build the wire entity for one sim entity (host side). */
export const toWireEntity = (e: Entity, tick: number): WireEntity => {
  let flags = 0
  if (e.playerCtl?.downed) flags |= SnapFlags.Downed
  if (e.status) {
    if (e.status.sleep > 0) flags |= SnapFlags.Sleeping
    if (e.status.stun > 0) flags |= SnapFlags.Stunned
    if (e.status.hitFlashUntil > tick) flags |= SnapFlags.HitFlash
    if (e.status.cloakUntil > tick) flags |= SnapFlags.Cloaked
  }
  if (e.door?.open) flags |= SnapFlags.DoorOpen
  return {
    id: e.id,
    archetype: e.archetype,
    x: e.pos.x,
    y: e.pos.y,
    facing: e.facing,
    hpPct: e.health ? Math.max(0, e.health.hp) / e.health.max : 1,
    flags,
  }
}

/** Materialize/refresh a render-side entity from the wire (client side). */
export const applyWireEntity = (target: Entity | undefined, we: WireEntity, tick: number): Entity => {
  const e = target ?? makeEntity(kindOf(we.archetype), we.archetype, we.x, we.y, we.archetype === 'door' ? 0.5 : 0.35)
  e.id = we.id
  e.facing = we.facing
  if (we.archetype === 'door') {
    e.door = { open: (we.flags & SnapFlags.DoorOpen) !== 0, locked: false, lockLevel: 0 }
  }
  if ((we.flags & SnapFlags.HitFlash) !== 0) {
    e.status ??= { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    e.status.hitFlashUntil = tick + 2
  }
  if ((we.flags & SnapFlags.Cloaked) !== 0) {
    e.status ??= { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    e.status.cloakUntil = tick + 2
  }
  if (we.archetype === 'player') {
    e.playerCtl ??= {
      playerId: -1,
      classId: 'soldier',
      abilityCooldown: 0,
      inventory: [],
      activeSlot: -1,
      cash: 0,
      crimeUntilTick: 0,
    }
    e.playerCtl.downed = (we.flags & SnapFlags.Downed) !== 0 ? (e.playerCtl.downed ?? { bleedTicks: 900, reviveProgress: 0 }) : undefined
    e.health ??= { hp: 100, max: 100, iframes: 0 }
    e.health.hp = Math.round(we.hpPct * e.health.max)
  }
  return e
}

// --- JSON cold-path payload types ---

export interface HelloMsg {
  v: number
  name: string
  classId: string
  /** Present when rejoining after a mid-game drop. */
  rejoin?: { slot: number; token: string }
}
export interface WelcomeMsg {
  slot: number
  /** Keep this to rejoin the same avatar if the link drops. */
  token: string
}
export interface LobbyPlayer {
  slot: number
  name: string
  classId: string
}
export interface LobbyStateMsg {
  players: LobbyPlayer[]
}
export interface GameStartMsg {
  seed: number
  players: LobbyPlayer[]
}
export interface GoMsg {
  startTick: number
  /** slot → entity id of that player's avatar */
  entityIds: Record<number, number>
}
export interface EventsMsg {
  tick: number
  events: unknown[]
}
export interface StateMsg {
  floor: number
  missionText: string
  missionComplete: boolean
  gameOver: boolean
  alarm: number
  /** Per-slot HUD extras for each player's own display. */
  huds: Record<number, { cash: number; weapon: string; abilityCd: number; bandages: number; briefcase: boolean }>
}
