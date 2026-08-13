import type { Entity, ItemStack } from '../../game/entity'
import { makeEntity } from '../../game/entity'
import { THROWABLES } from '../../game/data/items'
import { OBJECTS } from '../../game/data/objects'
import { SnapFlags } from '../../game/snapshot'
import { isRolling, ROLL_TICKS } from '../../game/systems/roll'
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
  // Everything below was spawnable but MISSING from this registry, so
  // `archetypeIndex.get(...) ?? 0` encoded it as index 0 and the remote client
  // decoded it back as 'player' — i.e. a spore pod, a lurker or a burning tile
  // rendered on the other phone as a second Ranger. Append only, never reorder.
  'scientist',
  'robot',
  'brute',
  'cinder',
  'sporeling',
  'stalker',
  'lurker',
  'pod',
  'crate',
  'fire',
  // --- Second sweep. The block above fixed ENEMIES only; everything a floor
  // actually contains was still missing, so on the other phone a hundred pieces
  // of furniture, every mod and weapon pickup, every thrown molotov and the
  // objective keycard all rendered as duplicate Rangers. Enumerated from the
  // registries (data/items, data/mods, data/objects, data/npcs) rather than
  // from what one seed happened to spawn — see messages.archetypes.test.ts,
  // which now fails if any registry grows without this list growing with it.
  // Appended alphabetically in one block. APPEND ONLY, NEVER REORDER.
  'atm',
  'banana',
  'barrel',
  'barricade',
  'bench',
  'bunk',
  'cabinet',
  'chloroform',
  'cryoTerminal',
  'desk',
  'freezeGrenade',
  'gasGrenade',
  'generator',
  'locker',
  'mod.bounce',
  'mod.bulk',
  'mod.choke',
  'mod.detonator',
  'mod.explosive',
  'mod.frost',
  'mod.glassCannon',
  'mod.heavy',
  'mod.homing',
  'mod.incendiary',
  'mod.lifesteal',
  'mod.overload',
  'mod.pierce',
  'mod.rapid',
  'mod.shock',
  'mod.splinterShot',
  'mod.split',
  'mod.velocity',
  'molotov',
  'pickup.adrenaline',
  'pickup.banana',
  'pickup.burger',
  'pickup.chloroform',
  'pickup.claws',
  'pickup.fists',
  'pickup.flamethrower',
  'pickup.freezeGrenade',
  'pickup.freezeRay',
  'pickup.gasGrenade',
  'pickup.grenade',
  'pickup.keycard',
  'pickup.machinegun',
  'pickup.molotov',
  'pickup.shotgun',
  'pickup.sledgehammer',
  'pickup.stunGun',
  'pickup.tranquilizer',
  'plant',
  'shelf',
  'spore',
  'sporeNode',
  'table',
  'toilet',
  'tv',
  'vending',
  // PROTOCOL_VERSION 3. APPEND ONLY, at the end — this is a u8 wire index, and
  // inserting or reordering renumbers every entry after it while both builds
  // still claim the same version.
  'chair',
] as const

/** The wing keycard's archetype carries a dynamic `.wing<n>` suffix
 * (systems/missions.ts:253), so the whole family shares one wire index. */
export const KEYCARD_ARCHETYPE = 'pickup.keycard'

/** Collapse dynamic archetype families onto their registered wire archetype.
 * Applied on encode, so `pickup.keycard.wing3` survives as a keycard instead of
 * falling through to index 0 and arriving as a player. */
export const normalizeArchetype = (archetype: string): string =>
  archetype.startsWith(`${KEYCARD_ARCHETYPE}.`) ? KEYCARD_ARCHETYPE : archetype

const archetypeIndex = new Map<string, number>(ARCHETYPES.map((a, i) => [a, i]))

/** Fixed weapon-mod registry order — 5-bit index over the wire. Append only.
 * (Sorted-at-birth is NOT enough: future registry additions must not renumber
 * existing entries, so this list is frozen history, like ARCHETYPES.) */
