// ONE PERMANENT WEAPON: corpses do not drop weapons, and a weapon can never
// enter a player's inventory.
//
// This file used to specify the opposite — `feat/enemy-weapon-drops`, where a
// dying NPC rolled `w.rng` at the single kill site and occasionally left its gun
// on the floor. The player now carries exactly one weapon for the whole run and
// cannot pick another up, so a dropped gun would be a sparkle they walk over
// forever. The suite is kept (not deleted) and inverted, because two of its
// protections still matter and are now STRONGER than before:
//
//   * DETERMINISM — `kill` must not draw from the shared world RNG at all. The
//     old suite only asserted this for unarmed NPCs; it now holds for every
//     death, so no kill can ever perturb a later roll.
//   * NOTHING SPAWNS — no pickup, no `weaponDrop` event, from any death path
//     (player swing, environment damage, boss with `natural` claws).
//
// Plus the new rule itself: the pickup/`collect` path REFUSES weapons, so even a
// weapon entity conjured onto a player's tile stays on the ground.

import { describe, expect, it } from 'vitest'
import { kill, applyDamage } from './combat'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { runTicks } from '../testkit'
import { serializeWorld, deserializeWorld } from '../serialize'
import { PLAYER_START_WEAPON, starterLoadout } from '../player'

/** An armed NPC placed at (x,y) carrying `weapon` — no populate machinery, so
 * building it draws nothing from `w.rng` and any drop roll would be the first draw. */
