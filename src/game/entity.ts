import type { BuildingRole } from './levelgen/level'
import type { EntityId, Vec2 } from './types'

export type EntityKind = 'player' | 'npc' | 'projectile' | 'pickup' | 'door' | 'interactable' | 'fire'

/** One active status/element effect: the absolute tick at (or before) which it
 * expires, plus who applied it. Keyed by effect kind on `Entity.fx`. Mirrors
 * brain's `fx` convention — absolute-tick expiry keeps it snapshot-safe. */
export interface StatusEntry {
  until: number
  source?: EntityId
}

export type Fx = Record<string, StatusEntry>

/** Anti-chain-lock bookkeeping for ONE immobilize kind ('electrified'/'frozen'),
 * keyed by kind on `Entity.lockout`. Kept OUT of `fx` on purpose: it outlives the
 * active immobilize (to enforce a post-immobilize immunity window and remember the
 * diminishing "tier"), and render/element systems iterate `fx` — a bookkeeping
 * entry there would draw a phantom status. All fields are absolute ticks / a small
 * int, so it snapshots and replays byte-for-byte like any other component.
 *
 *  `guardUntil` — no NEW immobilize of this kind may start before this tick (the
 *   guaranteed counterplay window after an immobilize ends).
 *  `chainUntil` — the chain stays "hot" until here; a hit that lands while hot is
 *   diminished (see statusFx.ts); after it the chain cools and re-starts at full.
 *  `tier` — how many immobilizes deep this hot chain is (1 = first, full duration).
 */
export interface LockoutEntry {
  guardUntil: number
  chainUntil: number
  tier: number
  /** Only set for the LEGACY counter-based immobilizes (`stun`/`sleep`), which
   * live on `Entity.status` counters instead of `fx`: with no `fx[kind].until` to
   * read, this is how the guard knows a lock is still running. Absent for
   * `frozen`/`electrified`, which read their active window straight off `fx`. */
  activeUntil?: number
}

export type AiMode = 'idle' | 'wander' | 'patrol' | 'aggro' | 'flee' | 'seek' | 'sleep'
export type Faction = 'civ' | 'cop' | 'gang' | 'neutral'

/** A disposition band, derived from numeric hate by `determineRel`. */
export type RelStatus = 'Friendly' | 'Neutral' | 'Annoyed' | 'Hostile'

/** One agent's view of another: raw hate and the band it derives. */
export interface RelEntry {
  hate: number
  code: RelStatus
}

/** Data parameters a behavior reads (systems/behaviors.ts). Plain JSON — part
 * of the entity, so a configured brain snapshots and replays losslessly. */
export interface AiBehaviorParams {
  /** Patrol: the waypoint loop to walk, in order. */
  waypoints?: Vec2[]
}

/** A hunter's area sweep after a chase goes cold: `cx/cy` anchor the spot where
 * the trail was lost, `x/y` is the sweep point currently being checked, `left`
 * counts remaining sweeps, `until` (absolute tick) abandons an unreachable point. */
export interface AiSearch {
  cx: number
  cy: number
  x: number
  y: number
  left: number
  until: number
}