export const WIRE_MODS = [
  'overload',
  'bulk',
  'rapid',
  'heavy',
  'choke',
  'velocity',
  'glassCannon',
  'frost',
  'incendiary',
  'shock',
  'bounce',
  'pierce',
  'homing',
  'explosive',
  'split',
  'lifesteal',
  'detonator',
  'splinterShot',
] as const

const wireModIndex = new Map<string, number>(WIRE_MODS.map((m, i) => [m, i]))

/** Most mods a single bullet advertises on the wire (bounds the record size). */
const WIRE_MOD_CAP = 12

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
  /** Bullet mod provenance ('projectile' archetype only) — drives the client's
   * procedural bullet look. Absent/empty = vanilla shot. */
  mods?: { id: string; stacks: number }[]
}

export interface WireSnapshot {
  tick: number
  floor: number
  alarm: number
  lastInputSeq: number
  entities: WireEntity[]
}

/** World objects spawn as kind 'interactable' (systems/objects.ts:26) and thrown
 * items fly as kind 'projectile' under their BARE item id (inventory.ts:205).
 * Without these, a registered archetype still arrives with the wrong kind — the
 * two screens would agree a thing is a bench and disagree that it is furniture. */
const OBJECT_ARCHETYPES: ReadonlySet<string> = new Set(Object.keys(OBJECTS))
const THROWN_ARCHETYPES: ReadonlySet<string> = new Set(Object.keys(THROWABLES))

export const kindOf = (archetype: string): Entity['kind'] => {
  if (archetype === 'player') return 'player'
  if (archetype === 'door') return 'door'
  if (archetype === 'projectile' || THROWN_ARCHETYPES.has(archetype)) return 'projectile'
  if (archetype === 'fire' || archetype === 'spore') return 'fire'
  if (archetype.startsWith('pickup.') || archetype.startsWith('mod.')) return 'pickup'
  if (OBJECT_ARCHETYPES.has(archetype)) return 'interactable'
  return 'npc'
}

export const encodeSnapshot = (s: WireSnapshot): Uint8Array => {
  const w = new ByteWriter(16 + s.entities.length * 12)
  w.u8(MsgType.Snapshot).u32(s.tick).u16(s.lastInputSeq).u8(s.floor).u8(s.alarm).u8(s.entities.length)
  for (const e of s.entities) {
    w.u16(e.id)
    w.u8(archetypeIndex.get(normalizeArchetype(e.archetype)) ?? 0)
    w.u8(e.flags)
    w.u16(Math.round(e.x * POS_SCALE))
    w.u16(Math.round(e.y * POS_SCALE))
    w.u8(Math.round(((e.facing % (Math.PI * 2)) + Math.PI * 2) * FACING_SCALE) & 0xff)
    w.u8(Math.round(e.hpPct * 255))
    // Variable tail, 'projectile' records only: u8 mod count, then one byte per
    // mod — 5-bit WIRE_MODS index | 3-bit (stacks-1, capped at 8). A vanilla
    // bullet costs 1 extra byte; other archetypes are unchanged.
    if (e.archetype === 'projectile') {
      const mods = (e.mods ?? []).filter((m) => wireModIndex.has(m.id) && m.stacks > 0).slice(0, WIRE_MOD_CAP)
      w.u8(mods.length)
      for (const m of mods) {
        const stacks = Math.min(8, Math.max(1, Math.floor(m.stacks)))
        w.u8(((wireModIndex.get(m.id)! & 0x1f) << 3) | ((stacks - 1) & 0x07))
      }
    }
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
    const we: WireEntity = {
      id: r.u16(),
      archetype: ARCHETYPES[r.u8()] ?? 'player',
      flags: r.u8(),
      x: r.u16() / POS_SCALE,
      y: r.u16() / POS_SCALE,
      facing: r.u8() / FACING_SCALE,
      hpPct: r.u8() / 255,
    }
    if (we.archetype === 'projectile') {
      const n = r.u8()
      if (n > 0) {
        const mods: { id: string; stacks: number }[] = []
        for (let j = 0; j < n; j++) {
          const packed = r.u8()
          const id = WIRE_MODS[(packed >> 3) & 0x1f]
          if (id) mods.push({ id, stacks: (packed & 0x07) + 1 })
        }
        if (mods.length) we.mods = mods
      }
    }
    entities.push(we)
  }
  return { tick, floor, alarm, lastInputSeq, entities }
}

