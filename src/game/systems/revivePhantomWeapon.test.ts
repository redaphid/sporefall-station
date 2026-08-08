// Regression: after a player is DOWNED and REVIVED, weapon-mod pickups silently
// stopped working. `recover()` stripped the inventory to keys and set
// activeSlot=-1 but left `combat.weapon` pointing at the old gun — a PHANTOM
// weapon with no backing slot. `weaponStack` then returned undefined, so
// `applyModPickup` returned null and every mod was left on the ground forever.
//
// Two layers, both exercised here through the REAL systems:
//  1) recover() re-grants the starter loadout, so a revived player wields a
//     real, slotted, moddable gun with combat.weapon consistent (not dangling).
//  2) applyModPickup materializes a moddable-but-unslotted weapon on grab, so a
//     phantom (incl. legacy saves) is healed the first time a mod is picked up.
// Plus a regression guard: a genuine fists player still leaves the mod behind.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer, PLAYER_START_WEAPON } from '../player'
import { emptyInput } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { interactionSystem } from './interaction'
import { applyModPickup, weaponStack } from './inventory'

/** Down a solo player and drive the real interaction system until they
 * self-recover (no rescuer possible → self-revive at the comeback penalty). */
const downAndRevive = (w: World, p: Entity): void => {
  p.health!.hp = 0
  p.playerCtl!.downed = { bleedTicks: 1, reviveProgress: 0 }
  p.prevPos.x = p.pos.x
  p.prevPos.y = p.pos.y
  const ids = new Map([[p.playerCtl!.playerId, emptyInput()]])
  for (let i = 0; i < 5 && p.playerCtl!.downed; i++) interactionSystem(w, ids)
}

/** Drop a mod pickup on top of `at` so auto-pickup fires next tick. */
const dropMod = (w: World, modId: string, at: Entity): Entity => {
  const e = makeEntity('pickup', `mod.${modId}`, at.pos.x, at.pos.y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  return addEntity(w, e)
}

const modIds = (e: Entity): string[] => (weaponStack(e)?.mods ?? []).map((m) => m.id)

describe('revive leaves the player with a real, slotted, moddable weapon', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1) // normal mode
  })

  it('normal revive: the phantom weapon is gone — weaponStack is defined and combat.weapon matches its slot', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    // Simulate a player who had swapped to a found gun before going down.
    p.loadout!.inventory = [{ itemId: 'shotgun', qty: 6 }]
    p.loadout!.activeSlot = 0
    p.combat!.weapon = 'shotgun'

    downAndRevive(w, p)

    expect(p.playerCtl!.downed).toBeUndefined()
    const stack = weaponStack(p)
    expect(stack).toBeDefined() // NOT a phantom — the weapon is really slotted
    expect(stack!.itemId).toBe(PLAYER_START_WEAPON)
    expect(p.combat!.weapon).toBe(stack!.itemId) // combat.weapon is consistent
    expect(p.loadout!.activeSlot).toBe(-1) // the weapon is not a hotbar selection
    // Starter pistol comes back fully loaded (moddable slot, carries mods).
    expect(p.loadout!.inventory).toEqual([{ itemId: 'pistol', qty: 1 }])
  })

  it('normal revive KEEPS key items and re-slots the starter ahead of them', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.loadout!.inventory = [{ itemId: 'shotgun', qty: 6 }, { itemId: 'keycard.red', qty: 1 }]
    p.loadout!.activeSlot = 0
    p.combat!.weapon = 'shotgun'

    downAndRevive(w, p)

    expect(p.loadout!.inventory).toEqual([
      { itemId: 'pistol', qty: 1 },
      { itemId: 'keycard.red', qty: 1 },
    ])
    expect(weaponStack(p)!.itemId).toBe('pistol') // activeSlot 0 still resolves the gun
    expect(p.combat!.weapon).toBe('pistol')
  })

  it('a REVIVED player who walks over a mod pickup actually receives the mod', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.loadout!.inventory = [{ itemId: 'shotgun', qty: 6 }]
    p.loadout!.activeSlot = 0
    p.combat!.weapon = 'shotgun'
    downAndRevive(w, p)

    const pick = dropMod(w, 'frost', p)
    tickWorld(w, new Map([[0, emptyInput()]]))

    expect(modIds(p)).toEqual(['frost']) // mod landed on the (re-slotted) gun
    expect(w.byId.get(pick.id)).toBeUndefined() // pickup consumed
    const ev = w.events.find((e) => e.type === 'modPickup')
    expect(ev).toMatchObject({ type: 'modPickup', byId: p.id, modId: 'frost' })
  })

  it('casual revive: no strip, and the held weapon stays consistent (no phantom introduced)', () => {
    const cw = createWorld(1, 1, 'casual')
    const p = spawnPlayer(cw, 0, 20, 20)
    p.loadout!.inventory = [{ itemId: 'shotgun', qty: 6 }]
    p.loadout!.activeSlot = 0
    p.combat!.weapon = 'shotgun'

    downAndRevive(cw, p)

    // Casual keeps everything; the weapon is still really slotted (not a phantom).
    expect(p.loadout!.inventory).toEqual([{ itemId: 'shotgun', qty: 6 }])
    expect(weaponStack(p)!.itemId).toBe('shotgun')
    // And a mod still applies after a casual revive.
    dropMod(cw, 'homing', p)
    tickWorld(cw, new Map([[0, emptyInput()]]))
    expect(modIds(p)).toEqual(['homing'])
  })
})

