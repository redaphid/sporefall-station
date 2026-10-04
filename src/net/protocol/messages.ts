import type { ActivityKind, DraftHand, Entity, ItemStack } from '../../game/entity'
import { makeEntity } from '../../game/entity'
import { THROWABLES } from '../../game/data/items'
import { OBJECTS } from '../../game/data/objects'
import { SnapFlags } from '../../game/snapshot'
import { isRolling, ROLL_TICKS } from '../../game/systems/roll'
import { shownActivity } from '../../game/systems/activities'
import type { FloorModifier } from '../../game/floorModifiers'
import type { InputCmd } from '../../game/types'
import { emptyInput } from '../../game/types'
import { ByteReader, ByteWriter } from '../framing/codec'
import { MsgType } from '../types'

/**
 * Fixed archetype registry — u8 index over the wire. Append only.
 *
 * ## `// RETIRED` entries are TOMBSTONES. Do not compact this list.
 *
 * Fourteen entries are marked `// RETIRED`: the nine culled items in every form
 * they take on the wire (`banana`/`molotov`/… in flight, `pickup.banana`/… on
 * the floor). They name content that no longer exists, and a dead-code tool
 * will call them unused. They are CLAIMED, not unused — the same argument as
 * the protocol-reservation note on `BLE_LOBBY_INFO_UUID` in net/types.ts.
 * (Spelling that tag out in prose here made Knip read it as a real JSDoc tag
 * on ARCHETYPES, which then reported the tag itself as unused.)
 *
 * The index IS the wire format. `encodeSnapshot` writes the position
 * (`archetypeIndex.get(a) ?? 0`) and `decodeSnapshot` reads it back positionally
 * (`ARCHETYPES[r.u8()] ?? 'player'`). Deleting `'banana'` at index 55 does not
 * remove a meaning, it SHIFTS every meaning after it down by one — so a phone on
 * the old bundle and a phone on the new one would agree they are both
 * PROTOCOL_VERSION 3, sail through the handshake gate, and then silently
 * disagree about what all 32 following entries mean. Furniture would arrive as
 * mods, pickups as furniture, and the tail of the list would decode past the end
 * as `'player'` — a screen full of phantom Rangers, the exact bug the second
 * sweep below was written to fix.
 *
 * A HOLE IS THE CORRECT OUTCOME. Leaving the strings in place keeps all 88
 * indices meaning exactly what they meant before the cull, which is what lets
 * PROTOCOL_VERSION stay at 3 honestly: the two builds really are compatible.
 * A pre-cull peer can still send `pickup.medkit`; a post-cull peer decodes the
 * name correctly, draws it (the art keys are untouched), and treats the item as
 * inert because `itemClass` returns 'unknown' — degraded, never desynced.
 *
 * Retiring costs one byte of nothing. Compacting costs a silent desync. Only
 * ever append.
 */