export interface AiState {
  mode: AiMode
  faction: Faction
  home: Vec2
  targetId?: EntityId
  waypoint?: Vec2
  /** Next tick this NPC runs its full think step. */
  thinkAt: number
  sightRange: number
  lastKnownTargetPos?: Vec2
  /** Per-other-entity disposition, keyed by that entity's id. Absent until this
   * NPC has an opinion; the initial stance is derived from faction on the fly. */
  rel?: Record<EntityId, RelEntry>
  /** Holds position instead of idle-wandering until it spots a target. */
  guard?: boolean
  /** #69 Mireclaw boss — next tick it may summon brood (phase-1 throttle). */
  summonAt?: number
  /** #69 Mireclaw boss — phase-3 enrage latched (one-time speed boost applied). */
  enraged?: boolean
  /** #68 — INERT until a stimulus wakes it: no move, no target, minimal
   * perception (the awakeningSystem flips it false and emits `woke`). A sleeping
   * pod / dormant unit the player can tiptoe past — or trip. */
  dormant?: boolean
  /** #68 — stimulus kinds that WAKE this entity from `dormant` (and, for a
   * non-dormant Derelict Unit, the `'power-cut'` that rouses it to hostility):
   * 'noise' | 'spore' | 'fire' | 'proximity' | 'power-cut' | 'damage'. The
   * data-row that replaces the hardcoded `archetype === 'robot'` special case. */
  wakeOn?: string[]
  /** #77 — the station module this NPC BELONGS to: index into `level.buildings`
   * plus that building's role, stamped at spawn by populate. Drives the
   * territorial goals (work its room, garrison/defend the objective wing).
   * Absent for street life / roamers and any directly-spawned (test/scenario)
   * NPC → snapshot-stable, and the brain falls back to plain wander. */
  zone?: { building: number; role: BuildingRole }
  /** The goal chosen by the last arbitration (battle/flee/pursue/investigate/
   * wander/patrol/search/alert/scavenge) — drives `mode`, exposed for debugging. */
  goal?: string
  /** Behavior registry id (systems/behaviors.ts). Absent/unknown → 'basic'. */
  behavior?: string
  /** Data parameters for the behavior (e.g. patrol waypoints). */
  params?: AiBehaviorParams
  /** Why the last think chose its goal: per-consideration top scores — the
   * legible "thought record" an agent (or the `ai` debug verb) reads back. */
  lastScores?: Record<string, number>
  /** Tick the current `goal` was adopted (how long it has wanted this). */
  goalSince?: number
  /** Patrol: index into `params.waypoints` of the leg being walked. */
  patrolIndex?: number
  /** Hunter: the in-progress area sweep after losing a target. */
  search?: AiSearch
  /** Who scared this NPC (set on fleeing/alerting) — the alert's subject. */
  fearId?: EntityId
  /** #65 — a POINT to flee away from when there is no threat ENTITY to run from
   * (a caught fear pulse / stampede). Steering uses it when `targetId` is unset. */
  fleeFrom?: Vec2
  /** Where a burning body is running from while it panics (statusFx `panic`);
   * the window itself is `lockout.panic`. */
  panicFrom?: Vec2
  /** Skittish: threat id already reported to a guard (don't re-alert). */
  alerted?: EntityId
  /** Where/when this NPC last made real progress toward an UNSEEN chase goal —
   * the safety net under the router: if even a routed pursuit stalls (bodies
   * jamming a doorway), the trail is declared cold instead of grinding. */
  progress?: { x: number; y: number; tick: number }
  /** Scavenger: item ids collected so far — a legible loot trail. */
  stash?: string[]
  /** Cached tile route steering follows node-to-node (path.ts): tile-centre
   * nodes, the index being walked, and the goal it was computed for. Plain
   * JSON, so a mid-route snapshot replays byte-identically. */
  path?: { nodes: Vec2[]; i: number; goal: Vec2 }
  /** Next tick this NPC may recompute a route — staggered by entity id so
   * repaths never bunch on one tick and peers stay deterministic. */
  repathAt?: number
  /** Stand-and-scan window (absolute tick): after arriving somewhere the NPC
   * plants and sweeps its facing — "got here on purpose, now looking around".
   * Any urgent mode (aggro/flee/seek) cancels it instantly. */
  scanUntil?: number
  /** Squad membership (behavior 'squad'): shared squad id + this member's role
   * in the stack. Assigned by populate for gangster packs. */
  squad?: { id: number; role: 'lead' | 'flank' | 'rear' }
  /** Group membership (systems/groups.ts): the id of a `World.groups` entry —
   * a raid ("tide") or a hound pack — plus this member's role in it. The group
   * layer owns the shared state (phase, target, rally point); every member reads
   * it through its considerations. Absent on everything else → snapshot-stable. */
  group?: { id: number; role: GroupRole }
  /** RALLIED by a live leader within earshot until this absolute tick: faster
   * and harder to hurt (systems/groupFx.ts). Refreshed every tick by the group
   * layer while in range, so it lapses a moment after the leader falls. */
  rallyUntil?: number
  /** MANHUNTER until this absolute tick (hound pack rage): faster, never flees,
   * tracks the aggressor (systems/groups.ts). */
  rageUntil?: number
  /** Latched retreat-to-heal: set below the retreat threshold while the group
   * has a live medic, cleared once patched back up (systems/groups.ts). */
  healing?: boolean
  /** A player that hurt this body since the group layer last looked — the
   * manhunter trigger. Stamped by combat.applyDamage, consumed by groups.ts. */
  provokedBy?: EntityId
  /** Lobber (siege gun): next absolute tick it may fire a shell. */
  lobAt?: number
}

