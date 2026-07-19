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
  },
}