export const encodeInput = (
  cmd: InputCmd,
  edges: { attack: boolean; interact: boolean; special: boolean; roll?: boolean; throwItem?: boolean },
): Uint8Array => {
  const w = new ByteWriter(10)
  // Bit 8 carries whether aim is active: the angle byte can't encode a centred
  // stick (atan2(0,0)=0 looks like "aim right"), so this bit lets the far side
  // restore a (0,0) aim and hold the last facing instead of snapping.
  const aimActive = Math.hypot(cmd.aimX, cmd.aimY) > 0.01
  const held = (cmd.attack ? 1 : 0) | (cmd.interact ? 2 : 0) | (cmd.special ? 4 : 0) | (aimActive ? 8 : 0)
  // Roll (bit 8) and Use/Throw (bit 16) are pure edges (taps), decoded by the host.
  const edge =
    (edges.attack ? 1 : 0) | (edges.interact ? 2 : 0) | (edges.special ? 4 : 0) | (edges.roll ? 8 : 0) | (edges.throwItem ? 16 : 0)
  w.u8(MsgType.Input)
    .u16(cmd.seq & 0xffff)
    .u8(Math.round((cmd.moveX + 1) * 127))
    .u8(Math.round((cmd.moveY + 1) * 127))
    .u8(held)
    .u8(edge)
    .u8(Math.round(((Math.atan2(cmd.aimY, cmd.aimX) % (Math.PI * 2)) + Math.PI * 2) * FACING_SCALE) & 0xff)
    // Hotbar slot to equip this tick as a +1 biased byte: 0 = none (-1), 1..N = slot 0..N-1.
    .u8((cmd.hotbar >= 0 ? cmd.hotbar + 1 : 0) & 0xff)
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
  const hotbar = r.remaining > 0 ? r.u8() : 0 // back-compat: absent → no equip
  cmd.attack = (held & 1) !== 0
  cmd.interact = (held & 2) !== 0
  cmd.special = (held & 4) !== 0
  cmd.throwItem = (edges & 16) !== 0
  cmd.hotbar = hotbar > 0 ? hotbar - 1 : -1
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
  if (isRolling(e, tick)) flags |= SnapFlags.Rolling
  if (e.door?.open) flags |= SnapFlags.DoorOpen
  if (e.door?.locked) flags |= SnapFlags.DoorLocked
  const we: WireEntity = {
    id: e.id,
    archetype: e.archetype,
    x: e.pos.x,
    y: e.pos.y,
    facing: e.facing,
    // Doors have no health, so their hp byte carries the LOCK LEVEL instead —
    // the client needs it for the inspect card's pick-time row.
    hpPct: e.door ? (e.door.lockLevel & 0xff) / 255 : e.health ? Math.max(0, e.health.hp) / e.health.max : 1,
    flags,
  }
  // Modded bullets carry their build so clients compose the same look.
  if (e.projectile?.mods && e.projectile.mods.length > 0) we.mods = e.projectile.mods.map((m) => ({ ...m }))
  return we
}

