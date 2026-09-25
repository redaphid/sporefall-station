// The HOMING rework, adversarially. Playtest verdict on the old mod: "It mostly
// just curves the bullets into walls" — because homeToward chased the GLOBAL
// nearest body with health, walls or no walls, friend or foe. The new contract,
// each clause pinned by a test below:
//   1. LINE-OF-SIGHT GATED: a round only steers toward prey it can actually see
//      (tile raycast). Behind a wall = not there. No visible prey = fly straight.
//   2. FORWARD CONE + RANGE: acquisition happens ahead of the round and nearby —
//      never a yank backwards, never a map-wide magnet.
//   3. HOSTILITY: only real enemies of the OWNER. Never the owner, co-op allies,
//      corpses, neutral civilians (no auto-crime), or an NPC shooter's own gang.
//   4. CAPPED TURN: a curve (≤ homing rad/tick), not a teleport-turn.
//   5. DETERMINISM + snapshot shape: pure world-state reads, no new serialized
//      fields — a homing bullet's JSON shape is exactly what it was before.
// Every test sets EXACT world state (carved geometry, hand-placed bodies), runs
// the REAL systems (projectileSystem / tickWorld), and asserts outcomes.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { arm, expectWorldEqual, runTicks } from '../testkit'
import { projectileSystem } from './projectiles'

// ── exact-geometry helpers ──────────────────────────────────────────────────

/** Open floor box, both layers (tiles AND solid — isSolidTile reads `solid`). */
const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
}

const wallAt = (w: World, x: number, y: number): void => {
  w.level.tiles[y * w.level.w + x] = Tile.Wall
  w.level.solid[y * w.level.w + x] = 1
}

/** Horizontal wall segment [x0..x1] at row y. */
const wallRow = (w: World, x0: number, x1: number, y: number): void => {
  for (let x = x0; x <= x1; x++) wallAt(w, x, y)
}

/** Vertical wall segment [y0..y1] at column x. */
const wallCol = (w: World, x: number, y0: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) wallAt(w, x, y)
}

/** A fresh hostile world with a big open arena — every wall in a test is one
 * the test itself placed, so LOS relations are exact, not seed luck. */
const arena = (hostile = true): World => {
  const w = createWorld(1, 1, 'normal', hostile)
  carve(w, 2, 2, 40, 30)
  return w
}

/** Bare hostile-world target body: no ai → the `w.hostile` floor makes it prey. */
const thug = (w: World, x: number, y: number, hp = 24): Entity => {
  const e = addEntity(w, makeEntity('npc', 'thug', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  return e
}

/** An NPC with a real faction (minimal AiState) — for the disposition tests. */
const factionNpc = (w: World, faction: 'civ' | 'cop' | 'gang' | 'neutral', x: number, y: number): Entity => {
  const e = thug(w, x, y)
  e.ai = { mode: 'idle', faction, home: { x, y }, thinkAt: 0, sightRange: 6 }
  return e
}

/** Hand-spawned homing round: exact position, heading east at pistol speed. */
const shot = (w: World, ownerId: number, x: number, y: number, homing: number, ttl = 40): Entity => {
  const e = addEntity(w, makeEntity('projectile', 'projectile', x, y, 0.15))
  e.vel = { x: 14, y: 0 }
  e.projectile = { ownerId, damage: 14, ttl, homing }
  return e
}

const advance = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) {
    projectileSystem(w)
    w.tick++
  }
}

const angle = (e: Entity): number => Math.atan2(e.vel.y, e.vel.x)

