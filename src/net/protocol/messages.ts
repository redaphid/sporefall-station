import type { Entity, ItemStack } from '../../game/entity'
import { makeEntity } from '../../game/entity'
import { THROWABLES } from '../../game/data/items'
import { OBJECTS } from '../../game/data/objects'
import { SnapFlags } from '../../game/snapshot'
import { isRolling, ROLL_TICKS } from '../../game/systems/roll'
import type { Annotation, AnnotationKind, InputCmd } from '../../game/types'
import { emptyInput } from '../../game/types'
import { sanitizeAnnotation, visibleAnnotations } from '../../game/annotations'
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
 * `BLE_LOBBY_INFO_UUID`'s `@protocolReservation` in net/types.ts.
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
  'pickup.bandage', // RETIRED
  'pickup.medkit', // RETIRED
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
  // PROTOCOL_VERSION 4 — the five planned bosses, BOOKED AHEAD OF THEIR CODE.
  //
  // Only `vigil` is implemented right now. The other five ids are registered
  // anyway, deliberately, and this is the one table where booking ahead is the
  // correct call rather than speculative generality:
  //
  //   - The index IS the wire format. Appending later means ANOTHER version
  //     bump, and every phone in the field must be reinstalled at each one.
  //     Reserving the whole planned set costs six bytes of nothing and buys a
  //     single flag day instead of five.
  //   - Four more boss PRs are queued behind this one (Echo, the Sealkeeper,
  //     Mirefather, the Hollow Choir). If each appends its own archetype, two
  //     landing in the same afternoon append in whichever order they merge —
  //     and the index silently means something different on each branch. That
  //     is precisely the "both builds claim the same version and disagree about
  //     the table" failure this list's header warns about, except self-inflicted
  //     by our own merge order.
  //   - An archetype registered with no NPCS row is explicitly fine:
  //     messages.archetypes.test.ts asserts NPCS ⊆ ARCHETYPES, never the
  //     converse. An id nothing spawns is simply never encoded.
  //
  // `choirmaster` + `herald` are the Hollow Choir's two bodies (a core plus its
  // three heralds), which is why five bosses need six ids.
  'vigil',
  'echo',
  'sealkeeper',
  'mirefather',
  'choirmaster',
  'herald',
  // A WATER hazard cell (systems/water.ts) — a spawnable entity like `fire` and
  // `spore` before it, so it needs a wire index or a flooded room decodes on the
  // other phone as a crowd of Rangers. Appended at the very end, never reordered.
  'water',
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
  // 'fire' is the non-colliding GROUND-HAZARD kind, not just flames: fire, spore
  // clouds and standing water are all cells of it. Without `water` here a puddle
  // is registered on the wire yet still arrives with the wrong kind, and the two
  // screens agree it is water while disagreeing that it is a hazard cell.
  if (archetype === 'fire' || archetype === 'spore' || archetype === 'water') return 'fire'
  if (archetype.startsWith('pickup.') || archetype.startsWith('mod.')) return 'pickup'
  if (OBJECT_ARCHETYPES.has(archetype)) return 'interactable'
  return 'npc'
}

