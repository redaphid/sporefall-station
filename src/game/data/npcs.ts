import type { Faction } from '../entity'

export interface NpcDef {
  archetype: string
  faction: Faction
  hp: number
  speed: number // tiles/sec
  weapon: string
  sightRange: number
  /** Aggro anyone on sight (thugs) vs only criminals (cops) vs never (civs). */
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
  /** #68 — spawns INERT until a stimulus wakes it (a sleeping pod/unit). */
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
    archetype: 'boss',
    faction: 'gang',
    hp: 80,
    speed: 3.6,
    weapon: 'bat',
    sightRange: 8,
    hostility: 'always',
    fleesOnDamage: false,
    behavior: 'hunter',
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
    // Ash-dweller: fireproof, so a flamethrower/molotov build stalls — shoot it.
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
  pod: {
    // #68 Spore pod: a dormant egg-sac — inert until a nearby noise, a body that
    // strays too close, or a hit trips it; then it hatches into a hostile hive
    // thing. A room of these is a stealth set-piece: tiptoe through, or set it off.
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
}
