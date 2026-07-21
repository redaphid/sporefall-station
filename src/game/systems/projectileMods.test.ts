// Bullet mod PROVENANCE — the sim-side substrate under the procedural bullet
// visuals. A modded gun's shots carry a normalized `projectile.mods` list
// (renderer + wire read it); vanilla shots carry NOTHING, so pre-feature
// snapshots/fixtures still serialize byte-for-byte. Runs the REAL fire path.

import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeMods } from '../data/mods'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { emptyInput } from '../types'
import { addEntity, createWorld, type World } from '../world'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { combatSystem, fireWeapon } from './combat'
import { projectileSystem } from './projectiles'
import { equipSlot } from './inventory'

const armed = (w: World, x: number, y: number, weaponId: string, mods?: WeaponMod[]): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.loadout!.inventory = [{ itemId: weaponId, qty: 99, ...(mods ? { mods } : {}) }]
  equipSlot(p, 0)
  p.facing = 0
  return p
}

const fire = (w: World, p: Entity): void => {
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[p.playerCtl!.playerId, { ...emptyInput(), attack: true }]]))
}

const bullets = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'projectile' && !e.dead)

describe('projectile mod provenance', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a vanilla shot carries NO mods field (snapshot-stable)', () => {
    const p = armed(w, 20, 20, 'pistol')
    fire(w, p)
    const [b] = bullets(w)
    expect(b.projectile!.mods).toBeUndefined()
    expect('mods' in b.projectile!).toBe(false)
  })

  it('an NPC shot carries no mods (enemy fire stays visually vanilla)', () => {
    const npc = addEntity(w, makeEntity('npc', 'thug', 20, 20))
    npc.combat = { weapon: 'pistol', cooldown: 0 }
    npc.health = { hp: 40, max: 40, iframes: 0 }
    // NPCs route through the same fire site with no inventory stack.
    expect(fireWeapon(w, npc)).toBe(true)
    const [b] = bullets(w)
    expect(b.projectile!.mods).toBeUndefined()
  })

  it('a modded shot carries the normalized (sorted, capped) mod list', () => {
    const p = armed(w, 20, 20, 'pistol', [
      { id: 'pierce', stacks: 2 },
      { id: 'frost', stacks: 99 }, // frost caps at 1
      { id: 'bogus', stacks: 3 }, // unknown → dropped
      { id: 'overload', stacks: 1 },
    ])
    fire(w, p)
    const [b] = bullets(w)
    expect(b.projectile!.mods).toEqual([
      { id: 'frost', stacks: 1 },
      { id: 'overload', stacks: 1 },
      { id: 'pierce', stacks: 2 },
    ])
  })

  it('every pellet of a multi-shot spread carries the same provenance', () => {
    const p = armed(w, 20, 20, 'shotgun', [{ id: 'bulk', stacks: 1 }, { id: 'bounce', stacks: 1 }])
    fire(w, p)
    const shots = bullets(w)
    expect(shots.length).toBeGreaterThan(2)
    for (const b of shots) {
      expect(b.projectile!.mods).toEqual([
        { id: 'bounce', stacks: 1 },
        { id: 'bulk', stacks: 1 },
      ])
    }
  })

  it('split shards inherit the parent build (deep-copied, not shared)', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'split', stacks: 1 }])
    // hp 1: the parent's hit kills the victim, so the shards it bursts into
    // fly FREE instead of dying against the same body on their spawn tick.
    const victim = addEntity(w, makeEntity('npc', 'civilian', 22, 20))
    victim.health = { hp: 1, max: 40, iframes: 0 }
    fire(w, p)
    const [parent] = bullets(w)
    const parentMods = parent.projectile!.mods!
    for (let i = 0; i < 30 && bullets(w).some((b) => b.projectile!.split); i++) {
      projectileSystem(w)
      w.tick++
    }
    const shards = bullets(w)
    expect(shards.length).toBeGreaterThan(0)
    for (const s of shards) {
      expect(s.projectile!.mods).toEqual(parentMods)
      expect(s.projectile!.mods).not.toBe(parentMods) // no aliasing across entities
    }
  })

  it('provenance round-trips losslessly through world serialization', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'homing', stacks: 2 }, { id: 'lifesteal', stacks: 1 }])
    fire(w, p)
    const json = serializeWorld(w)
    const back = deserializeWorld(json)
    const [b] = bullets(back)
    expect(b.projectile!.mods).toEqual([
      { id: 'homing', stacks: 2 },
      { id: 'lifesteal', stacks: 1 },
    ])
    // And the round-trip is byte-identical (the determinism keystone).
    expect(JSON.stringify(serializeWorld(back))).toBe(JSON.stringify(json))
  })
})

describe('normalizeMods (the one normal form)', () => {
  it('drops empties and returns undefined so the field stays absent', () => {
    expect(normalizeMods(undefined)).toBeUndefined()
    expect(normalizeMods([])).toBeUndefined()
    expect(normalizeMods([{ id: 'bogus', stacks: 3 }])).toBeUndefined()
    expect(normalizeMods([{ id: 'pierce', stacks: 0 }])).toBeUndefined()
    expect(normalizeMods([{ id: 'pierce', stacks: -1 }])).toBeUndefined()
    expect(normalizeMods([{ id: 'pierce', stacks: NaN }])).toBeUndefined()
  })

  it('merges duplicates, floors fractions, caps at maxStacks, sorts by id', () => {
    expect(
      normalizeMods([
        { id: 'rapid', stacks: 2.9 },
        { id: 'bounce', stacks: 1 },
        { id: 'rapid', stacks: 9 },
      ]),
    ).toEqual([
      { id: 'bounce', stacks: 1 },
      { id: 'rapid', stacks: 5 }, // 2 + 9 → capped at DEFAULT_MAX_STACKS 5
    ])
  })
})