export const ARCHETYPES = [
  'player',
  'mutant',
  'warden',
  'civilian',
  'shopkeeper',
  'boss',
  'projectile',
  'grenade',
  'door',
  'pickup.wrench',
  'pickup.knife',
  'pickup.pistol',
  'pickup.bandage', // RETIRED
  'pickup.medkit', // RETIRED
  'pickup.cash',
  'pickup.canister',
  'acolyte',
  'lockkeeper',
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
  'banana', // RETIRED
  'barrel',
  'barricade',
  'bench',
  'bunk',
  'cabinet',
  'chloroform', // RETIRED
  'cryoTerminal',
  'desk',
  'freezeGrenade', // RETIRED
  'gasGrenade', // RETIRED
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
  'molotov', // RETIRED
  'pickup.adrenaline', // RETIRED
  'pickup.banana', // RETIRED
  'pickup.burger', // RETIRED
  'pickup.chloroform', // RETIRED
  'pickup.claws',
  'pickup.fists',
  'pickup.flamethrower',
  'pickup.freezeGrenade', // RETIRED
  'pickup.freezeRay',
  'pickup.gasGrenade', // RETIRED
  'pickup.grenade',
  'pickup.keycard',
  'pickup.machinegun',
  'pickup.molotov', // RETIRED
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
  // PROTOCOL_VERSION 4 — the group roster (systems/groups.ts): raid members,
  // pack fauna and the hive spire. APPEND ONLY, at the end.
  'drowner',
  'bellwether',
  'mender',
  'breacher',
  'lobber',
  'gloamhound',
  'hivespire',
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

/** Element statuses (`Entity.fx` keys) as a bit index in the snapshot's status
 * trailer. Frozen history like WIRE_MODS: append only, at most 8. */
export const WIRE_STATUSES = ['burning', 'frozen', 'wet', 'electrified', 'poisoned', 'spore'] as const

const wireStatusBit = new Map<string, number>(WIRE_STATUSES.map((k, i) => [k, 1 << i]))

/** Activities a seated NPC shows, by wire code (index + 1) in the snapshot's
 * activity trailer. Frozen history: append only, at most 127. */
export const WIRE_ACTIVITIES: readonly ActivityKind[] = ['cards', 'tinker', 'rest']
/** Set on an activity code when the session is under way (not just seated). */
const ACTIVITY_PLAYING = 0x80

/** Most mods a single bullet advertises on the wire (bounds the record size). */
const WIRE_MOD_CAP = 12

const POS_SCALE = 32 // 1/32-tile precision in u16
const FACING_SCALE = 256 / (Math.PI * 2)

/** Largest coordinate the u16 position field can carry (2047.96875 tiles). */
const MAX_WIRE_POS = 0xffff / POS_SCALE

/** Positions ride a u16, which WRAPS on anything outside it: an entity nudged to
 * x = -0.5 by knockback encoded as 65520 and arrived at x = 2047.5 — the far
 * corner of a map that is ~100 tiles across. Clamping keeps an out-of-bounds body
 * pinned at the edge, which reads as a stuck entity instead of a teleport, and
 * (unlike the wrap) never invents a position on the OPPOSITE side of the level. */
const clampPos = (v: number): number => (Number.isFinite(v) ? Math.min(MAX_WIRE_POS, Math.max(0, v)) : 0)

/** Entity count is a u8, so 256+ entities wrapped it (300 -> 44) and the decoder
 * silently returned 44 of them while ignoring 256 records it had no idea were
 * there. The host caps interest at 48, so this is a guard rail, not a live path —
 * but it keeps encode and decode agreeing about the same list. */
const MAX_WIRE_ENTITIES = 255

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
  /** Active element statuses (`Entity.fx` keys) that the renderer tints and
   * shades. Absent = none. */
  statuses?: string[]
  /** A seated NPC's activity at a prop, and whether play has started. */
  activity?: { kind: ActivityKind; playing: boolean }
}

