// NPC inventory === player inventory. An enemy carries the SAME slotted, moddable
// loadout a player does (entity.ts `Loadout`), so a modded enemy's shots fold its
// mods into the projectile at the ONE shared fire site (combat.fireWeapon) exactly
// like a player's. Adversarial coverage: real mods on a real NPC gun produce modded
// projectiles AND modded behavior; the loadout+mods round-trip byte-for-byte through
// serialize/deserialize; a loadout-less NPC stays innately vanilla (the pre-feature
// default); and deterministic modded-enemy spawns repeat across same-seed worldgens.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { spawnPlayer } from '../player'
import { spawnNpc, npcLoadout, populateWorld } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { fireWeapon } from './combat'
import { projectileSystem } from './projectiles'
import { weaponStack } from './inventory'

/** A gun-carrying NPC whose slotted weapon holds `mods` — the enemy analogue of
 * `armed()` in the player mod tests. */
const moddedNpc = (w: World, x: number, y: number, weapon: string, mods: WeaponMod[]): Entity => {
  const e = addEntity(w, makeEntity('npc', 'gangster', x, y))
  e.health = { hp: 40, max: 40, iframes: 0 }
  e.combat = { weapon, cooldown: 0 }
  e.loadout = npcLoadout(weapon, mods)
  e.facing = 0 // aim east
  return e
}

const bullets = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'projectile' && !e.dead)

describe('NPC loadout: a modded enemy folds its mods into its shots', () => {
  it('an explosive-modded NPC gun spawns a projectile that carries the mod AND the explode behavior', () => {
    const w = createWorld(1, 1)
    const npc = moddedNpc(w, 20, 20, 'pistol', [{ id: 'explosive', stacks: 1 }])
    expect(fireWeapon(w, npc)).toBe(true)
    const [b] = bullets(w)
    // Provenance: the normalized mod list rides the bullet (renderer/wire read it).
    expect(b.projectile!.mods).toEqual([{ id: 'explosive', stacks: 1 }])
    // Behavior: the explosive spec is folded onto the projectile.
    expect(b.projectile!.explode).toBeDefined()
    expect(b.projectile!.explode!.radius).toBeGreaterThan(0)
  })

  it('an explosive NPC bullet actually DETONATES on a body — modded behavior, not just provenance', () => {
    const w = createWorld(1, 1)
    const npc = moddedNpc(w, 20, 20, 'pistol', [{ id: 'explosive', stacks: 1 }])
    // A victim two tiles downrange (east), out of the blast of the muzzle.
    const victim = addEntity(w, makeEntity('npc', 'thug', 22, 20))
    victim.health = { hp: 40, max: 40, iframes: 0 }
    fireWeapon(w, npc)
    for (let t = 0; t < 20 && !w.events.some((e) => e.type === 'explosion'); t++) projectileSystem(w)
    expect(w.events.some((e) => e.type === 'explosion')).toBe(true)
    expect(victim.health!.hp).toBeLessThan(40)
  })

  it('a pierce-modded NPC gun spawns a projectile that carries pierce (mod + pierceLeft)', () => {
    const w = createWorld(1, 1)
    const npc = moddedNpc(w, 20, 20, 'pistol', [{ id: 'pierce', stacks: 1 }])
    fireWeapon(w, npc)
    const [b] = bullets(w)
    expect(b.projectile!.mods).toEqual([{ id: 'pierce', stacks: 1 }])
    expect(b.projectile!.pierceLeft).toBe(1)
  })

  it('a player and an NPC wielding the SAME modded gun spawn byte-identical projectile mods (one model)', () => {
    const w = createWorld(1, 1)
    const mods: WeaponMod[] = [{ id: 'pierce', stacks: 2 }, { id: 'explosive', stacks: 1 }]
    const p = spawnPlayer(w, 0, 20, 20)
    p.combat!.weapon = 'pistol'
    p.loadout = npcLoadout('pistol', mods) // same shared component the NPC uses
    p.facing = 0
    const npc = moddedNpc(w, 40, 20, 'pistol', mods)
    fireWeapon(w, p)
    fireWeapon(w, npc)
    const [pb, nb] = bullets(w)
    expect(nb.projectile!.mods).toEqual(pb.projectile!.mods)
    expect(nb.projectile!.explode).toEqual(pb.projectile!.explode)
    expect(nb.projectile!.pierceLeft).toEqual(pb.projectile!.pierceLeft)
  })
})