/** A member's job inside its group (systems/groups.ts). */
export type GroupRole = 'leader' | 'grunt' | 'medic' | 'sapper' | 'artillery' | 'hound'

/** One applied weapon modifier: a registry id (`data/mods.ts`) plus a
 * deterministic stack count. Pure JSON — no functions/closures — so a modded
 * loadout serializes and round-trips byte-for-byte like any other component.
 * ROUNDS-style: the same card can be picked (stacked) multiple times. */
export interface WeaponMod {
  id: string
  stacks: number
}

export interface ItemStack {
  itemId: string
  qty: number
  /** Present only on a modded weapon; absent = vanilla, so every pre-existing
   * fixture/snapshot serializes byte-for-byte unchanged (same optional-field
   * discipline as `annotations`). Resolved by `resolveWeapon` at the fire site. */
  mods?: WeaponMod[]
  /** The position in the weapon's live mod window that the next cast starts
   * from (systems/modSequence). Only a wand whose cycle has two or more casts
   * carries it; a one-cast wand or a stack with no mods never does. */
  castIndex?: number
  /** Absolute tick until which the weapon recharges after a cycle of two or
   * more casts wrapped. Absent until the first such wrap. */
  rechargeUntil?: number
}

/** Slot-based equipment — the ONE loadout representation shared by players AND
 * NPCs, so "an enemy's inventory === a player's inventory" is a structural fact,
 * not a parallel code path. Every inventory accessor (systems/inventory.ts) and
 * the shared fire site (combat.fireWeapon) read it off `Entity.loadout`, so a
 * modded gun folds its mods into the projectile identically whoever pulls the
 * trigger. OPTIONAL on the entity: an entity with no `loadout` (a townsfolk with
 * innate fists, a class-starter with no slot) resolves VANILLA — undefined stack,
 * infinite/no-wear — exactly as an inventory-less NPC did before this component
 * existed, so every pre-loadout snapshot round-trips byte-for-byte. */
/** A floor-draft hand a player is still choosing from (systems/draft.ts). */
export interface DraftHand {
  /** The mod ids on offer, in card order. */
  offer: string[]
  /** Index of the card under this player's cursor. */
  cursor: number
  /** Absolute tick at which the hand takes the card under the cursor. */
  until: number
  /** Intent bits held on the previous tick. Cards move or are taken only on a
   * fresh press, and a hand opens with every bit set, so a stick or trigger still
   * held from walking onto the exit does nothing until released. */
  held: number
}

export interface Loadout {
  /** Slot-based inventory; each stack's qty doubles as ammo/durability/count. */
  inventory: ItemStack[]
  /** Equipped/hotbar slot index into `inventory`; -1 = bare fists. */
  activeSlot: number
}

export interface Entity {
  id: EntityId
  kind: EntityKind
  /** Key into data/ definitions: 'thug', 'cop', 'player', 'grenade', 'door.wood', ... */
  archetype: string
  pos: Vec2
  /** Position at the previous tick — used for render interpolation. */
  prevPos: Vec2
  /** Knockback/impulse velocity (tiles/sec), decays with friction. */
  vel: Vec2
  /** Desired movement direction (unit vector), set by input or AI. */
  intent: Vec2
  /** Walk speed in tiles/sec. */
  speed: number
  radius: number
  facing: number // radians

  /** A furnishing that STANDS AGAINST a wall, facing out of it (so the wall is
   * at `facing + π`). Purely presentational: the renderer nudges the sprite that
   * way so a rank of shelving kisses the wall instead of floating a half-tile
   * off it. The sim treats a mounted prop exactly like any other soft prop —
   * same tile, same collision, same hp. Absent on everything else, so every
   * pre-existing snapshot round-trips byte-for-byte. */
  mount?: 'wall'

  /** Stair hysteresis (stairs.ts `stairStep`): set by a climb, held while the
   * body stands on the stair or near its landing (the 3x3), cleared once it
   * steps clear — so holding "forward" after arriving can't bounce it
   * straight back. Omitted when clear, so every pre-stairs snapshot
   * round-trips byte-for-byte. */
  stairLock?: true

