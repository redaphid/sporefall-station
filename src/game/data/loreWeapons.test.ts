import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEAPONS, itemClass, type WeaponDef } from './items'
import { NPCS } from './npcs'
import { PLAYER_START_WEAPON } from '../player'
import { LOOT_ITEM_IDS, spawnNpc } from '../populate'
import { createWorld } from '../world'
import { mulberry32 } from '../rng'

// The mundane weapons the lore replaced, with the combat numbers each had on
// the day it was removed. Every slot's numbers must survive the rename
// unchanged: the lore weapons are identity and art, not a balance pass.
const OLD: Record<string, { now: string; def: Omit<WeaponDef, 'id' | 'name'> }> = {
  wrench: { now: 'pressureLance', def: { kind: 'melee', damage: 16, range: 1.3, cooldownTicks: 15, knockback: 7, durability: 16 } },
  knife: { now: 'siphonSpike', def: { kind: 'melee', damage: 12, range: 1.1, cooldownTicks: 9, knockback: 2, durability: 20 } },
  sledgehammer: {
    now: 'cageRam',
    def: { kind: 'melee', damage: 26, range: 1.4, cooldownTicks: 28, knockback: 16, durability: 12, onHit: { status: 'stun', ticks: 20 }, slots: 8, castsPerTrigger: 1, rechargeOnWrap: 75 },
  },
  pistol: { now: 'rivetDriver', def: { kind: 'ranged', damage: 14, range: 10, cooldownTicks: 18, knockback: 3, projectileSpeed: 14, slots: 4, castsPerTrigger: 1, rechargeOnWrap: 20 } },
  shotgun: {
    now: 'scatterFunnel',
    def: { kind: 'ranged', damage: 7, range: 6, cooldownTicks: 26, knockback: 4, projectileSpeed: 16, pellets: 5, spread: 0.5, slots: 4, castsPerTrigger: 2, rechargeOnWrap: 30 },
  },
  machinegun: { now: 'coilRepeater', def: { kind: 'ranged', damage: 8, range: 9, cooldownTicks: 5, knockback: 1, projectileSpeed: 16, slots: 6, castsPerTrigger: 1, rechargeOnWrap: 45 } },
  freezeRay: { now: 'frostCondenser', def: { kind: 'ranged', damage: 0, range: 8, cooldownTicks: 22, knockback: 0, projectileSpeed: 13, onHit: { status: 'frozen', ticks: 120 } } },
  tranquilizer: { now: 'lullDarter', def: { kind: 'ranged', damage: 0, range: 8, cooldownTicks: 20, knockback: 0, projectileSpeed: 13, onHit: { status: 'sleep', ticks: 150 } } },
  flamethrower: { now: 'phosphorHose', def: { kind: 'ranged', damage: 3, range: 5, cooldownTicks: 6, knockback: 0, projectileSpeed: 11, onHit: { status: 'burning', ticks: 240 } } },
  stunGun: { now: 'sparkCoil', def: { kind: 'ranged', damage: 2, range: 5, cooldownTicks: 24, knockback: 1, projectileSpeed: 14, onHit: { status: 'electrified', ticks: 45 } } },
}
const REMOVED = Object.keys(OLD)

/** Archetypes whose body holds a carried tool: colonists, divers, the frog
 * traders. Everything else (beasts, drones, machines, echo blobs) fights with
 * its body and must never be handed or drawn a carried weapon. */
const TOOL_USERS = new Set(['mutant', 'acolyte', 'civilian', 'shopkeeper', 'scientist', 'drowner', 'bellwether', 'mender', 'breacher'])

/** A weapon's numbers: every field but its identity (id, name). */
const numbers = (d: WeaponDef): Partial<WeaponDef> =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'id' && k !== 'name'))

describe('lore weapons: the mundane arsenal is gone, its numbers are not', () => {
  it('no removed id is still a weapon, an item, a loot roll or the starter', () => {
    for (const id of REMOVED) {
      expect(WEAPONS[id], id).toBeUndefined()
      expect(itemClass(id), id).toBe('unknown')
      expect(LOOT_ITEM_IDS, id).not.toContain(id)
    }
    expect(REMOVED).not.toContain(PLAYER_START_WEAPON)
    expect(PLAYER_START_WEAPON).toBe('rivetDriver')
  })

  it('every slot keeps the old weapon numbers exactly, under a new id and name', () => {
    for (const [old, { now, def }] of Object.entries(OLD)) {
      const w = WEAPONS[now]
      expect(w, `${old} -> ${now}`).toBeDefined()
      expect(w.id).toBe(now)
      expect(numbers(w), `${old} -> ${now}`).toEqual(def)
      expect(w.natural, now).toBeUndefined()
      expect(w.name.toLowerCase(), now).not.toMatch(/pistol|wrench|knife|hammer|shotgun|machine gun|gun|club|bat|ray/)
    }
  })

  it('no NPC archetype holds a removed id', () => {
    for (const [arch, def] of Object.entries(NPCS)) expect(REMOVED, arch).not.toContain(def.weapon)
  })

  it('only tool users carry a weapon; every other body is its own weapon', () => {
    for (const [arch, def] of Object.entries(NPCS)) {
      if (TOOL_USERS.has(arch)) continue
      expect(WEAPONS[def.weapon]?.natural, `${arch} holds ${def.weapon}`).toBe(true)
    }
  })

  it("the drone wardens' grapple arms are the old wrench, byte for byte", () => {
    expect(NPCS.warden.weapon).toBe('grappleArms')
    expect(WEAPONS.grappleArms.natural).toBe(true)
    expect(numbers(WEAPONS.grappleArms)).toEqual({ ...OLD.wrench.def, natural: true })
  })

  it('a populated drone keeps its arms even when the arsenal roll lands a gun', () => {
    const w = createWorld(7, 1)
    // A fresh stream per spawn; across 40 rolls the arsenal surely hands out a
    // carried weapon, which a drone must discard.
    for (let seed = 1; seed <= 40; seed++) {
      for (const arch of ['warden', 'lockkeeper']) {
        const e = spawnNpc(w, arch, 5, 5, mulberry32(seed))
        expect(WEAPONS[e.combat!.weapon].natural, `${arch} seed ${seed}: ${e.combat!.weapon}`).toBe(true)
      }
      const civ = spawnNpc(w, 'civilian', 5, 5, mulberry32(seed))
      expect(REMOVED).not.toContain(civ.combat!.weapon)
    }
  })
})

// The rename touches ids every in-flight branch also uses ('pistol' in a test,
// "pickup.wrench" in a fixture). A merge that brings one back compiles fine and
// only fails at run time as an 'unknown' item, so scan for it here; the fix is
// `python3 scripts/rename-weapon-ids.py`.
describe('no source file still names a removed weapon id', () => {
  const ROOT = join(__dirname, '..', '..', '..')
  const ALLOW = new Set([
    'src/game/data/loreWeapons.test.ts',
    'src/net/protocol/messages.ts', // RETIRED wire entries, append-only
  ])
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|json)$/.test(name)) files.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  const pattern = new RegExp(`(['"\`])(${REMOVED.join('|')})\\1|pickup\\.(${REMOVED.join('|')})\\b|(WEAPONS|weapon)\\.(${REMOVED.join('|')})\\b`)

  it('finds none outside the allow-list', () => {
    const hits: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f).split('\\').join('/')
      if (ALLOW.has(rel)) continue
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trimStart().startsWith('//') || line.trimStart().startsWith('*') ? '' : line
          if (pattern.test(code)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`)
        })
    }
    expect(hits).toEqual([])
  })
})