describe('NPC loadout: degenerate + round-trip', () => {
  it('a loadout-less NPC fires innately vanilla — no stack, no mods (the pre-feature default)', () => {
    const w = createWorld(1, 1)
    const npc = addEntity(w, makeEntity('npc', 'thug', 20, 20))
    npc.combat = { weapon: 'pistol', cooldown: 0 }
    npc.health = { hp: 40, max: 40, iframes: 0 }
    expect(npc.loadout).toBeUndefined()
    expect(weaponStack(npc)).toBeUndefined()
    expect(fireWeapon(w, npc)).toBe(true)
    const [b] = bullets(w)
    expect(b.projectile!.mods).toBeUndefined()
    expect('mods' in b.projectile!).toBe(false)
  })

  it('an NPC with a fists archetype gets NO loadout (innate) — byte-identical to before', () => {
    const w = createWorld(1, 1)
    const civ = spawnNpc(w, 'civilian', 20, 20) // civilian wields fists
    expect(civ.combat!.weapon).toBe('fists')
    expect(civ.loadout).toBeUndefined()
    const bat = spawnNpc(w, 'thug', 21, 21) // thug wields a bat (durable melee → slotted)
    expect(bat.loadout).toEqual({ inventory: [{ itemId: 'bat', qty: 16 }], activeSlot: 0 })
  })

  it("serialize→deserialize round-trips an NPC's loadout + weapon mods byte-for-byte", () => {
    const w = createWorld(7, 2)
    const npc = moddedNpc(w, 15, 15, 'shotgun', [
      { id: 'pierce', stacks: 2 },
      { id: 'frost', stacks: 1 },
    ])
    const before = serializeWorld(w)
    const w2 = deserializeWorld(before)
    // The whole world (including the NPC loadout+mods) round-trips identically.
    expect(serializeWorld(w2)).toEqual(before)
    // And the restored NPC still resolves the same modded weapon stack.
    const npc2 = w2.byId.get(npc.id)!
    expect(weaponStack(npc2)!.mods).toEqual([
      { id: 'pierce', stacks: 2 },
      { id: 'frost', stacks: 1 },
    ])
  })
})

describe('modded-enemy spawns are deterministic', () => {
  const modSignature = (w: World): string =>
    w.entities
      .filter((e) => e.kind === 'npc' && e.loadout?.inventory[0]?.mods)
      .map((e) => `${e.id}:${e.combat!.weapon}:${JSON.stringify(e.loadout!.inventory[0]!.mods)}`)
      .join('|')

  it('two same-seed worldgens field the SAME modded enemies (mods on the same NPCs)', () => {
    const a = createWorld(12345, 3)
    populateWorld(a)
    const b = createWorld(12345, 3)
    populateWorld(b)
    expect(modSignature(a)).toBe(modSignature(b))
  })

  it('a deeper floor actually fields at least one modded enemy on a representative seed', () => {
    const w = createWorld(4242, 4)
    populateWorld(w)
    const modded = w.entities.filter((e) => e.kind === 'npc' && e.loadout?.inventory[0]?.mods?.length)
    expect(modded.length).toBeGreaterThan(0)
    // Every enemy mod folds onto a RANGED weapon (a projectile is where it reads).
    for (const e of modded) expect(['pistol', 'shotgun', 'machinegun', 'freezeRay', 'flamethrower', 'stunGun']).toContain(e.combat!.weapon)
  })
})
