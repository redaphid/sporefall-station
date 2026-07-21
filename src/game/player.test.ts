// The starter weapon must be a REAL slotted ItemStack — not a bare
// `combat.weapon` string with an empty inventory — so it holds ammo and can
// receive weapon-mods exactly like any picked-up weapon (playtest bug #1: "walk
// over a diamond, nothing happens"). Strict + adversarial via the real systems.

import { describe, expect, it } from 'vitest'
import { PLAYER_HP, PLAYER_MELEE_MULT, PLAYER_SPEED, spawnPlayer } from './player'
import { makeEntity, SPAWN_GRACE_TICKS, type Entity } from './entity'
import { addEntity, createWorld, tickWorld, type World } from './world'
import { emptyInput, type InputCmd } from './types'
import { serializeWorld, deserializeWorld } from './serialize'
import { weaponStack, spendAmmo } from './systems/inventory'
import { resolveWeapon } from './systems/resolveWeapon'
import { fireWeapon } from './systems/combat'
import { spawnNpc } from './populate'
import { WEAPONS } from './data/items'

const STARTER_AMMO = 200

const step = (w: World): void => tickWorld(w, new Map([[0, emptyInput()]]))
const tickN = (w: World, inputs: Map<number, InputCmd>, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, inputs)
}

const dropMod = (w: World, modId: string, at: Entity): Entity => {
  const e = makeEntity('pickup', `mod.${modId}`, at.pos.x, at.pos.y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  return addEntity(w, e)
}

describe('spawnPlayer — the starter weapon is a proper slotted ItemStack', () => {
  it('a ranged starter (pistol) is slotted, equipped, and loaded with 40 bullets', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    expect(p.combat!.weapon).toBe('pistol')
    expect(p.loadout!.activeSlot).toBe(0)
    expect(p.loadout!.inventory).toEqual([{ itemId: 'pistol', qty: STARTER_AMMO }])
    // The mod list resolves through the SAME weaponStack path the fire site uses.
    expect(weaponStack(p)?.itemId).toBe('pistol')
  })

  it('every player spawns with the same defaults: hp, speed, pistol, ready special', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    // Fresh spawns carry spawn-grace iframes (see SPAWN_GRACE_TICKS) so a
    // hostile parked on the spawn tile can't delete them before input matters.
    expect(p.health).toEqual({ hp: PLAYER_HP, max: PLAYER_HP, iframes: SPAWN_GRACE_TICKS })
    expect(p.speed).toBe(PLAYER_SPEED)
    expect(p.combat!.weapon).toBe('pistol')
    expect(p.playerCtl!.abilityCooldown).toBe(0)
  })
})

describe('the player special — a lobbed grenade', () => {
  it('special input throws a grenade that explodes and damages a group', () => {
    const w = createWorld(20, 1)
    const p = spawnPlayer(w, 0, 10.5, 1.5)
    p.facing = 0
    const a = spawnNpc(w, 'thug', 14.5, 1.5)
    const b = spawnNpc(w, 'thug', 15.2, 1.5)
    tickWorld(w, new Map([[0, { ...emptyInput(), special: true }]]))
    expect(p.playerCtl!.abilityCooldown).toBeGreaterThan(0) // fired → on cooldown
    tickN(w, new Map([[0, emptyInput()]]), 40) // fuse burns, boom
    expect(a.health!.hp).toBeLessThan(a.health!.max)
    expect(b.health!.hp).toBeLessThan(b.health!.max)
  })
})

describe('the player melee multiplier', () => {
  it('a player swings a melee weapon harder than an NPC with the same weapon', () => {
    const w = createWorld(3, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    p.loadout!.inventory = [{ itemId: 'bat', qty: 100 }]
    p.loadout!.activeSlot = 0
    p.combat = { weapon: 'bat', cooldown: 0 }
    p.facing = 0
    const victim = spawnNpc(w, 'thug', 20.9, 20)
    const before = victim.health!.hp
    expect(fireWeapon(w, p)).toBe(true)
    expect(before - victim.health!.hp).toBe(Math.round(WEAPONS.bat.damage * PLAYER_MELEE_MULT))
  })
})

describe('spawnPlayer — the starter gun holds mods (the #1 fix)', () => {
  it('a REAL default player walks over a frost gem → gun is modded + effect resolves', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    const gem = dropMod(w, 'frost', p)
    step(w)
    // Gem consumed & swept.
    expect(w.byId.get(gem.id)).toBeUndefined()
    // Frost now rides the equipped pistol's ItemStack.
    expect(weaponStack(p)?.mods).toEqual([{ id: 'frost', stacks: 1 }])
    // resolveWeapon reflects it: the shot now freezes on hit.
    const rw = resolveWeapon(WEAPONS[p.combat!.weapon], weaponStack(p)?.mods)
    expect(rw.onHit).toEqual({ status: 'frozen', ticks: 120 })
    // Feedback event fired for the grabber.
    expect(w.events.find((e) => e.type === 'modPickup')).toMatchObject({
      type: 'modPickup', byId: p.id, modId: 'frost', weapon: 'pistol', maxed: false,
    })
  })
})

describe('spawnPlayer — the starter pistol has finite (200-round) ammo', () => {
  it('spendAmmo decrements and empties after exactly 200 shots', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    for (let i = 0; i < STARTER_AMMO; i++) expect(spendAmmo(p)).toBe(true)
    // 41st pull: empty gun clicks — no shot.
    expect(spendAmmo(p)).toBe(false)
    expect(weaponStack(p)?.qty).toBe(0)
  })
})

describe('spawnPlayer — the slotted modded starter round-trips byte-for-byte', () => {
  it('serialize(deserialize(json)) === json after modding the starter', () => {
    const w = createWorld(5, 2)
    const p = spawnPlayer(w, 0, 20, 20)
    dropMod(w, 'lifesteal', p)
    step(w)
    const json = serializeWorld(w)
    expect(serializeWorld(deserializeWorld(json))).toEqual(json)
    const restored = deserializeWorld(json)
    const rp = restored.entities.find((e) => e.playerCtl)!
    expect(weaponStack(rp)?.mods).toEqual([{ id: 'lifesteal', stacks: 1 }])
    expect(weaponStack(rp)?.qty).toBe(STARTER_AMMO)
  })
})