const armedNpc = (w: World, weapon: string, x = 5.5, y = 5.5): Entity => {
  const e = addEntity(w, makeEntity('npc', 'thug', x, y))
  e.health = { hp: 10, max: 10, iframes: 0 }
  e.combat = { weapon, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

/** A player with the real permanent starter loadout. */
const player = (w: World, x = 5.5, y = 5.5, playerId = 0): Entity => {
  const e = addEntity(w, makeEntity('player', 'player', x, y))
  e.health = { hp: 100, max: 100, iframes: 0 }
  e.combat = { weapon: PLAYER_START_WEAPON, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.playerCtl = { playerId, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
  e.loadout = starterLoadout(PLAYER_START_WEAPON)
  return e
}

const drops = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'pickup' && !e.dead)

/** Drop a world weapon pickup at (x,y) by hand — nothing in the game spawns one
 * any more, so this fabricates the entity the `collect` path must refuse. */
const weaponPickup = (w: World, itemId: string, x: number, y: number): Entity => {
  const e = addEntity(w, makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3))
  e.pickup = { itemId, qty: 1 }
  return e
}

/** The weapons a corpse used to be able to leave behind — melee, guns, element
 * guns, and the boss's `natural` claws (which once rendered as a fake medkit). */
const CARRIED = ['pistol', 'bat', 'knife', 'shotgun', 'machinegun', 'sledgehammer', 'freezeRay', 'claws']

describe('one permanent weapon — a corpse drops NOTHING', () => {
  it.each(CARRIED)('killing an NPC carrying %s spawns no pickup and emits no weaponDrop event', (weapon) => {
    const w = createWorld(1, 1)
    const npc = armedNpc(w, weapon, 7.5, 9.5)
    kill(w, npc)

    expect(npc.dead).toBe(true)
    expect(drops(w)).toHaveLength(0)
    expect(w.events.some((e) => e.type === 'weaponDrop')).toBe(false)
  })

  it('an ENVIRONMENT kill (applyDamage, no player swing) drops nothing either', () => {
    const w = createWorld(1, 1)
    const npc = armedNpc(w, 'pistol')
    applyDamage(w, npc, 999, npc.pos.x + 1, npc.pos.y, 0, 999) // attackerId that isn't a player
    expect(npc.dead).toBe(true)
    expect(drops(w)).toHaveLength(0)
  })

  it('no seed drops anything — there is no roll left to get lucky on', () => {
    // The old behaviour fired at p=0.25, so over 400 seeds a surviving roll would
    // be overwhelmingly likely to show itself here.
    for (let seed = 1; seed <= 400; seed++) {
      const w = createWorld(seed, 1)
      kill(w, armedNpc(w, 'pistol'))
      expect(drops(w), `seed ${seed} spawned a drop`).toHaveLength(0)
    }
  })
})

describe('one permanent weapon — killing never touches the shared RNG stream', () => {
  it.each(CARRIED)('a death with %s leaves w.rng byte-for-byte where it started', (weapon) => {
    const w = createWorld(99, 1)
    const before = w.rng.state()
    kill(w, armedNpc(w, weapon))
    // No roll is drawn at the kill site any more, so a death can never perturb a
    // later seeded decision (loot placement, spawn dice, an NPC's think jitter).
    expect(w.rng.state()).toBe(before)
  })

  it('a long batch of deaths still leaves the stream untouched', () => {
    const w = createWorld(1234, 1)
    const before = w.rng.state()
    for (let i = 0; i < 200; i++) kill(w, armedNpc(w, 'pistol', 3.5 + (i % 10), 4.5))
    expect(drops(w)).toHaveLength(0)
    expect(w.rng.state()).toBe(before)
  })
})

describe('one permanent weapon — a weapon on the floor can never be picked up', () => {
  it('a player standing on a weapon pickup does NOT collect it and keeps their own weapon', () => {
    const w = createWorld(1, 1)
    const p = player(w, 12.5, 12.5)
    const pk = weaponPickup(w, 'shotgun', 12.5, 12.5)

    runTicks(w, new Map([[0, {}]]), 1) // interactionSystem.autoPickup runs

    expect(p.combat!.weapon).toBe(PLAYER_START_WEAPON) // never swapped
    expect(p.loadout!.inventory.some((s) => s.itemId === 'shotgun')).toBe(false)
    // Refused, not silently eaten: it is still lying there.
    expect(pk.dead).toBeFalsy()
    expect(drops(w)).toHaveLength(1)
    expect(w.events.some((e) => e.type === 'pickup')).toBe(false)
  })

  it.each(['bat', 'knife', 'machinegun', 'freezeRay', 'sledgehammer'])(
    'a %s on the floor is refused the same way',
    (itemId) => {
      const w = createWorld(1, 1)
      const p = player(w, 12.5, 12.5)
      weaponPickup(w, itemId, 12.5, 12.5)
      runTicks(w, new Map([[0, {}]]), 1)
      expect(p.loadout!.inventory.some((s) => s.itemId === itemId)).toBe(false)
      expect(p.combat!.weapon).toBe(PLAYER_START_WEAPON)
    },
  )

  it('a player still holds exactly ONE weapon slot after walking over a pile of guns', () => {
    const w = createWorld(1, 1)
    const p = player(w, 12.5, 12.5)
    for (const id of ['pistol', 'shotgun', 'machinegun', 'bat']) weaponPickup(w, id, 12.5, 12.5)
    runTicks(w, new Map([[0, {}]]), 3)
    const weaponSlots = p.loadout!.inventory.filter((s) => s.itemId === PLAYER_START_WEAPON)
    expect(weaponSlots).toHaveLength(1)
    expect(p.loadout!.inventory).toHaveLength(1)
  })

  it('a NON-weapon pickup on the same tile is still collected normally', () => {
    // The refusal must be surgical: throwables still work, so the floor still
    // rewards exploration.
    const w = createWorld(1, 1)
    const p = player(w, 12.5, 12.5)
    const grenade = addEntity(w, makeEntity('pickup', 'pickup.grenade', 12.5, 12.5, 0.3))
    grenade.pickup = { itemId: 'grenade', qty: 2 }
    weaponPickup(w, 'shotgun', 12.5, 12.5)

    runTicks(w, new Map([[0, {}]]), 1)

    expect(p.loadout!.inventory.find((s) => s.itemId === 'grenade')?.qty).toBe(2)
    expect(grenade.dead).toBe(true)
    expect(p.loadout!.inventory.some((s) => s.itemId === 'shotgun')).toBe(false)
  })
})

describe('one permanent weapon — determinism', () => {
  it('two identical worlds killing the same NPC reach a byte-identical state', () => {
    const build = (): World => {
      const w = createWorld(4242, 3)
      kill(w, armedNpc(w, 'machinegun', 8.5, 8.5))
      return w
    }
    expect(serializeWorld(build())).toEqual(serializeWorld(build()))
  })

  it('the post-kill world round-trips through serialize byte-for-byte', () => {
    const w = createWorld(4242, 2)
    kill(w, armedNpc(w, 'pistol'))
    const json = serializeWorld(w)
    expect(serializeWorld(deserializeWorld(json))).toEqual(json)
  })
})