describe('homing — line of sight gates all steering', () => {
  it('(a) prey behind a wall is INVISIBLE: the round flies dead straight, never curving into the wall', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    wallRow(w, 8, 20, 9) // cover between the firing lane (y≈10.5) and the prey
    const bunkered = thug(w, 16.5, 6.5) // in range, well inside the cone — the old code's wall-curve bait
    const b = shot(w, owner.id, 10.5, 10.5, 0.3, 30)
    for (let i = 0; i < 30; i++) {
      advance(w, 1)
      expect(b.vel.y).toBe(0) // NEVER steered, not once, not slightly
      expect(b.vel.x).toBe(14)
    }
    expect(b.dead).toBe(true) // expired at ttl in the open lane…
    expect(b.pos.y).toBe(10.5) // …exactly on its original line
    expect(bunkered.health!.hp).toBe(24) // the bunkered body was never touched
  })

  it('(b) a VISIBLE enemy in the cone is hunted down: the round curves and hits', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    const prey = thug(w, 16.5, 13.0) // ~23° south of the eastward heading
    const b = shot(w, owner.id, 10.5, 10.5, 0.2)
    let curved = false
    for (let i = 0; i < 40 && !b.dead; i++) {
      advance(w, 1)
      if (b.vel.y > 0) curved = true // bent south, toward the prey
    }
    expect(curved).toBe(true)
    expect(b.dead).toBe(true)
    expect(prey.health!.hp).toBeLessThan(24) // and the curve CONNECTED
  })

  it('(c) LOS broken mid-flight stops the steering that instant — the round coasts on its last heading', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 8.5, 10.5)
    wallCol(w, 16, 2, 30) // a standing pillar column east of the stage
    const prey = thug(w, 13.5, 13.0) // west of the pillar: visible at first
    const b = shot(w, owner.id, 8.5, 10.5, 0.1)
    advance(w, 5)
    expect(b.vel.y).toBeGreaterThan(0) // lock: it was steering toward the prey
    // The prey dives behind the pillar (still in range, still in the cone —
    // ONLY the sightline is gone).
    prey.pos = { x: 18.5, y: 13.0 }
    const frozen = { x: b.vel.x, y: b.vel.y }
    for (let i = 0; i < 6; i++) {
      advance(w, 1)
      expect(b.vel.x).toBe(frozen.x) // heading FROZEN — no psychic tracking
      expect(b.vel.y).toBe(frozen.y)
    }
    expect(prey.health!.hp).toBe(24)
  })

  it('(d) no target at all → dead straight for the whole flight', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    const b = shot(w, owner.id, 10.5, 10.5, 0.5, 25)
    for (let i = 0; i < 25; i++) {
      advance(w, 1)
      expect(b.vel.x).toBe(14)
      expect(b.vel.y).toBe(0)
    }
    expect(b.dead).toBe(true)
    expect(b.facing).toBe(0) // never re-aimed
  })

  it('with one enemy BUNKERED (nearer) and one in the open (farther), rounds pick the visible one — the exact playtest scene', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    wallRow(w, 8, 20, 9)
    const bunkered = thug(w, 14.5, 7.5) // dist 5.0 — the OLD code's pick (global nearest)
    const open = thug(w, 16.5, 13.0) // dist 6.5 — farther, but visible
    const b = shot(w, owner.id, 10.5, 10.5, 0.2)
    advance(w, 40)
    expect(open.health!.hp).toBeLessThan(24) // the visible body took the round
    expect(bunkered.health!.hp).toBe(24) // the bunkered one was never chased
    expect(b.dead).toBe(true)
  })
})