export interface WireSnapshot {
  tick: number
  /** The host's run counter (u8, wraps). A snapshot from an earlier run than the
   * client's GameStart is stale, whatever its tick says. */
  epoch: number
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
  const entities = s.entities.length > MAX_WIRE_ENTITIES ? s.entities.slice(0, MAX_WIRE_ENTITIES) : s.entities
  const w = new ByteWriter(16 + entities.length * 12)
  w.u8(MsgType.Snapshot).u32(s.tick).u8(s.epoch & 0xff).u16(s.lastInputSeq).u8(s.floor).u8(s.alarm).u8(entities.length)
  for (const e of entities) {
    w.u16(e.id)
    w.u8(archetypeIndex.get(normalizeArchetype(e.archetype)) ?? 0)
    w.u8(e.flags)
    w.u16(Math.round(clampPos(e.x) * POS_SCALE))
    w.u16(Math.round(clampPos(e.y) * POS_SCALE))
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
  // Sparse status trailer: the flags byte is full, and most entities carry no
  // status, so only statused records pay. u8 count, then (u8 record index, u8
  // WIRE_STATUSES bitmask) per statused entity. Omitted entirely when nobody is
  // statused, so a quiet snapshot is byte-identical to the pre-trailer format.
  const statused: [number, number][] = []
  entities.forEach((e, i) => {
    let mask = 0
    for (const k of e.statuses ?? []) mask |= wireStatusBit.get(k) ?? 0
    if (mask) statused.push([i, mask])
  })
  // Sparse activity trailer, after the status one: u8 count, then (u8 record
  // index, u8 code) where code is WIRE_ACTIVITIES index + 1, | ACTIVITY_PLAYING
  // once play is on. When it is present the status count is always written,
  // even as 0, so the decoder can tell the two trailers apart.
  const seated: [number, number][] = []
  entities.forEach((e, i) => {
    const k = e.activity ? WIRE_ACTIVITIES.indexOf(e.activity.kind) : -1
    if (k >= 0) seated.push([i, (k + 1) | (e.activity!.playing ? ACTIVITY_PLAYING : 0)])
  })
  if (statused.length > 0 || seated.length > 0) {
    w.u8(statused.length)
    for (const [i, mask] of statused) w.u8(i).u8(mask)
  }
  if (seated.length > 0) {
    w.u8(seated.length)
    for (const [i, code] of seated) w.u8(i).u8(code)
  }
  return w.finish()
}

export const decodeSnapshot = (bytes: Uint8Array): WireSnapshot => {
  const r = new ByteReader(bytes)
  r.u8() // msgType
  const tick = r.u32()
  const epoch = r.u8()
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
  if (r.remaining > 0) {
    const n = r.u8()
    for (let j = 0; j < n && r.remaining >= 2; j++) {
      const target = entities[r.u8()]
      const mask = r.u8()
      const statuses = WIRE_STATUSES.filter((_, bit) => (mask & (1 << bit)) !== 0)
      if (target && statuses.length > 0) target.statuses = statuses
    }
  }
  if (r.remaining > 0) {
    const n = r.u8()
    for (let j = 0; j < n && r.remaining >= 2; j++) {
      const target = entities[r.u8()]
      const code = r.u8()
      const kind = WIRE_ACTIVITIES[(code & ~ACTIVITY_PLAYING) - 1]
      if (target && kind) target.activity = { kind, playing: (code & ACTIVITY_PLAYING) !== 0 }
    }
  }
  return { tick, epoch, floor, alarm, lastInputSeq, entities }
}

/** Button edges as the wire's edge byte: attack 1, interact 2, special 4, and
 * the pure taps roll 8 and Use/Throw 16. */
export interface InputEdges {
  attack: boolean
  interact: boolean
  special: boolean
  roll?: boolean
  throwItem?: boolean
}

export const edgeBits = (e: InputEdges): number =>
  (e.attack ? 1 : 0) | (e.interact ? 2 : 0) | (e.special ? 4 : 0) | (e.roll ? 8 : 0) | (e.throwItem ? 16 : 0)

/** One sampled command and the edges that rode with it. `cmd.seq` names it. */
export interface InputRecord {
  cmd: InputCmd
  edges: number
}

/** Records one Input message carries: the newest plus the three before it, so a
 * lost datagram costs nothing unless four in a row go. */
export const INPUT_REDUNDANCY = 4

/** ext byte: which optional trailers follow a record. */
const EXT_MOD_SWAP = 1
const EXT_DRAFT_PICK = 2

const writeRecord = (w: ByteWriter, { cmd, edges }: InputRecord): void => {
  // `held & 8` says whether aim is active: the angle byte can't encode a
  // centred stick (atan2(0,0)=0 looks like "aim right").
  const aimActive = Math.hypot(cmd.aimX, cmd.aimY) > 0.01
  const held = (cmd.attack ? 1 : 0) | (cmd.interact ? 2 : 0) | (cmd.special ? 4 : 0) | (aimActive ? 8 : 0)
  const swap = cmd.modSwap !== undefined && cmd.modSwap >= 0 && cmd.modSwap <= 0xffff
  const pick = cmd.draftPick !== undefined && cmd.draftPick >= 0 && cmd.draftPick <= 0xff
  w.u16(cmd.seq & 0xffff)
    .u8(Math.round((cmd.moveX + 1) * 127))
    .u8(Math.round((cmd.moveY + 1) * 127))
    .u8(held)
    .u8(edges & 0xff)
    .u8(Math.round(((Math.atan2(cmd.aimY, cmd.aimX) % (Math.PI * 2)) + Math.PI * 2) * FACING_SCALE) & 0xff)
    .u8((cmd.hotbar >= 0 ? cmd.hotbar + 1 : 0) & 0xff)
    .u8((swap ? EXT_MOD_SWAP : 0) | (pick ? EXT_DRAFT_PICK : 0))
  if (swap) w.u16(cmd.modSwap!)
  if (pick) w.u8(cmd.draftPick!)
}

const readRecord = (r: ByteReader): InputRecord => {
  const cmd = emptyInput()
  cmd.seq = r.u16()
  cmd.moveX = r.u8() / 127 - 1
  cmd.moveY = r.u8() / 127 - 1
  const held = r.u8()
  const edges = r.u8()
  const aim = r.u8() / FACING_SCALE
  const hotbar = r.u8()
  const ext = r.u8()
  if (ext & EXT_MOD_SWAP) cmd.modSwap = r.u16()
  if (ext & EXT_DRAFT_PICK) cmd.draftPick = r.u8()
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

/**
 * Input: [type][count u8] then `count` records, oldest first. A record is
 * seq u16, moveX, moveY, held, edges, aim, hotbar, ext (all u8), then a u16 mod
 * swap if ext&1 and a u8 draft pick if ext&2. The host folds each record once by
 * its seq (`foldInputRecord`, app/inputGate.ts), so a repeated record is free and a lost packet's
 * records arrive in the next one.
 */
export const encodeInputBundle = (records: readonly InputRecord[]): Uint8Array => {
  if (records.length === 0 || records.length > 0xff) throw new RangeError(`input bundle of ${records.length} records`)
  const w = new ByteWriter(2 + records.length * 12)
  w.u8(MsgType.Input).u8(records.length)
  for (const rec of records) writeRecord(w, rec)
  return w.finish()
}

export const decodeInputBundle = (bytes: Uint8Array): InputRecord[] => {
  const r = new ByteReader(bytes)
  r.u8()
  const n = r.u8()
  const out: InputRecord[] = []
  for (let i = 0; i < n; i++) out.push(readRecord(r))
  return out
}

export const encodeInput = (cmd: InputCmd, edges: InputEdges): Uint8Array => encodeInputBundle([{ cmd, edges: edgeBits(edges) }])

/** The newest record of an Input message. */
export const decodeInput = (bytes: Uint8Array): InputRecord => {
  const all = decodeInputBundle(bytes)
  if (all.length === 0) throw new RangeError('empty input bundle')
  return all[all.length - 1]
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
  const statuses = e.fx ? Object.keys(e.fx).filter((k) => wireStatusBit.has(k)) : []
  if (statuses.length > 0) we.statuses = statuses
  const shown = shownActivity(e)
  if (shown) we.activity = shown
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
  // Render mirror only: the client never runs statusFx, so `until` just keeps
  // the entry live until the next snapshot restates or drops it. No `source`:
  // the renderer then draws each status at its base intensity and canonical hue.
  if (we.statuses && we.statuses.length > 0) e.fx = Object.fromEntries(we.statuses.map((k) => [k, { until: tick + 2 }]))
  else delete e.fx
  if (we.activity) e.activityShown = { ...we.activity }
  else delete e.activityShown
  if ((we.flags & SnapFlags.HitFlash) !== 0) {
    e.status ??= { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    e.status.hitFlashUntil = tick + 2
  }
  if ((we.flags & SnapFlags.Cloaked) !== 0) {
    e.status ??= { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    e.status.cloakUntil = tick + 2
  }
  // Mirror stun/sleep as 1/0 so the client's prediction gate (isMovementLocked)
  // and the drowsy sprite see them. The client never decrements these; the next
  // snapshot restates or clears them.
  const stun = (we.flags & SnapFlags.Stunned) !== 0 ? 1 : 0
  const sleep = (we.flags & SnapFlags.Sleeping) !== 0 ? 1 : 0
  if (stun || sleep || e.status) {
    e.status ??= { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    e.status.stun = stun
    e.status.sleep = sleep
  }
  if (we.archetype === 'player') {
    e.playerCtl ??= {
      playerId: -1,
      abilityCooldown: 0,
      cash: 0,
      misdeedUntilTick: 0,
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
  /** The host's run counter, as stamped on every snapshot of this run. */
  epoch: number
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
export interface PingMsg {
  t: number
  /** The sender's newest round trip in ms, absent before its first Pong. */
  rtt?: number
}

export interface PongMsg {
  t: number
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
  /** Open `extraction` mission (RenderView.extraction). Optional on the wire. */
  extraction?: { x: number; y: number; held: boolean }
  gameOver: boolean
  alarm: number
  /** STATION ALERT latched on this floor (objective met, escape run on). Optional
   * on the wire for back-compat with an older host. */
  alert?: boolean
  /** #86 lockdown (see RenderView.lockdown). Optional for back-compat. */
  lockdown?: { secondsLeft?: number }
  /** Difficulty rules in force (host authoritative). */
  mode?: 'casual' | 'normal'
  /** Party-shared comebacks left this run (HUD; `normal` only). */
  revivesLeft?: number
  /** This floor's modifier (host truth). Absent on a clean floor and from an
   * older host. The client derives the tide/hunt display from it and its own
   * host-tick estimate, so it needs no per-tick traffic. */
  modifier?: FloorModifier
  /** Per-slot HUD extras for each player's own display.
   *
   * `bandages` is a MISNOMER kept for wire compatibility: netHost.ts fills it
   * with the total quantity of every carried stack except the canister, which
   * is what it always was. Bandages themselves were culled. The field survives
   * the cull because renaming or dropping it would change the shape of a JSON
   * message that peers on an older bundle still send and read, for no gain —
   * the client simply stopped deriving a phantom `bandage` stack from it. */
  huds: Record<
    number,
    { cash: number; weapon: string; abilityCd: number; bandages: number; canister: boolean; draft?: DraftHand }
  >
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
