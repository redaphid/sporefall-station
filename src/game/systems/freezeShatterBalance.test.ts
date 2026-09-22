// Regression: the freeze mod must not be an execute button.
//
// Reported by the owner as "the freeze mod still allows players to 2-shot
// everything, including bosses". It did: the shatter rule was an INSTANT KILL
// on any impact landing on a frozen body, so shot 1 froze and shot 2 killed,
// whatever the target's hp pool was. Measured through this exact path with the
// 14-damage pistol (scripts/test/freeze-shatter-probe.mts), every archetype in
// the game died in 2 shots — the 320hp Mireclaw Alpha included, down from 30.
//
// The fix makes a shatter a very hard HIT (x SHATTER_DAMAGE_MULT) instead of a
// separate lethality rule, so it is bounded by the hp pool like everything else.
// These tests pin the three things that must stay true:
//   1. a boss cannot be two-shot via freeze,
//   2. an ordinary grunt still shatters (the mechanic keeps its feel and its gib),
//   3. a PLAYER still only cracks the ice — that exemption is untouched.
import { beforeEach, describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { NPCS } from '../data/npcs'
import { MODS } from '../data/mods'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import type { Entity } from '../entity'
import { createWorld, type World } from '../world'
import { SHATTER_DAMAGE_MULT, applyDamage } from './combat'
import { applyStatus, isFrozen } from './statusFx'
import { statusSystem } from './status'

const PISTOL = WEAPONS.pistol
const FROST = MODS.frost.onHit!

/** One shot in the projectile system's order — damage first, THEN the onHit
 * status — followed by the weapon's cooldown run through the real timer system,
 * so i-frames expire and the frost clock advances exactly as they do in play. */
const shoot = (w: World, target: Entity, damage = PISTOL.damage): number | null => {
  const dealt = applyDamage(w, target, damage, 0, 0, 0, 999)
  if (dealt !== null) applyStatus(w, target, FROST.status, FROST.ticks)
  for (let i = 0; i < PISTOL.cooldownTicks; i++) {
    statusSystem(w)
    w.tick++
  }
  return dealt
}

/** Shots a frost-modded pistol needs to put `archetype` down, capped so a
 * regression cannot hang the suite. */
const frostShotsToKill = (archetype: string, cap = 200): number => {
  const w = createWorld(7, 1)
  const e = spawnNpc(w, archetype, 5, 5)
  let shots = 0
  while (!e.dead && (e.health?.hp ?? 0) > 0 && shots < cap) {
    shoot(w, e)
    shots++
  }
  return shots
}

describe('freeze + shatter is a hard hit, not an execute', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(7, 1)
  })

  it('THE BUG: a boss cannot be two-shot through freeze', () => {
    const boss = spawnNpc(w, 'boss', 5, 5)
    expect(boss.health!.max).toBe(NPCS.boss.hp) // 320 — the premise of this test

    shoot(w, boss) // shot 1: damages and freezes
    expect(isFrozen(boss)).toBe(true)
    shoot(w, boss) // shot 2: shatters

    expect(boss.dead).toBeFalsy()
    expect(boss.health!.hp).toBeGreaterThan(0)
    // And it keeps most of its bar: 14 + 14x5, both at 0.75 physical resist.
    expect(boss.health!.hp).toBe(320 - 11 - 53)
  })

  it('a frost pistol still HALVES the boss fight — worth bringing, not an off switch', () => {
    // The balance claim in one number. Plain pistol: 30 shots. If this drops back
    // toward 2 the execute is back; if it climbs to 30 the mod does nothing.
    const shots = frostShotsToKill('boss')
    expect(shots).toBeGreaterThan(10)
    expect(shots).toBeLessThan(25)
  })

  it('no archetype in the game dies in two frost shots unless its hp pool allows it', () => {
    // The generalisation of the bug: it was never boss-specific. Anything that
    // survives 84 damage (one pistol round + one 5x shatter) must survive two shots.
    for (const [arch, def] of Object.entries(NPCS)) {
      const effectiveHp = def.hp / (def.resist?.physical ?? 1)
      if (effectiveHp <= PISTOL.damage * (1 + SHATTER_DAMAGE_MULT)) continue
      expect(frostShotsToKill(arch), `${arch} (${def.hp}hp) still 2-shots`).toBeGreaterThan(2)
    }
  })

  it('an ordinary grunt STILL shatters in two, and still ice-gibs', () => {
    const thug = spawnNpc(w, 'thug', 5, 5)
    shoot(w, thug)
    expect(thug.dead).toBeFalsy()
    shoot(w, thug)
    expect(thug.dead).toBe(true)
    expect(thug.shattered).toBe(true)
    expect(w.events.filter((e) => e.type === 'shatter')).toHaveLength(1)
  })

  it('the PLAYER exemption is untouched: impact cracks the ice, damage is unmultiplied', () => {
    const p = spawnPlayer(w, 0, 5, 5)
    p.health = { hp: 100, max: 100, iframes: 0 }
    applyStatus(w, p, 'frozen', 120)
    expect(isFrozen(p)).toBe(true)

    const dealt = applyDamage(w, p, 14, 0, 0, 0, 999)

    expect(dealt).toBe(14) // NOT 70
    expect(p.health!.hp).toBe(86)
    expect(isFrozen(p)).toBe(false) // the ice cracked
    expect(p.shattered).toBeFalsy()
    expect(p.playerCtl!.downed).toBeFalsy()
  })

  it('enemies cannot execute each other either: an NPC freeze ray no longer arms a one-hit kill', () => {
    // NPCs draw the freeze ray from NPC_ARSENAL and the frost mod from
    // ENEMY_MODS, so the old rule let a crossfire delete a boss by accident.
    const boss = spawnNpc(w, 'boss', 5, 5)
    const thug = spawnNpc(w, 'thug', 6, 5)
    const ray = WEAPONS.freezeRay
    expect(ray.damage).toBe(0) // pure utility: it lands, deals nothing, freezes
    expect(applyDamage(w, boss, ray.damage, 6, 5, 0, thug.id)).toBe(0)
    applyStatus(w, boss, ray.onHit!.status, ray.onHit!.ticks)
    for (let i = 0; i < 20; i++) {
      statusSystem(w)
      w.tick++
    }

    const dealt = applyDamage(w, boss, WEAPONS.bat.damage, 6, 5, 0, thug.id)

    expect(boss.dead).toBeFalsy()
    expect(dealt).toBe(60) // round(16 x 5 x 0.75)
  })
})