describe('applyModPickup — phantom-weapon materialization (defense in depth)', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  const bareEntity = (): Entity => {
    const e = addEntity(w, makeEntity('player', 'player', 20, 20))
    e.health = { hp: 100, max: 100, iframes: 0 }
    e.combat = { weapon: 'fists', cooldown: 0 }
    e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
    e.playerCtl = { playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0 }
    e.loadout = { inventory: [], activeSlot: -1 }
    return e
  }

  it('a phantom RANGED weapon (combat.weapon set, empty inventory) is slotted + equipped, then modded', () => {
    const p = bareEntity()
    p.combat!.weapon = 'machinegun' // legacy-save phantom: named but unslotted
    const res = applyModPickup(p, 'bounce')
    expect(res).toMatchObject({ modId: 'bounce', weapon: 'machinegun' })
    const stack = weaponStack(p)
    expect(stack).toBeDefined()
    expect(stack!.itemId).toBe('machinegun')
    expect(stack!.qty).toBe(1) // guns carry no ammo, so a flat count of 1
    expect(p.combat!.weapon).toBe('machinegun')
    expect(stack!.mods).toEqual([{ id: 'bounce', stacks: 1 }])
  })

  it('a phantom MELEE weapon materializes with full durability', () => {
    const p = bareEntity()
    p.combat!.weapon = 'bat'
    const res = applyModPickup(p, 'overload')
    expect(res).toMatchObject({ modId: 'overload', weapon: 'bat' })
    const stack = weaponStack(p)!
    expect(stack.itemId).toBe('bat')
    expect(stack.qty).toBe(16) // bat durability
    expect(stack.mods).toEqual([{ id: 'overload', stacks: 1 }])
  })

  it('REGRESSION GUARD: a genuine fists player leaves the mod on the ground — no crash, no phantom slot', () => {
    const p = bareEntity() // combat.weapon === 'fists', empty inventory
    const res = applyModPickup(p, 'frost')
    expect(res).toBeNull()
    expect(weaponStack(p)).toBeUndefined()
    expect(p.loadout!.inventory).toHaveLength(0) // nothing materialized
    expect(p.loadout!.activeSlot).toBe(-1)
  })

  it('REGRESSION GUARD: an unknown weapon id is not materialized', () => {
    const p = bareEntity()
    p.combat!.weapon = 'not_a_real_weapon'
    const res = applyModPickup(p, 'frost')
    expect(res).toBeNull()
    expect(p.loadout!.inventory).toHaveLength(0)
  })

  it('a full inventory cannot be over-stuffed by materialization (leaves the mod on the ground)', () => {
    const p = bareEntity()
    p.combat!.weapon = 'pistol'
    p.loadout!.inventory = Array.from({ length: 6 }, () => ({ itemId: 'bandage', qty: 1 }))
    const res = applyModPickup(p, 'frost')
    expect(res).toBeNull()
    expect(p.loadout!.inventory).toHaveLength(6) // MAX_SLOTS respected
  })
})