describe('homing — cone and range bound the seek', () => {
  it('prey BEHIND the round is never yanked backwards', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    thug(w, 6.5, 13.5) // ~143° off the eastward heading — outside any cone
    const b = shot(w, owner.id, 10.5, 10.5, 0.3, 25)
    for (let i = 0; i < 25; i++) {
      advance(w, 1)
      expect(b.vel.y).toBe(0)
    }
  })

  it('acquisition has a RANGE: a distant enemy is ignored until the round closes in', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    const far = thug(w, 24.5, 14.5) // 14.6 tiles out — beyond the 10-tile seeker head
    const b = shot(w, owner.id, 10.5, 10.5, 0.1)
    for (let i = 0; i < 9; i++) {
      advance(w, 1)
      expect(b.vel.y).toBe(0) // still out of range → still straight
    }
    advance(w, 5) // flight closes the gap under 10 tiles
    expect(b.vel.y).toBeGreaterThan(0) // now it seeks
    expect(far.pos.x).toBe(24.5) // (sanity: nothing moved the target)
  })

  it('the turn rate is CAPPED — a curve of at most `homing` radians per tick, never a snap', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    thug(w, 14.5, 15.5) // ~51° off-axis: several ticks of turning to align
    const b = shot(w, owner.id, 10.5, 10.5, 0.1)
    let prev = angle(b)
    let total = 0
    for (let i = 0; i < 12 && !b.dead; i++) {
      advance(w, 1)
      const a = angle(b)
      const step = Math.abs(a - prev)
      expect(step).toBeLessThanOrEqual(0.1 + 1e-9) // per-tick cap holds exactly
      total += step
      prev = a
    }
    expect(total).toBeGreaterThan(0.4) // …and it genuinely was steering
  })
})

describe('homing — only real enemies of the owner are prey', () => {
  it('(e) a co-op ALLY dead in the cone is never chased', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    const ally = spawnPlayer(w, 1, 16.5, 12.5) // visible, in cone, in range
    const b = shot(w, owner.id, 10.5, 10.5, 0.3, 25)
    for (let i = 0; i < 25; i++) {
      advance(w, 1)
      expect(b.vel.y).toBe(0)
    }
    expect(ally.health!.hp).toBe(ally.health!.max)
  })

  it('(e) the DEAD are not prey', () => {
    const w = arena()
    const owner = spawnPlayer(w, 0, 10.5, 10.5)
    const corpse = thug(w, 16.5, 13.0)
    corpse.dead = true
    const b = shot(w, owner.id, 10.5, 10.5, 0.3, 25)
    for (let i = 0; i < 25; i++) {
      advance(w, 1)
      expect(b.vel.y).toBe(0)
    }
  })

  it('(e) a NEUTRAL civilian in a peaceful world is not prey — homing never auto-commits a crime', () => {
    const peaceful = arena(false)
    const owner = spawnPlayer(peaceful, 0, 10.5, 10.5)
    const civ = factionNpc(peaceful, 'civ', 16.5, 13.0)
    const b = shot(peaceful, owner.id, 10.5, 10.5, 0.3, 25)
    for (let i = 0; i < 25; i++) {
      advance(peaceful, 1)
      expect(b.vel.y).toBe(0)
    }
    expect(civ.health!.hp).toBe(24)

    // Control: the SAME scene in a hostile world IS chased — the gate above was
    // hostility, not a broken mod.
    const hostile = arena(true)
    const owner2 = spawnPlayer(hostile, 0, 10.5, 10.5)
    factionNpc(hostile, 'civ', 16.5, 13.0)
    const b2 = shot(hostile, owner2.id, 10.5, 10.5, 0.3)
    advance(hostile, 8)
    expect(b2.vel.y).toBeGreaterThan(0)
  })

  it("an NPC's homing round hunts the PLAYER — never the shooter's own gang", () => {
    const w = arena()
    const shooter = factionNpc(w, 'gang', 8.5, 10.5)
    const ally = factionNpc(w, 'gang', 14.5, 10.5) // dead ahead — the old code's pick
    const player = spawnPlayer(w, 0, 16.5, 13.5) // off-axis but the true enemy
    player.health!.iframes = 0 // shed spawn grace so the hit can land
    const b = shot(w, shooter.id, 8.5, 10.5, 0.3)
    let curved = false
    for (let i = 0; i < 40 && !b.dead; i++) {
      advance(w, 1)
      if (b.vel.y > 0) curved = true // bent toward the player, away from the ally line
    }
    expect(curved).toBe(true)
    expect(ally.health!.hp).toBe(24) // its own gang untouched
    expect(player.health!.hp).toBeLessThan(player.health!.max) // the player was the mark
  })

  it('the faction matrix drives NPC-vs-NPC homing: a cop round seeks a gangster, never a fellow cop', () => {
    const w = arena()
    const shooter = factionNpc(w, 'cop', 8.5, 10.5)
    const fellowCop = factionNpc(w, 'cop', 14.5, 10.5) // dead ahead
    const gangster = factionNpc(w, 'gang', 15.5, 13.0) // sworn enemy, off-axis
    const b = shot(w, shooter.id, 8.5, 10.5, 0.3)
    let curved = false
    for (let i = 0; i < 40 && !b.dead; i++) {
      advance(w, 1)
      if (b.vel.y > 0) curved = true
    }
    expect(curved).toBe(true)
    expect(fellowCop.health!.hp).toBe(24)
    expect(gangster.health!.hp).toBeLessThan(24)
  })

  it('ADVERSARIAL: an orphaned round (owner despawned) steers at nothing and does not crash', () => {
    const w = arena()
    thug(w, 16.5, 13.0) // bait that must NOT be taken — no owner, no side to fight for
    const b = shot(w, 12345, 10.5, 10.5, 0.3, 25)
    expect(() => advance(w, 25)).not.toThrow()
    expect(b.dead).toBe(true)
    expect(b.pos.y).toBe(10.5) // flew straight to expiry
  })
})

