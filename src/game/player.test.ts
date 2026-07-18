// The class starter weapon must be a REAL slotted ItemStack — not a bare
// `combat.weapon` string with an empty inventory — so it holds ammo and can
// receive weapon-mods exactly like any picked-up weapon (playtest bug #1: "walk
// over a diamond, nothing happens"). Strict + adversarial via the real systems.

import { describe, expect, it } from 'vitest'
import { spawnPlayer } from './player'
import { makeEntity, type Entity } from './entity'
import { addEntity, createWorld, tickWorld, type World } from './world'
import { emptyInput } from './types'
import { serializeWorld, deserializeWorld } from './serialize'
import { weaponStack, spendAmmo } from './systems/inventory'
import { resolveWeapon } from './systems/resolveWeapon'
import { WEAPONS } from './data/items'

const STARTER_AMMO = 200

const step = (w: World): void => tickWorld(w, new Map([[0, emptyInput()]]))

const dropMod = (w: World, modId: string, at: Entity): Entity => {
  const e = makeEntity('pickup', `mod.${modId}`, at.pos.x, at.pos.y, 0.3)
  e.pickup = { itemId: modId, qty: 1 }
  return addEntity(w, e)
}

describe('spawnPlayer — the starter weapon is a proper slotted ItemStack', () => {
  it('a ranged starter (pistol) is slotted, equipped, and loaded with 40 bullets', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    expect(p.combat!.weapon).toBe('pistol')
    expect(p.playerCtl!.activeSlot).toBe(0)
    expect(p.playerCtl!.inventory).toEqual([{ itemId: 'pistol', qty: STARTER_AMMO }])
    // The mod list resolves through the SAME weaponStack path the fire site uses.
    expect(weaponStack(p)?.itemId).toBe('pistol')
  })

  it('an unknown/removed classId falls back to the soldier starter (pistol, slotted, loaded)', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'thief', 20, 20) // removed class → soldier
    expect(p.playerCtl!.classId).toBe('soldier')
    expect(p.combat!.weapon).toBe('pistol')
    expect(p.playerCtl!.activeSlot).toBe(0)
    expect(p.playerCtl!.inventory).toEqual([{ itemId: 'pistol', qty: STARTER_AMMO }])
    expect(weaponStack(p)?.itemId).toBe('pistol')
  })
})

describe('spawnPlayer — the starter gun holds mods (the #1 fix)', () => {
  it('a REAL default player walks over a frost gem → gun is modded + effect resolves', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
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
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
    for (let i = 0; i < STARTER_AMMO; i++) expect(spendAmmo(p)).toBe(true)
    // 41st pull: empty gun clicks — no shot.
    expect(spendAmmo(p)).toBe(false)
    expect(weaponStack(p)?.qty).toBe(0)
  })
})

describe('spawnPlayer — the slotted modded starter round-trips byte-for-byte', () => {
  it('serialize(deserialize(json)) === json after modding the starter', () => {
    const w = createWorld(5, 2)
    const p = spawnPlayer(w, 0, 'soldier', 20, 20)
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
