// THE GUARD FOR THE CLASS OF BUG, not just the one instance of it.
//
// §4.1 The Vigil shipped UNWINNABLE, and a full green suite said otherwise. The
// reason was not the boss's tuning: it was that `scenarios.ts` hand-assigned a
// KNIFE into the player's `loadout`, and every test then ran against a world the
// game itself cannot build.
//
// A player carries exactly ONE permanent weapon and there is no reachable input
// sequence that changes it:
//   - `PLAYER_START_WEAPON` is a pistol, given by `starterLoadout` in spawnPlayer;
//   - `interaction.ts` refuses every melee/ranged pickup at the door ("a weapon
//     can never enter their inventory");
//   - `wearMelee` returns early for a player, so it never breaks;
//   - a gun never runs dry ("a gun always fires");
//   - `InputCmd` has no drop or holster field, so a player cannot elect to be
//     unarmed either.
// So a scenario that writes a second weapon into a player's loadout is not
// staging a hard case — it is staging an IMPOSSIBLE one, and anything asserted
// on top of it is unfalsifiable.
//
// This file fails the moment a scenario hands a player a weapon the one-weapon
// rule would have refused.

import { describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { createScriptedInput } from '../input/scripted'
import { itemClass } from './data/items'
import type { Entity } from './entity'
import { PLAYER_START_WEAPON, starterLoadout } from './player'
import { applyScenario } from './scenarios'

/** Every name `applyScenario` dispatches on. Listed rather than derived because
 * the dispatch is a chain of `if (name === …)` — if you add a scenario and it is
 * missing here, that is the reminder to add it. */
const SCENARIOS = [
  'artcompare', 'npc-combat', 'objects', 'fire', 'frost', 'wet-electric', 'inventory', 'items',
  'relationships', 'showcase', 'demo', 'doors', 'shooting', 'mission', 'ai-goals', 'npc-ai',
  'npc-deliberate', 'vigil', 'echo-adapt', 'sealkeeper',
]

/**
 * Showcase stages that PREDATE the one-weapon rule and still hand out a loadout
 * a player could never assemble. They are inventory/art demos rather than
 * claims about a fight, so they are recorded here instead of being rewritten —
 * but they are recorded EXACTLY, and the test below fails if one of them stops
 * offending. Fix a stage, delete its line; the list can only ever shrink.
 *
 * `vigil` is deliberately NOT here. It used to be the worst of them.
 */
const KNOWN_LIARS = ['artcompare', 'inventory', 'items']

const stage = (name: string): Entity[] => {
  const s = new HostSession(7, createScriptedInput([]))
  applyScenario(s.world, name)
  return s.world.entities.filter((e) => !!e.playerCtl)
}

/** Weapon-class stacks in a player's inventory that are not the one weapon they
 * are allowed to have. `interaction.addToInventory` refuses exactly this set. */
const contraband = (p: Entity): string[] =>
  (p.loadout?.inventory ?? [])
    .map((s) => s.itemId)
    .filter((id) => {
      const c = itemClass(id)
      return (c === 'melee' || c === 'ranged') && id !== PLAYER_START_WEAPON
    })

describe('no scenario may arm a player with a weapon the game would refuse', () => {
  it.each(SCENARIOS.filter((n) => !KNOWN_LIARS.includes(n)))(
    '`%s` stages a player carrying only what they can actually hold',
    (name) => {
      for (const p of stage(name)) {
        expect(contraband(p)).toEqual([])
        // The swung weapon must also BE the starter: writing `combat.weapon`
        // without an inventory stack is the other half of the same lie.
        expect(p.combat!.weapon).toBe(PLAYER_START_WEAPON)
      }
    },
  )

  it.each(KNOWN_LIARS)('`%s` is a KNOWN liar — when you fix it, delete it from KNOWN_LIARS', (name) => {
    // Pinned in the positive direction on purpose: an allow-list nobody prunes
    // rots into a permanent exemption. This fails when the debt is paid.
    const offences = stage(name).flatMap(contraband)
    expect(offences.length).toBeGreaterThan(0)
  })

  it('the `vigil` scenario arms its player through starterLoadout, byte for byte', () => {
    // The specific regression. Compared against the constructor's own output, so
    // "I typed the same thing by hand" cannot pass: the point is that the
    // scenario calls the game's code rather than reproducing its result.
    const [p] = stage('vigil')
    expect(p.loadout).toEqual(starterLoadout(PLAYER_START_WEAPON))
    expect(p.combat!.weapon).toBe(PLAYER_START_WEAPON)
  })
})
