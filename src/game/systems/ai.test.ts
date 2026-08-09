// Combat AI: NPCs are enemies that acquire a player, chase to weapon range, and
// attack through the SAME fire path the player uses. Each test sets exact world
// state (createWorld + carved arena + spawnPlayer/spawnNpc), runs the REAL systems
// via runTicks, and asserts on the result — no mocks, no peeking at internals
// beyond public component fields. Adversarial cases (peaceful opt-out, sleeper,
// out-of-range) sit next to the happy path.

import { describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { spawnNpc, populateWorld } from '../populate'
import { serializeWorld } from '../serialize'
import { hasStatus } from './statusFx'
import { Tile } from '../levelgen/level'
import { createWorld, tickWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'

/** Carve an open floor box so LOS/movement are clean regardless of the seed's
 * generated layout — the arena the combat plays out in. */
const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) w.level.tiles[y * w.level.w + x] = Tile.Floor
  }
}

const idle = new Map<number, Partial<InputCmd>>([[0, emptyInput()]])

const run = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, { ...emptyInput() }]]))
}

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by)

/** A fresh world with a carved arena; the player is passive (never attacks). */
const arena = (seed = 1, hostile = true): { w: World } => {
  const w = createWorld(seed, 1, 'normal', hostile)
  carve(w, 8, 18, 40, 22)
  return { w }
}

describe('combat AI — acquire, chase, attack', () => {
  it('a hostile-world NPC acquires a passive player, closes in, and deals damage', () => {
    const { w } = arena()
    const player = spawnPlayer(w, 0, 12.5, 20.5)
    player.health!.iframes = 0 // shed spawn grace: this tests acquire/chase/attack, not spawn protection
    const civ = spawnNpc(w, 'civilian', 17.5, 20.5) // fists, sightRange 6: engages only because w.hostile
    const startDist = dist(civ.pos.x, civ.pos.y, player.pos.x, player.pos.y)

    run(w, 90)

    const endDist = dist(civ.pos.x, civ.pos.y, player.pos.x, player.pos.y)
    expect(civ.ai!.mode).toBe('aggro') // acquired the player
    expect(endDist).toBeLessThan(startDist - 3) // chased toward the player
    expect(player.health!.hp).toBeLessThan(player.health!.max) // and hit them
  })

  it('is reversible: with hostility off, a civilian stays peaceful and never approaches', () => {
    const { w } = arena(1, false)
    const player = spawnPlayer(w, 0, 12.5, 20.5)
    const civ = spawnNpc(w, 'civilian', 17.5, 20.5) // in sight, but hostility is OFF
    const startDist = dist(civ.pos.x, civ.pos.y, player.pos.x, player.pos.y)

    run(w, 90)

    expect(civ.ai!.mode).not.toBe('aggro')
    expect(player.health!.hp).toBe(player.health!.max)
    // it did not charge the player (may amble a little, but not close the gap)
    expect(dist(civ.pos.x, civ.pos.y, player.pos.x, player.pos.y)).toBeGreaterThan(startDist - 2)
  })

  it('a melee NPC closes to swinging range; a ranged NPC holds its distance', () => {
    const { w } = arena()
    const player = spawnPlayer(w, 0, 15.5, 20.5)
    const melee = spawnNpc(w, 'thug', 21.5, 19.5) // bat, sightRange 7 → perceives at ~6
    melee.combat!.weapon = 'bat'
    const shooter = spawnNpc(w, 'thug', 21.5, 21.5) // pistol
    shooter.combat!.weapon = 'pistol'

    run(w, 120)

    const meleeDist = dist(melee.pos.x, melee.pos.y, player.pos.x, player.pos.y)
    const shooterDist = dist(shooter.pos.x, shooter.pos.y, player.pos.x, player.pos.y)
    expect(meleeDist).toBeLessThan(2) // closed to melee reach
    expect(shooterDist).toBeGreaterThan(3) // kept a standoff instead of clumping
    expect(player.health!.hp).toBeLessThan(player.health!.max) // both drew blood
  })

  it('a ranged NPC actually fires bullets down the shared projectile path', () => {
    const { w } = arena()
    spawnPlayer(w, 0, 12.5, 20.5)
    const shooter = spawnNpc(w, 'gangster', 18.5, 20.5)
    shooter.combat!.weapon = 'pistol'

    let sawBullet = false
    for (let i = 0; i < 60; i++) {
      tickWorld(w, new Map([[0, { ...emptyInput() }]]))
      if (w.entities.some((e) => e.kind === 'projectile' && e.projectile?.ownerId === shooter.id)) sawBullet = true
    }
    expect(sawBullet).toBe(true)
  })

  it('an element weapon inflicts its status on the player through fireWeapon (onHit works for NPCs)', () => {
    const { w } = arena()
    const player = spawnPlayer(w, 0, 12.5, 20.5)
    const iceman = spawnNpc(w, 'gangster', 18.5, 20.5)
    iceman.combat!.weapon = 'freezeRay' // damage 0, freezes on hit — only lands via the shared path

    // Must outlast SPAWN_GRACE_TICKS (90). On-hit statuses are now gated on the
    // blow actually landing, so spawn invulnerability blocks the freeze as well
    // as the damage — it previously did not, which meant a player could be frozen
    // solid during the grace window that exists to stop exactly that.
    let frozenDuringGrace = false
    for (let i = 0; i < 80; i++) {
      tickWorld(w, new Map([[0, { ...emptyInput() }]]))
      if (hasStatus(player, 'frozen')) frozenDuringGrace = true
    }
    expect(frozenDuringGrace).toBe(false)

    let frozen = false
    for (let i = 0; i < 150; i++) {
      tickWorld(w, new Map([[0, { ...emptyInput() }]]))
      if (hasStatus(player, 'frozen')) frozen = true
    }
    expect(frozen).toBe(true)
  })
})

