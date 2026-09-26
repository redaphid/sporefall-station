// Player TRAITS: the floor draft's second dimension. A mod changes the gun; a
// trait changes the body holding it. Pure data, with the same shape discipline
// as MODS: each effect is a hook field that one existing system reads at its
// own choke point (named on the field), so adding a trait is a registry entry,
// never a new branch in a system. A player carries picked traits on
// `playerCtl.traits` (systems/traits.ts reads them).
//
// Every trait is a VERB a 10-year-old can read in one line. None is "+10% HP".
// Each changes what the player does, and none needs a feature that is not on
// main: Rubber Boots (bog water slows and wets nobody yet) and Pack Mule (no
// throwable cap, no prize slowdown to lift) were cut for that reason.

import type { ModRarity } from './mods'

export interface TraitDef {
  id: string
  name: string
  /** The one line on the draft card and the pause panel. */
  blurb: string
  icon: string
  rarity: ModRarity
  /** How many times the same trait can be taken. Usually 1. */
  maxStacks: number
  /** Only does anything with a teammate in the run; reads inert when solo. */
  coop?: true
  /** Statuses that never land on this player (statusFx.addStatus/applyStatus). */
  immune?: readonly string[]
  /** Multiplier on knockback this player takes (combat.applyDamage). */
  knockback?: number
  /** Multiplier on this player's roll burst, so on its distance (movement). */
  roll?: number
  /** Multiplier, per stack, on how far this player's gunshots carry
   * (alarm.hearGunfire: alarm witnesses, investigators, sleepers). */
  shotNoise?: number
  /** This player's own blasts skip them (combat.detonate, itemEffects). */
  ownBlastProof?: true
  /** A melee blow that lands on this player puts this status on the attacker
   * (combat.meleeAttack). */
  meleeRetort?: { status: string; ticks: number }
  /** Reviving a downed teammate: progress per tick and a reach multiplier
   * (interaction.bleedAndRevive). */
  revive?: { rate: number; reach: number }
  /** Multiplier on how much an enemy that sees this player wants to fight them
   * rather than anyone else it sees (behaviors threat scan). */
  taunt?: number
  /** What this player's own screen shows that others' do not (render only). */
  sees?: 'affinities'
}

export const TRAITS: Record<string, TraitDef> = {
  scoutEye: {
    id: 'scoutEye', name: 'Scout Eye', icon: '👁️', rarity: 'common', maxStacks: 1,
    blurb: 'See what hurts each enemy, right over its head.',
    sees: 'affinities',
  },
  softSteps: {
    id: 'softSteps', name: 'Soft Steps', icon: '🐾', rarity: 'common', maxStacks: 2,
    blurb: 'Enemies hear your shots from half as far.',
    shotNoise: 0.5,
  },
  staticSkin: {
    id: 'staticSkin', name: 'Static Skin', icon: '🦔', rarity: 'rare', maxStacks: 1,
    blurb: 'Anything that hits you up close gets zapped.',
    meleeRetort: { status: 'electrified', ticks: 30 },
  },
  anchor: {
    id: 'anchor', name: 'Anchor', icon: '⚓', rarity: 'common', maxStacks: 1,
    blurb: "Hits can't knock you around, but your roll is short.",
    knockback: 0,
    immune: ['stun'],
    roll: 0.5,
  },
  fireproof: {
    id: 'fireproof', name: 'Fireproof', icon: '🧯', rarity: 'common', maxStacks: 1,
    blurb: "Fire can't catch on you.",
    immune: ['burning'],
  },
  blastproof: {
    id: 'blastproof', name: 'Blastproof', icon: '🛡️', rarity: 'rare', maxStacks: 1,
    blurb: "Your own explosions can't hurt you.",
    ownBlastProof: true,
  },
  medicHands: {
    id: 'medicHands', name: 'Medic Hands', icon: '⛑️', rarity: 'common', maxStacks: 1, coop: true,
    blurb: 'Pick up a downed friend twice as fast, from twice as far.',
    revive: { rate: 2, reach: 2 },
  },
  taunt: {
    id: 'taunt', name: 'Taunt', icon: '😝', rarity: 'rare', maxStacks: 1, coop: true,
    blurb: 'Enemies that see you pick you over your friends.',
    taunt: 3,
  },
}