describe('homing — determinism and snapshot shape', () => {
  /** The full playtest scene, built identically each call: carved arena, a wall,
   * a bunkered thug, an open thug, and a homing-3 pistol fired via real inputs. */
  const build = (): World => {
    const w = arena()
    wallRow(w, 8, 20, 9)
    const p = spawnPlayer(w, 0, 10.5, 10.5)
    p.facing = 0
    const stack = arm(p, 'pistol')
    stack.mods = [{ id: 'homing', stacks: 3 }]
    thug(w, 14.5, 7.5)
    thug(w, 16.5, 13.0)
    return w
  }

  it('(f) the same world + the same inputs twice → byte-identical trajectories, wall and all', () => {
    const a = build()
    const b = build()
    const fire = new Map([[0, { attack: true }]])
    for (let i = 0; i < 3; i++) {
      runTicks(a, fire, 20)
      runTicks(b, fire, 20)
      expectWorldEqual(a, b) // checked at 20/40/60 ticks, not just the end
    }
  })

  it('(f) snapshot mid-flight → deserialize → continue matches an unbroken run byte-for-byte', () => {
    // Uncarved world (deserializeWorld enforces the level checksum, so no carved
    // walls here): the proven-open seed-1 stage mods.behavior.test.ts already
    // shoots across, with bullets mid-flight when the snapshot cuts.
    const seed = createWorld(1, 1)
    const p = spawnPlayer(seed, 0, 20.5, 20.5)
    p.facing = 0
    const stack = arm(p, 'pistol')
    stack.mods = [{ id: 'homing', stacks: 3 }]
    const mark = addEntity(seed, makeEntity('npc', 'thug', 25.5, 23.0))
    mark.health = { hp: 200, max: 200, iframes: 0 }
    const json = serializeWorld(seed)
    const unbroken = deserializeWorld(json)
    const split = deserializeWorld(json)
    const fire = new Map([[0, { attack: true }]])
    runTicks(unbroken, fire, 20)
    runTicks(split, fire, 10)
    const resumed = deserializeWorld(serializeWorld(split))
    runTicks(resumed, fire, 10)
    expectWorldEqual(unbroken, resumed)
  })

  it('a homing round serializes with NO new fields — the pre-rework projectile shape, exactly', () => {
    const w = arena()
    const p = spawnPlayer(w, 0, 10.5, 10.5)
    const stack = arm(p, 'pistol')
    stack.mods = [{ id: 'homing', stacks: 2 }]
    p.facing = 0
    p.combat!.cooldown = 0
    tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    const b = w.entities.find((e) => e.kind === 'projectile')!
    const json = JSON.parse(JSON.stringify(b.projectile)) as Record<string, unknown>
    expect(Object.keys(json).sort()).toEqual(['damage', 'homing', 'mods', 'ownerId', 'ttl'])
  })
})