  health?: {
    hp: number
    max: number
    iframes: number
    /** Absolute tick of the last LANDED blow (set by combat.applyDamage and the
     * shock arc). Drives passive regen: the "unharmed" clock (systems/regen.ts)
     * counts from here. Optional/absent until first hurt, so pre-feature snapshots
     * round-trip byte-for-byte (same discipline as `mods`/`annotations`). */
    lastHurtTick?: number
    /** Lifesteal earned but not yet paid, in [-0.5, 0.5). hp stays whole, so each
     * heal pays Math.round of what is owed (the damage rounding rule) and carries
     * the rest to the next hit. Carrying lets small hits add up: rounded alone, a
     * 1-stack build heals 0 on any hit of 3 or less, such as a machinegun into a
     * brute. Absent until the first lifesteal hit, so older snapshots round-trip. */
    lifestealCarry?: number
  }
  // (Spawn-protection grace for players rides `health.iframes` — see
  // SPAWN_GRACE_TICKS below — so every damage source already honors it.)
  combat?: { weapon: string; cooldown: number }
  /** #78 — damage AFFINITY table: a multiplier on incoming damage keyed by kind
   * (`'physical'` for weapon impact/explosions, or an element id: `burning`,
   * `spore`, `poisoned`, `electrified` for the wet-shock arc). 1 = neutral, <1
   * resistant, 0 = immune, >1 vulnerable.
   * A missing key (or absent table) is neutral (×1), so every existing entity
   * and fixture is byte-identical. Copied from the archetype (`NpcDef.resist`)
   * at spawn; this is what makes different enemies demand different tools. */
  resist?: Record<string, number>
  ai?: AiState
  /** Slot-based equipment (weapons + items + weapon-mods) — shared by players and
   * NPCs alike (see `Loadout`). The player's hotbar and an enemy's carried, moddable
   * arsenal are ONE component read by ONE set of accessors. Absent = innate/vanilla
   * loadout (bare fists, no mods), the pre-loadout default for weaponless NPCs. */
  loadout?: Loadout
  playerCtl?: {
    playerId: number
    abilityCooldown: number
    cash: number
    crimeUntilTick: number
    /** Passive-regen bookkeeping (systems/regen.ts): consecutive ticks this player
     * has been BOTH completely still and unharmed. Reset to absent the instant they
     * move or take a hit; once it reaches REGEN_CALM_TICKS the player heals over
     * time. Absent (never 0) when the streak is broken, so an active/moving player
     * serializes byte-for-byte as before this feature. */
    regenCalm?: number
    downed?: { bleedTicks: number; reviveProgress: number }
    /** Timed action in progress (lockpicking). Deliberate movement, damage, or
     * drifting out of range cancels it. `total` is the full channel length so
     * UIs can draw progress without re-deriving lock tables. */
    channel?: { kind: 'lockpick'; targetId: EntityId; ticksLeft: number; total: number }
    /** Active dodge-roll (Enter-the-Gungeon style). Absent = not rolling and off
     * cooldown; all fields are ABSOLUTE ticks / a unit direction, so it serializes
     * and replays byte-for-byte like `hitFlashUntil`. `untilTick` bounds the i-frame
     * + speed-burst window; `cooldownUntilTick` gates the next roll (no chaining);
     * `dirX/dirY` is the frozen roll heading (move dir, or facing when stationary). */
    roll?: { untilTick: number; cooldownUntilTick: number; dirX: number; dirY: number }
    /** Present while this player is choosing a mod from the floor draft. */
    draft?: DraftHand
  }
  projectile?: {
    ownerId: EntityId
    damage: number
    ttl: number
    /** Grenades: AoE on fuse-end or impact instead of point damage. `element`:
     * the element mod id the blast applies (ResolvedWeapon.carries). */
    explode?: { radius: number; damage: number; element?: string }
    /** Thrown items: the area effect applied where it lands (grenade → explode). */
    onLand?: import('./data/items').AreaEffect
    /** Status inflicted on the entity a bullet strikes (freeze ray, tranq). */
    onHit?: import('./data/items').StatusApply
    // ---- weapon-mod behavior fields (all optional → snapshot-stable). ----
    /** Extra victims to pass through before dying (pierce). Decrements per body. */
    pierceLeft?: number
    /** Wall bounces left — reflect off a blocked tile instead of dying (bounce). */
    bounceLeft?: number
    /** Per-tick turn rate (radians) of the homing seeker head. Steering is
     * line-of-sight-gated and cone-limited (see projectiles.homeToward): the
     * round chases only VISIBLE enemies of its owner ahead of it, and flies
     * straight otherwise — it never curves at something behind a wall. */
    homing?: number
    /** Spawn N damaging children on the first body it strikes (split/multishot).
     * `element`: the element mod id the shards apply (ResolvedWeapon.carries). */
    split?: { count: number; damage: number; speed: number; ttl: number; element?: string }
    /** Shatter into a RADIAL burst of short-range fragments on ANY termination —
     * wall/ttl/body impact (splinterShot). Distinct from `split` (a forward fork
     * on first body hit): this is an omnidirectional shrapnel spray at the point
     * the round dies. Fragments never carry this field, so they can't re-splinter.
     * `element`: the element mod id the fragments apply. */
    splinter?: { count: number; damage: number; speed: number; ttl: number; element?: string }
    /** Heal the owner by frac·damage dealt on each hit (lifesteal). */
    lifestealFrac?: number
    /** Bodies already struck (pierce), so one victim isn't re-hit every tick. */
    hitIds?: EntityId[]
    /** Resolved trigger effects fired on hit/kill (on-reload handled elsewhere). */
    triggers?: import('./data/mods').ResolvedTrigger[]
    /** Build provenance: the (normalized) mods of the cast that fired this shot
     * (ResolvedWeapon.mods), so it never shows another cast's element.
     * Pure inert data — no system reads it — carried so the renderer (and
     * net peers, via the snapshot codec) can COMPOSE the bullet's procedural
     * look from its mods, Nova-Drift style. Absent = vanilla shot, so every
     * pre-feature world/fixture serializes byte-for-byte unchanged. */
    mods?: WeaponMod[]
    /** A LOBBED shell (the siege gun's): it arcs OVER bodies and walls and
     * only resolves where it comes down, at ttl — never on the first thing in
     * its path. Absent on every ordinary projectile → snapshot-stable. */
    arc?: boolean
  }
  pickup?: { itemId: string; qty: number }
  /**
   * A door/hatch. `open`/`locked`/`lockLevel` are the original mundane lock (a
   * pick channel opens it — interaction.ts). Everything below is OPTIONAL, so a
   * plain door serializes byte-for-byte as before (same discipline as `mods`):
   *
   * ── Increment A "Credentials & Power": a sealed biolock hatch ──
   *  `sealKind` — how it opens beyond a breach: `'pick'` (mundane, the slow
   *   channel), `'keycard'` (needs the `keyId` item in hand), or `'power'` (auto-
   *   unseals when its `wing`'s power is cut, `World.powerCut`). A sealed hatch is
   *   also `locked:true` (so lock-aware code still treats it as shut).
   *  `keyId` — the exact item id a keycard seal demands (e.g. 'keycard.north').
   *  `wing`  — the power grid this hatch (and its generator) belong to.
   *
   * ── Increment B "The Living Seal": an overgrown hatch ──
   *  `overgrown` — bog-sealed, not locked in the mechanical sense: no pick/keycard
   *   opens it. Clear it with FIRE (erodes `growthHp`), by killing the linked
   *   Spore Node (`nodeId`), or by breaching (ruptures a spore-sac).
   *  `growthHp` — bog integrity; fire/burning erodes it to 0 → the hatch unseals.
   *  `nodeId`   — the Spore Node entity feeding this growth; its death unseals.
   *
   * ── Boss-door aggro: the mission objective's gateway ──
   *  `objectiveGate` — this is the door directly guarding the mission target (boss
   *   room / objective room). Breaching it (unlock by ANY means — pick, keycard,
   *   power-cut, breach) is a point-of-no-return that turns the whole floor hostile
   *   (see systems/missions.ts). Tagged at mission-gen; absent on every other door.
   */
  door?: {
    open: boolean
    locked: boolean
    lockLevel: number
    sealKind?: 'pick' | 'keycard' | 'power'
    keyId?: string
    wing?: string
    overgrown?: boolean
    growthHp?: number
    nodeId?: EntityId
    objectiveGate?: boolean
  }
  interact?: { verb: 'open' | 'pickup' | 'talk' | 'use'; range: number }
  /** A generator / Cryo Terminal's power grid: hacking it cuts power to this
   * `wing` (World.powerCut), auto-unsealing that wing's `'power'` biolocks. */
  wing?: string
  /** A spreading bog-spore hazard occupying this cell — kind 'fire' (a non-
   * colliding ground hazard). `fuel` burns down 1/tick; while it lasts it lays
   * the `spore` element on bodies standing in the cell (see systems/spore.ts). */
  spore?: { fuel: number }
  /** A HIVE SPIRE's infestation clock (systems/groups.ts): absolute ticks for its
   * next bud and next spread, plus the live buds it has spawned (capped). */
  hive?: { nextSpawnAt: number; nextSpreadAt: number; children: EntityId[] }
  status?: { stun: number; sleep: number; hitFlashUntil: number; cloakUntil: number }
  /** Active status/element effects, keyed by kind ('burning', ...). */
  fx?: Fx
  /** Anti-chain-lock trackers for immobilize statuses, keyed by kind. Absent until
   * an immobilize lands; pruned when its chain cools (statusFx.ts). Never immobilizes
   * on its own — pure bookkeeping that a single stunGun can't perma-lock the player. */
  lockout?: Record<string, LockoutEntry>
  /** Tiles/objects/actors that fire can catch and spread through. */
  flammable?: boolean
  /** A fire hazard occupying this cell — kind 'fire'. `fuel` burns down 1/tick. */
  fire?: { fuel: number }
  /** Destroyed by shattering a frozen body — an ice gib, not a corpse. */
  shattered?: boolean
  /** A usable object (ATM/vending) that has already dispensed once. */
  used?: boolean
  dead?: boolean
  // ── #64 spore contamination (gated by systems/infection.ts INFECTION_ENABLED) ──
  /** Cumulative spore-exposure load; at INFECT_THRESHOLD a crew member TURNS.
   * Absent until first exposed → snapshot-stable, and never set while the
   * infection feature is off (the shipped default). */
  sporeLoad?: number
  /** This agent has turned into a mindless Infected host — hostile to every
   * uninfected body, driven by the `infected` brain (systems/behaviors.ts). Set
   * only by the infection system when the feature is enabled. */
  infected?: boolean
  /** General UI selection state — the player tapped/clicked this entity to point
   * it out. Multi-select: any number of entities may be `selected` at once. Inert
   * to the sim (no system reads it), so it never affects determinism; it rides
   * along in the entity's serialized JSON like any other component. An agent finds
   * selected entities with a normal `entities`/`get` query (filter on this flag). */
  selected?: boolean
}

