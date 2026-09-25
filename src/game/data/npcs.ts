import type { Faction } from '../entity'

export interface NpcDef {
  archetype: string
  faction: Faction
  hp: number
  speed: number // tiles/sec
  weapon: string
  sightRange: number
  /** Innate temperament: aggro anyone on sight (thugs) vs only criminals (cops)
   * vs never (civs).
   *
   * NB this is FLAVOUR, not the targeting rule — the only reader is the inspect
   * card (`ui/inspectModel.ts`). Actual fight/flee targeting is decided by
   * `behaviors.isHostileTarget`, which goes by the faction matrix, stored
   * disposition and `world.hostile`. Keep the two in step by hand; a value here
   * that contradicts an archetype's behaviour just mislabels it to the player. */
  hostility: 'always' | 'lawful' | 'never'
  fleesOnDamage: boolean
  /** Peaceful until hit, then fights back (bouncers). */
  retaliates?: boolean
  /** Behavior registry id (systems/behaviors.ts) newly spawned NPCs of this
   * archetype think with. Absent → 'basic'. Populate may override per-spawn
   * (street cops get a patrol beat, some civilians scavenge). */
  behavior?: string
  /** #78 — damage AFFINITY table copied to `Entity.resist` at spawn: incoming
   * damage multiplier keyed by `'physical'` (impact/explosion) or an element id
   * (`burning`/`spore`/`poisoned`). 1 neutral, <1 resist, 0 immune, >1 weak.
   * Absent → neutral to everything (the townsfolk baseline). This is what makes
   * a Sporefall enemy DEMAND a particular tool — no single weapon clears them all. */
  resist?: Record<string, number>
  /** #68 — spawns INERT until a stimulus wakes it (the spore pod, the lurker).
   * NOT the Derelict Unit: that one spawns awake and merely turns hostile on a
   * `wakeOn` power-cut, so it sets `wakeOn` WITHOUT `dormant`. */
  dormant?: boolean
  /** #68 — stimulus kinds that wake it (also the Derelict Unit's `'power-cut'`
   * rouse). Copied to `Entity.wakeOn` at spawn. */
  wakeOn?: string[]
}

