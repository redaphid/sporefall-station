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
  civilian: {
    archetype: 'civilian',
    faction: 'civ',
    hp: 25,
    speed: 3.2,
    weapon: 'fists',
    sightRange: 6,
    hostility: 'never',
    fleesOnDamage: true,
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
}