/** Materialize/refresh a render-side entity from the wire (client side). */
export const applyWireEntity = (target: Entity | undefined, we: WireEntity, tick: number): Entity => {
  const e = target ?? makeEntity(kindOf(we.archetype), we.archetype, we.x, we.y, we.archetype === 'door' ? 0.5 : 0.35)
  e.id = we.id
  e.facing = we.facing
  if (we.archetype === 'door') {
    e.door = {
      open: (we.flags & SnapFlags.DoorOpen) !== 0,
      locked: (we.flags & SnapFlags.DoorLocked) !== 0,
      lockLevel: Math.round(we.hpPct * 255), // doors ride lockLevel in the hp byte
    }
  }
  if (we.archetype === 'projectile' && we.mods && we.mods.length > 0) {
    // Render-mirror provenance only: the client never sims this projectile, so
    // ownerId/damage/ttl are inert placeholders — `mods` is what the bullet
    // renderer reads to compose the modded look.
    e.projectile ??= { ownerId: 0, damage: 0, ttl: 1 }
    e.projectile.mods = we.mods.map((m) => ({ ...m }))
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
      abilityCooldown: 0,
      cash: 0,
      crimeUntilTick: 0,
    }
    // Loadout is the shared equipment component; the local client fills its real
    // slots from the InventoryMsg, this is just the render-side placeholder.
    e.loadout ??= { inventory: [], activeSlot: -1 }
    e.playerCtl.downed = (we.flags & SnapFlags.Downed) !== 0 ? (e.playerCtl.downed ?? { bleedTicks: 900, reviveProgress: 0 }) : undefined
    // Mirror the host's roll window so the client renders the tumble + agrees on
    // i-frames. A short forward-dated `untilTick` keeps the flag "live" between
    // snapshots; a clear snapshot with the bit off ends it.
    e.playerCtl.roll = (we.flags & SnapFlags.Rolling) !== 0
      ? { untilTick: tick + ROLL_TICKS, cooldownUntilTick: tick + ROLL_TICKS, dirX: Math.cos(e.facing), dirY: Math.sin(e.facing) }
      : undefined
    e.health ??= { hp: 100, max: 100, iframes: 0 }
    e.health.hp = Math.round(we.hpPct * e.health.max)
  }
  return e
}

// --- JSON cold-path payload types ---

export interface HelloMsg {
  v: number
  name: string
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
}
export interface LobbyStateMsg {
  players: LobbyPlayer[]
}
export interface GameStartMsg {
  seed: number
  players: LobbyPlayer[]
  /** Difficulty rules the host is running; clients adopt it so co-op agrees.
   * Optional on the wire for back-compat — absent means the default (`normal`). */
  mode?: 'casual' | 'normal'
  /** The floor the host is on RIGHT NOW. Layout never crosses the wire — the
   * client regenerates it bit-exact from `seed`+`floor` — so this one number is
   * the whole map. A lobby start is always floor 1, but a LATE joiner drops into
   * a run already in progress and must not build floor 1's level for a party
   * standing on floor 3. Optional for back-compat: absent means 1. */
  floor?: number
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
  /** Mission target entity id (steal item / assassinate boss) so client UIs can
   * hyperlink the objective. Optional on the wire for back-compat. */
  missionTargetId?: number
  gameOver: boolean
  alarm: number
  /** STATION ALERT latched on this floor (objective met, escape run on). Optional
   * on the wire for back-compat with an older host. */
  alert?: boolean
  /** Difficulty rules in force (host authoritative). */
  mode?: 'casual' | 'normal'
  /** Party-shared comebacks left this run (HUD; `normal` only). */
  revivesLeft?: number
  /** Per-slot HUD extras for each player's own display. */
  huds: Record<number, { cash: number; weapon: string; abilityCd: number; bandages: number; briefcase: boolean }>
}

/**
 * Host → one client: that client's OWN authoritative inventory. Unlike the
 * per-player HUD summary in `StateMsg.huds` (which stays a lightweight summary
 * for teammates), the local player needs the FULL slot list so weapon switching,
 * item use, mod badges and ammo counts all work as a joiner. Sent on the reliable
 * channel and only when the inventory/activeSlot/weapon actually changes, so it
 * stays BLE-bandwidth-sane rather than riding every snapshot.
 */
export interface InventoryMsg {
  /** The receiving client's own player slot. */
  slot: number
  /** Full slot list — each stack carries its ammo/durability in `qty` and any `mods`. */
  inventory: ItemStack[]
  /** Equipped/hotbar slot index into `inventory`; -1 = bare fists. */
  activeSlot: number
  /** The currently-swung weapon id (may differ from activeSlot when a throwable/consumable is held). */
  weapon: string
}