/** Spawn-protection grace, in ticks (~3s at 30tps), granted to players when they
 * spawn or land on a new floor. Rides `health.iframes`, which applyDamage checks
 * before any hit, so melee, bullets, explosions and DOT hits all respect it. It
 * decays via the normal status-system countdown; a fresh spawn can act freely
 * (grace is invulnerability, not a stun). Lives here — the one leaf module both
 * `player.ts` and `systems/missions.ts` can import without a cycle. */
export const SPAWN_GRACE_TICKS = 90

/** Default body radius for a walking entity (players and most NPCs). Named and
 * exported so SPAWN PLACEMENT can test the same circle the collision resolver
 * will (game/spawnPlacement.ts): a hard-coded copy that drifted from this would
 * put bodies where they cannot stand, which is unrecoverable — see the entombment
 * note there. Smaller than half a tile, so a body centred on a tile centre always
 * fits inside that one tile. */
export const BODY_RADIUS = 0.35

/** Bare entity with no id — World.addEntity assigns ids so worlds stay self-contained. */
export const makeEntity = (
  kind: EntityKind,
  archetype: string,
  x: number,
  y: number,
  radius = BODY_RADIUS,
): Entity => ({
  id: 0,
  kind,
  archetype,
  pos: { x, y },
  prevPos: { x, y },
  vel: { x: 0, y: 0 },
  intent: { x: 0, y: 0 },
  speed: 0,
  radius,
  facing: 0,
})

/** #78 — the incoming-damage multiplier `e` takes from `kind` ('physical' or an
 * element id). Absent table/key → 1 (neutral), so it never perturbs an entity
 * that carries no affinities. The single source of truth read by the impact
 * damage path (combat.applyDamage) and the element DOT tick (elementSystem). */
export const resistMult = (e: Entity, kind: string): number => e.resist?.[kind] ?? 1