export const encodeSnapshot = (s: WireSnapshot): Uint8Array => {
  const entities = s.entities.length > MAX_WIRE_ENTITIES ? s.entities.slice(0, MAX_WIRE_ENTITIES) : s.entities
  const w = new ByteWriter(16 + entities.length * 12)
  w.u8(MsgType.Snapshot).u32(s.tick).u16(s.lastInputSeq).u8(s.floor).u8(s.alarm).u8(entities.length)
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
  /** Per-slot HUD extras for each player's own display.
   *
   * `bandages` is a MISNOMER kept for wire compatibility: netHost.ts fills it
   * with the total quantity of every carried stack except the briefcase, which
   * is what it always was. Bandages themselves were culled. The field survives
   * the cull because renaming or dropping it would change the shape of a JSON
   * message that peers on an older bundle still send and read, for no gain —
   * the client simply stopped deriving a phantom `bandage` stack from it. */
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

// --- Annotations: host-authored screen furniture, presentation only ---------

/**
 * Host → clients: the inert on-screen annotation set (`game/types.ts`
 * `Annotation`) — entity-pinned labels, pins, arrows, circles, banners.
 *
 * WHY IT IS ON THE WIRE AT ALL. Annotations are how a system TALKS TO THE
 * PLAYER: The Vigil (`game/systems/vigil.ts`) publishes its noise meter this
 * way, and its whole fairness argument is that the meter is visible — stealth
 * you cannot read is a coin flip. Before this message the set existed only in
 * `HostSession.renderView()`, so on a joiner's phone the meter simply did not
 * exist while the host could see it. That is a co-op defect, not a nicety.
 *
 * WHY A JSON MESSAGE AND NOT THE SNAPSHOT. The binary snapshot is the hot path
 * (10 Hz per peer, 25 BLE packets at the 20-byte MTU floor for 48 entities) and
 * every byte added to it is paid on every tick by every peer forever. An
 * annotation changes a handful of times per FIGHT. So this rides the same cold
 * JSON lane the events/inventory traffic already uses, change-gated like
 * `InventoryMsg`: the steady-state cost of an unchanged set is exactly ZERO
 * bytes, not one byte.
 *
 * FULL REPLACEMENT, NOT A DIFF. The set is small and capped, and a replacement
 * makes removal (`vigil.clearMeter` on death) the same code path as addition —
 * no add/remove bookkeeping to drift out of sync, and no way for a client to
 * accumulate marks the host has dropped. The reliable lane is FIFO and never
 * drops or reorders, so the newest set a client has applied is always the
 * newest one sent; there is no ordering guard to carry (unlike snapshots, which
 * ride a latest-wins slot and need `isNewerTick`).
 *
 * INERT BY CONSTRUCTION. Nothing in the sim reads annotations (`world.ts`), the
 * client stores them beside the view rather than in any simulated state, and
 * the values that could affect a client's behaviour are never present: `ttlTick`
 * is resolved HOST-side (below) rather than shipped, because a client's `tick`
 * is its own local frame counter and would expire marks at the wrong moment.
 */
export interface AnnotationsMsg {
  /**
   * The floor this set describes. Annotations are per-floor furniture (a boss
   * meter belongs to the boss's floor), and a client can learn about a floor
   * change from three different messages at three different moments. Tagging
   * the set means the client never has to guess: it draws the set only while
   * the tag matches the floor it is on, so a stale set cannot bleed onto the
   * next floor and a set that arrives just BEFORE the floor change it belongs
   * to is not thrown away either.
   */
  floor: number
  annotations: WireAnnotation[]
}

/** One annotation as it crosses the wire. Deliberately a subset of `Annotation`:
 * `ttlTick` is resolved by the host and never sent (see `toWireAnnotations`). */
export interface WireAnnotation {
  id: number | string
  kind: AnnotationKind
  text?: string
  x?: number
  y?: number
  x2?: number
  y2?: number
  radius?: number
  targetId?: number
  color?: string
}

/**
 * Hard ceiling on annotations in ONE message. The sim's own list is unbounded
 * (a debug agent can add hundreds — `game/annotations.ts`), and the wire is a
 * BLE link where a 490-byte snapshot is already 25 packets. 12 marks of 48
 * characters is ~1KB worst case, which is under `MAX_MESSAGE_BYTES` (16KB) and
 * comparable to one snapshot — and it is only ever paid on CHANGE.
 *
 * Twelve is also a legibility bound, not only a bandwidth one: the overlay
 * de-overlaps and clamps every label on-screen (`ui/annotationLayout.ts`), so
 * far fewer than twelve simultaneous marks are readable on a phone anyway.
 */
export const MAX_WIRE_ANNOTATIONS = 12
/** Characters of `text` per annotation on the wire. The Vigil's meter is 18
 * ("ASLEEP [||···]" and "AWAKE — BACK OFF"); the sim allows 240. */
export const MAX_WIRE_ANNOTATION_TEXT = 48

const round2 = (v: number): number => Math.round(v * 100) / 100

/**
 * Project the host's live annotation list onto the wire (host side).
 *
 * Three things happen here, all of them cheap and all of them deliberate:
 *
 *  - TTL IS RESOLVED NOW. `ttlTick` is an absolute tick in the HOST's clock and
 *    a client's `tick` is its own local frame counter, so forwarding the field
 *    would expire marks at an unrelated moment on each phone. Expired marks are
 *    simply not sent, and the field never crosses.
 *  - MARKS WITH A DEAD/ABSENT TARGET ARE DROPPED. `isDrawable` is asked about
 *    the HOST's world, not the peer's interest set: interest culling is
 *    per-peer and flaps as entities cross the 14-tile boundary, so gating on it
 *    would churn this message (and its bytes) every few ticks for a mark the
 *    player is about to see again. A mark whose target the client has not been
 *    sent is harmless — the overlay's `anchorOf` finds no entity and draws
 *    nothing, then draws it the moment the entity arrives.
 *  - UNTRUSTED SIZES ARE CLAMPED. Count and text length both, so no amount of
 *    annotating can produce a message the framing layer has to refuse.
 */
export const toWireAnnotations = (
  annotations: readonly Annotation[],
  tick: number,
  isDrawable: (targetId: number) => boolean,
): WireAnnotation[] => {
  const out: WireAnnotation[] = []
  for (const a of visibleAnnotations(annotations, tick)) {
    if (out.length >= MAX_WIRE_ANNOTATIONS) break
    if (a.targetId !== undefined && !isDrawable(a.targetId)) continue
    const w: WireAnnotation = { id: a.id, kind: a.kind }
    if (typeof a.text === 'string') w.text = a.text.slice(0, MAX_WIRE_ANNOTATION_TEXT)
    if (typeof a.color === 'string') w.color = a.color.slice(0, 32)
    if (a.targetId !== undefined) w.targetId = a.targetId
    if (a.x !== undefined) w.x = round2(a.x)
    if (a.y !== undefined) w.y = round2(a.y)
    if (a.x2 !== undefined) w.x2 = round2(a.x2)
    if (a.y2 !== undefined) w.y2 = round2(a.y2)
    if (a.radius !== undefined) w.radius = round2(a.radius)
    out.push(w)
  }
  return out
}

/**
 * Validate one received annotation set (client side).
 *
 * The host is not trusted here for the same reason `handleMessage` wraps every
 * decode in a try/catch: the bytes came off a radio, and a peer on a different
 * build (or a hostile one) can say anything. Each mark goes through the SIM's
 * own `sanitizeAnnotation`, which reads only whitelisted fields — so a
 * `__proto__` key can never reach a prototype — and a malformed one costs only
 * ITSELF rather than the whole set. Count and text are clamped again on the way
 * in, because a cap enforced only by the sender is not a cap.
 */
export const fromWireAnnotations = (raw: unknown): Annotation[] => {
  if (!Array.isArray(raw)) return []
  const out: Annotation[] = []
  let seq = 0
  for (const item of raw.slice(0, MAX_WIRE_ANNOTATIONS)) {
    try {
      // Truncate before validating: over-long text from a peer that forgot to
      // clamp should arrive SHORTENED, not vanish.
      const trimmed =
        item !== null && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? { ...(item as object), text: (item as { text: string }).text.slice(0, MAX_WIRE_ANNOTATION_TEXT) }
          : item
      out.push(sanitizeAnnotation(trimmed, () => ++seq))
    } catch {
      // One malformed mark costs only itself; the rest of the set still draws.
    }
  }
  return out
}