export const NPCS: Record<string, NpcDef> = {
  thug: {
    archetype: 'thug',
    faction: 'gang',
    hp: 40,
    speed: 3.4,
    weapon: 'bat',
    sightRange: 7,
    hostility: 'always',
    fleesOnDamage: false,
  },
  boss: {
    // #69 Mireclaw Alpha: a phased apex predator, not a fat gangster. Lives in
    // the spore (immune) and uses it as a lifeline in phase 2.
    //
    // BALANCE (was hp 80 / bat / no physical resist — measured, not guessed;
    // see scripts/test/boss-ttk-probe.ts). At 80hp the "apex predator" died in
    // 1.9s of pistol fire while an ORDINARY brute took 4.2s, so the boss was a
    // QUARTER of the fight of a rank-and-file enemy. Worse, its own three-phase
    // brain was unobservable: 80hp is 5 pistol shots, which split 3/2/1 across
    // summon/regen/enrage — phase 1 lasted 1.4s against a 3.0s summon throttle,
    // so a player never saw it summon, regenerate or enrage even once.
    //
    // 320hp @ physical 0.75 = 427 effective HP = 24 pistol shots = ~10.7s of
    // perfect fire, 2.5x the brute, and it splits 12/7/5 shots so all three
    // phases are legible (phase 1 now outlasts the 3s summon throttle).
    // The resist is deliberately MILD (25% off, vs the brute's 45%):
    // feat/one-weapon RAISED resist multipliers because heavy ones read as
    // immunity in a pistol-only world, and this stays inside that budget. Fire
    // is the counterplay on both axes — 1.25x damage AND it denies the phase-2
    // cloud regen (systems/mireclaw.inSafeCloud).
    //
    // NB the ratio, not the absolute, is the invariant: populate.spawnNpc ramps
    // every archetype +15% hp per floor, so boss and brute stretch together.
    //
    // speed 3.6 -> 3.2 so the 1.4x enrage burst lands at 4.48, a hair under
    // PLAYER_SPEED (4.5): phase 3 is a chase you can barely win, not an
    // unavoidable one.
    archetype: 'boss',
    faction: 'gang',
    hp: 320,
    speed: 3.2,
    weapon: 'claws',
    sightRange: 10,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'mireclaw',
    resist: { physical: 0.75, burning: 1.25, poisoned: 0.5, spore: 0 },
  },
  cop: {
    archetype: 'cop',
    faction: 'cop',
    hp: 60,
    speed: 4.0,
    weapon: 'bat',
    sightRange: 8,
    hostility: 'lawful',
    fleesOnDamage: false,
  },
  gangster: {
    archetype: 'gangster',
    faction: 'gang',
    hp: 35,
    speed: 3.6,
    weapon: 'pistol',
    sightRange: 8,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'hunter',
  },
  bouncer: {
    archetype: 'bouncer',
    faction: 'neutral',
    hp: 90,
    speed: 3.0,
    weapon: 'fists',
    sightRange: 5,
    hostility: 'never',
    fleesOnDamage: false,
    retaliates: true,
  },
  civilian: {
    archetype: 'civilian',
    faction: 'civ',
    hp: 25,
    speed: 3.2,
    weapon: 'fists',
    sightRange: 6,
    hostility: 'never',
    fleesOnDamage: true,
    behavior: 'skittish',
  },
  shopkeeper: {
    archetype: 'shopkeeper',
    faction: 'civ',
    hp: 45,
    speed: 3.2,
    weapon: 'bat',
    sightRange: 6,
    hostility: 'never',
    fleesOnDamage: false,
  },
  scientist: {
    archetype: 'scientist',
    faction: 'civ',
    hp: 30,
    speed: 3.0,
    weapon: 'fists',
    sightRange: 6,
    hostility: 'never',
    fleesOnDamage: true,
    behavior: 'skittish',
  },
  robot: {
    archetype: 'robot',
    faction: 'neutral',
    hp: 70,
    speed: 2.6,
    weapon: 'fists',
    sightRange: 7,
    hostility: 'always',
    fleesOnDamage: false,
    // Derelict Unit: armour-plated (bullets/melee ping off) and biologically
    // inert (spore/toxins do nothing) — but its servos cook, so FIRE is the key.
    resist: { physical: 0.4, burning: 1.5, poisoned: 0, spore: 0 },
    // #68: the power-cut rouse is now a data row, not an `archetype ===` branch.
    wakeOn: ['power-cut'],
  },

  // ── #78 Sporefall threat roster — each DEMANDS a different tool ──────────────
  // A rock-paper-scissors so no single weapon clears the deck: the brute laughs
  // off bullets (burn it), the cinder shrugs off fire (shoot it), the sporeling
  // ignores toxins (bullets or fire). Placement into encounters is a follow-up;
  // these are the tuned palette (spawnable by scenarios / the boss / debug).
  brute: {
    // Chitin-plated bruiser: soaks impact, slow, but flammable — bring fire.
    archetype: 'brute',
    faction: 'gang',
    hp: 95,
    speed: 2.5,
    weapon: 'bat',
    sightRange: 8,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'hunter',
    resist: { physical: 0.35, burning: 1.5, poisoned: 1.0 },
  },
  cinder: {
    // Ash-dweller: takes only 20% from fire (resistant, NOT immune), so a
    // flamethrower/molotov build stalls out on it — shoot it instead.
    archetype: 'cinder',
    faction: 'gang',
    hp: 45,
    speed: 3.4,
    weapon: 'fists',
    sightRange: 8,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'hunter',
    resist: { physical: 1.1, burning: 0.2 },
  },
  sporeling: {
    // Fast, fragile swarm-thing: spore-immune and toxin-resistant, but flammable
    // and squishy to bullets — poison whiffs, crowd/AoE or fire shines.
    archetype: 'sporeling',
    faction: 'gang',
    hp: 22,
    speed: 4.4,
    weapon: 'fists',
    sightRange: 9,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'vermin', // #66: a hive drawn to the loudest/brightest stimulus
    resist: { burning: 1.5, poisoned: 0.15, spore: 0 },
  },
  stalker: {
    // #67 Mireclaw brood scavenger: hunts the weakest, shies from a healthy pack.
    // Its own faction ('neutral') is its pack — it culls the wounded of every
    // OTHER side (crew, cops, gangs, players). Fast, fragile, opportunistic.
    archetype: 'stalker',
    faction: 'neutral',
    hp: 30,
    speed: 4.2,
    weapon: 'knife',
    sightRange: 10,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'predator',
    resist: { poisoned: 0.4, spore: 0 },
  },
  lurker: {
    // Corner ambusher: hides DORMANT against the back wall of a dark room
    // (populate.spawnLurkers picks stockrooms/guardposts/bathrooms) until a
    // body strays close, the room's door opens, or a hit lands — then BURSTS
    // at the intruder, fast and all-in (behaviors 'lurker' pounce). The
    // jump-scare. Fragile on purpose: it wins the ambush or dies in the open.
    archetype: 'lurker',
    faction: 'gang',
    hp: 28,
    speed: 4.6,
    weapon: 'knife',
    sightRange: 8,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'lurker',
    dormant: true,
    wakeOn: ['proximity', 'damage', 'door'],
    resist: { spore: 0, poisoned: 0.5 },
  },
  pod: {
    // #68 Spore pod: a dormant egg-sac — inert until a nearby noise, a body that
    // strays too close, a hit, or FIRE trips it (see `wakeOn` below); then it
    // hatches into a hostile hive thing. A room of these is a stealth set-piece:
    // tiptoe through, or set it off — a stray molotov wakes the whole nest.
    archetype: 'pod',
    faction: 'neutral',
    hp: 26,
    speed: 3.0,
    weapon: 'fists',
    sightRange: 8,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'vermin',
    dormant: true,
    wakeOn: ['noise', 'proximity', 'damage', 'fire'],
    resist: { spore: 0, poisoned: 0.3, burning: 1.4 },
  },

  // ── Tides: the group roster (docs/design/enemy-groups.md) ─────────────────────
  // These are the essence-echoes of the colony's WORK CREWS and its fauna — the
  // swamp redreaming a security detail, a demolition gang, a medic, a pack. They
  // are built to be met TOGETHER: each one is ordinary alone and changes what the
  // group does (systems/groups.ts runs the group layer, behaviors.ts the brains).
  // Numbers are floor-1 baselines; populate.spawnNpc ramps hp +15% per floor.
  drowner: {
    // Raid rank-and-file: a drowned security diver with a harpoon gun. The body
    // of every tide. Deliberately a pistol-grade threat so a raid's danger is
    // its NUMBERS and its orders, not any one member.
    archetype: 'drowner',
    faction: 'gang',
    hp: 38,
    speed: 3.4,
    weapon: 'pistol',
    sightRange: 9,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'raider',
    resist: { poisoned: 0.7, spore: 0.5 },
  },
  bellwether: {
    // The officer. Rings a bell for a head: every raid member within earshot is
    // RALLIED (faster, harder to hurt). Kill it and the raid's nerve breaks —
    // the whole tide routs. The priority target, and tanky enough to be a choice.
    archetype: 'bellwether',
    faction: 'gang',
    hp: 90,
    speed: 3.0,
    weapon: 'pistol',
    sightRange: 10,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'raider',
    resist: { physical: 0.8, burning: 1.2 },
  },
  mender: {
    // The medic. Hangs behind the line and patches whoever is hurt; wounded
    // raiders RETREAT to it to be healed, then go back in. Fragile and unarmed,
    // so the answer is to reach it — or to deny the retreat.
    archetype: 'mender',
    faction: 'gang',
    hp: 44,
    speed: 3.3,
    weapon: 'fists',
    sightRange: 9,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'mender',
    resist: { poisoned: 0.2, spore: 0 },
  },
  breacher: {
    // The sapper. Carries a caged bubble of distilled blast essence and walks
    // the raid THROUGH locked hatches instead of around them — plants a charge,
    // backs off, blows the door. Volatile: fire hurts it more.
    archetype: 'breacher',
    faction: 'gang',
    hp: 62,
    speed: 3.0,
    weapon: 'bat',
    sightRange: 9,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'raider',
    resist: { physical: 0.85, burning: 1.4 },
  },
  lobber: {
    // The siege gun. A living mortar that sets up at range and lobs arcing spore
    // shells OVER walls at wherever its raid last saw you. Slow, keeps its
    // distance, weak up close — the siege is broken by charging the battery.
    archetype: 'lobber',
    faction: 'gang',
    hp: 58,
    speed: 2.4,
    weapon: 'fists',
    sightRange: 11,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'mortar',
    resist: { spore: 0, poisoned: 0.5, burning: 1.3 },
  },
  gloamhound: {
    // Pack fauna. Hounds don't charge — they ENCIRCLE, spreading to a ring around
    // the prey before closing together. Hurt one and the whole pack goes
    // manhunter (and howls up any pack in earshot). Speed sits under the
    // player's 4.5 so a pack is outrun only in a straight line.
    archetype: 'gloamhound',
    faction: 'neutral',
    hp: 32,
    speed: 4.2,
    weapon: 'knife',
    sightRange: 10,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'hound',
    resist: { spore: 0, poisoned: 0.6 },
  },
  hivespire: {
    // Infestation. A rooted spire that buds sporelings at anyone close and, left
    // alone, PLANTS NEW SPIRES nearby — an infestation that spreads until it is
    // burned out. Immobile (speed 0), soaks bullets, burns well.
    archetype: 'hivespire',
    faction: 'neutral',
    hp: 120,
    speed: 0,
    weapon: 'fists',
    sightRange: 9,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'hive',
    resist: { physical: 0.7, burning: 1.6, spore: 0, poisoned: 0 },
  },
}