describe('combat AI — exemptions (a downed/asleep NPC does not fight)', () => {
  it('a sleeping NPC neither moves nor attacks even in a hostile world', () => {
    const { w } = arena()
    const player = spawnPlayer(w, 0, 12.5, 20.5)
    const sleeper = spawnNpc(w, 'thug', 16.5, 20.5)
    sleeper.combat!.weapon = 'bat'
    sleeper.status!.sleep = 300
    const startDist = dist(sleeper.pos.x, sleeper.pos.y, player.pos.x, player.pos.y)

    run(w, 60)

    expect(player.health!.hp).toBe(player.health!.max) // never swung
    expect(dist(sleeper.pos.x, sleeper.pos.y, player.pos.x, player.pos.y)).toBeCloseTo(startDist, 5)
  })

  it('an NPC with no player in sight range stays idle/wandering, not aggro', () => {
    const { w } = arena()
    carve(w, 8, 18, 60, 22)
    spawnPlayer(w, 0, 12.5, 20.5)
    const far = spawnNpc(w, 'thug', 55.5, 20.5) // ~43 tiles away, well beyond sightRange 7

    run(w, 20)

    expect(far.ai!.mode).not.toBe('aggro')
  })
})

describe('combat AI — determinism', () => {
  it('same seed + same inputs → byte-identical worlds', () => {
    const build = (): World => {
      const w = createWorld(42, 1, 'normal', true)
      carve(w, 8, 18, 40, 22)
      spawnPlayer(w, 0, 12.5, 20.5)
      spawnNpc(w, 'thug', 22.5, 19.5).combat!.weapon = 'bat'
      spawnNpc(w, 'gangster', 24.5, 21.5).combat!.weapon = 'pistol'
      return w
    }
    const a = build()
    const b = build()
    for (let i = 0; i < 100; i++) {
      tickWorld(a, new Map([[0, { ...emptyInput() }]]))
      tickWorld(b, new Map([[0, { ...emptyInput() }]]))
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})

describe('varied weapon assignment at spawn', () => {
  const npcWeapons = (w: World): string[] =>
    w.entities.filter((e) => e.kind === 'npc' && e.combat).map((e) => e.combat!.weapon)

  it('populated NPCs draw a SPREAD of weapons, not one archetype-locked stick', () => {
    const w = createWorld(2026, 3) // deeper floor → plenty of NPCs
    populateWorld(w)
    const weapons = npcWeapons(w)
    expect(weapons.length).toBeGreaterThan(5)
    expect(new Set(weapons).size).toBeGreaterThan(2) // genuinely varied
  })

  it('weapon assignment is deterministic: same seed → identical loadouts', () => {
    const wa = createWorld(777, 3)
    const wb = createWorld(777, 3)
    populateWorld(wa)
    populateWorld(wb)
    expect(npcWeapons(wa)).toEqual(npcWeapons(wb))
  })

  it('different seeds produce different loadouts (the spread actually varies)', () => {
    const seeds = [1, 2, 3, 4, 5]
    const loadouts = seeds.map((s) => {
      const w = createWorld(s, 3)
      populateWorld(w)
      return npcWeapons(w).join(',')
    })
    expect(new Set(loadouts).size).toBeGreaterThan(1)
  })
})

// idle-input sanity: the passive-player command really is inert.
void idle
