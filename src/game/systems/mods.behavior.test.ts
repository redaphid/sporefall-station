// System-level weapon-mod tests: set exact world state, drive the REAL fire path
// (combatSystem → projectileSystem → applyDamage + elements), assert on the
// result. Covers every behavior/trigger mod, adversarial owner-death, and
// end-to-end seeded determinism through tickWorld.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity, type WeaponMod } from '../entity'
import { emptyInput, type SimEvent } from '../types'
import { addEntity, createWorld, isBlocked, tickWorld, type World } from '../world'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { WEAPONS } from '../data/items'
import { serializeWorld, deserializeWorld } from '../serialize'
import { expectWorldEqual } from '../testkit'
import { combatSystem } from './combat'
import { projectileSystem } from './projectiles'
import { isFrozen } from './statusFx'

/** A player holding `weaponId` (slotted, so mods attach) with `mods`. */
const armed = (w: World, x: number, y: number, weaponId: string, mods?: WeaponMod[]): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  // Replace the slotted starter with the weapon under test (starter is now a real
  // slotted ItemStack, so pushing would leave it in slot 0 and mis-equip).
  p.loadout!.inventory = [{ itemId: weaponId, qty: 99, ...(mods ? { mods } : {}) }]
  p.combat!.weapon = weaponId
  p.facing = 0 // +x
  return p
}

const npc = (w: World, x: number, y: number, hp = 40): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

const fire = (w: World, p: Entity): void => {
  p.combat!.cooldown = 0
  combatSystem(w, new Map([[p.playerCtl!.playerId, { ...emptyInput(), attack: true }]]))
}

const advance = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) {
    projectileSystem(w)
    w.tick++
  }
}

const eventsOf = (w: World, type: SimEvent['type']): SimEvent[] => w.events.filter((e) => e.type === type)

describe('behavior mods — real fire path', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('vanilla shot: one projectile, one hit, dies on impact', () => {
    const p = armed(w, 20, 20, 'pistol')
    const t = npc(w, 22, 20)
    fire(w, p)
    expect(w.entities.filter((e) => e.kind === 'projectile')).toHaveLength(1)
    advance(w, 20)
    expect(t.health!.hp).toBe(40 - WEAPONS.pistol.damage)
    expect(w.entities.some((e) => e.kind === 'projectile' && !e.dead)).toBe(false)
  })

  it('pierce: a single bullet punches through two lined-up NPCs', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'pierce', stacks: 1 }])
    const a = npc(w, 21.5, 20)
    const b = npc(w, 23, 20)
    fire(w, p)
    advance(w, 30)
    expect(a.health!.hp).toBeLessThan(40)
    expect(b.health!.hp).toBeLessThan(40)
  })

  it('explosive: a bullet detonates, damaging a cluster + emitting an explosion event', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'explosive', stacks: 1 }])
    const direct = npc(w, 22, 20)
    const splash = npc(w, 22, 21) // within blast radius of the impact
    fire(w, p)
    advance(w, 20)
    expect(direct.health!.hp).toBeLessThan(40)
    expect(splash.health!.hp).toBeLessThan(40)
    expect(eventsOf(w, 'explosion').length).toBeGreaterThan(0)
  })

  // Cryo Rounds is CONTROL, not an execute. The freeze sets up; the next shot
  // cracks the ice for heavy bonus damage. It must never delete a body outright:
  // shatter ignores hp, resist and archetype, which made this mod kill a 320hp
  // boss exactly as fast as a 40hp thug.
  it('frost then crack: a frost bullet freezes; the follow-up shot hits far harder but does NOT execute', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'frost', stacks: 1 }])
    const t = npc(w, 22, 20)
    t.health = { hp: 400, max: 400, iframes: 0 } // a pool one cracked shot cannot clear
    fire(w, p)
    advance(w, 20)
    expect(isFrozen(t)).toBe(true)
    expect(t.dead).toBeFalsy()
    const afterFreeze = t.health!.hp
    t.health!.iframes = 0 // iframes lapse between shots (statusSystem decrements them in real ticks)
    fire(w, p)
    advance(w, 20)
    expect(t.dead).toBeFalsy()
    expect(t.shattered).toBeFalsy()
    expect(isFrozen(t)).toBe(false) // the freeze was SPENT cracking
    // The cracking shot landed more than an ordinary pistol round would have.
    expect(afterFreeze - t.health!.hp).toBeGreaterThan(WEAPONS.pistol.damage)
  })

  it('incendiary: a bullet sets the target burning (element applied)', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'incendiary', stacks: 1 }])
    const t = npc(w, 22, 20)
    fire(w, p)
    advance(w, 20)
    expect(t.fx?.burning).toBeDefined()
  })

  it('lifesteal: the shooter heals off a hit', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'lifesteal', stacks: 3 }])
    p.health!.hp = 50
    npc(w, 22, 20)
    fire(w, p)
    advance(w, 20)
    expect(p.health!.hp).toBeGreaterThan(50)
  })

  it('split: a bullet bursts into shards inheriting the owner', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'split', stacks: 2 }])
    npc(w, 22, 20)
    fire(w, p)
    const before = w.entities.filter((e) => e.kind === 'projectile').length
    advance(w, 6)
    const shards = w.entities.filter((e) => e.kind === 'projectile' && e.projectile!.ownerId === p.id)
    expect(w.entities.filter((e) => e.kind === 'projectile').length).toBeGreaterThan(before - 1)
    // at least one child exists at some point and inherits ownerId
    expect(shards.every((s) => s.projectile!.ownerId === p.id)).toBe(true)
  })

  // ---- splinterShot: a radial shrapnel shatter on termination -------------
  // `advance()` never culls dead entities, so every projectile ever spawned (the
  // parent + its fragments) stays in w.entities → an EXACT total count.
  const projTotal = (w: World): number => w.entities.filter((e) => e.kind === 'projectile').length

  it('splinterShot: a round shatters into a radial fragment burst on impact', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'splinterShot', stacks: 1 }])
    npc(w, 22, 20)
    fire(w, p)
    expect(projTotal(w)).toBe(1) // just the parent so far
    advance(w, 12)
    // parent (1) + 4 fragments (splinter:4 × 1 stack). Fragments inherit the owner.
    expect(projTotal(w)).toBe(1 + 4)
    const frags = w.entities.filter((e) => e.kind === 'projectile' && e.id !== w.entities.find((x) => x.kind === 'projectile')!.id)
    expect(frags.every((f) => f.projectile!.ownerId === p.id)).toBe(true)
  })

  it('more stacks → more fragments (splinter:4 per stack)', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'splinterShot', stacks: 3 }])
    npc(w, 22, 20)
    fire(w, p)
    advance(w, 12)
    expect(projTotal(w)).toBe(1 + 12) // 4 × 3 stacks
  })

  it('a vanilla round never splinters', () => {
    const p = armed(w, 20, 20, 'pistol')
    npc(w, 22, 20)
    fire(w, p)
    advance(w, 12)
    expect(projTotal(w)).toBe(1) // the one round, no fragments
  })

  it('fragments never re-splinter — the burst is bounded and dies out', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'splinterShot', stacks: 3 }])
    npc(w, 22, 20)
    fire(w, p)
    advance(w, 4)
    const born = projTotal(w)
    expect(born).toBe(1 + 12)
    // No fragment carries the splinter field (the recursion guard is the field,
    // not the mod-provenance list).
    const frags = w.entities.filter((e) => e.kind === 'projectile' && e.projectile!.splinter === undefined)
    expect(frags.length).toBeGreaterThanOrEqual(12)
    // Run far past the fragment ttl (6): everything dies, nothing new is born.
    advance(w, 40)
    expect(projTotal(w)).toBe(born) // no cascade
    expect(w.entities.some((e) => e.kind === 'projectile' && !e.dead)).toBe(false)
  })

  it('splinter fires on a WALL/ttl impact too, not only on a body', () => {
    // No NPC in front: the round flies until ttl and shatters in place.
    const p = armed(w, 20, 20, 'pistol', [{ id: 'splinterShot', stacks: 1 }])
    fire(w, p)
    advance(w, 80) // outlast the pistol's range/ttl
    expect(projTotal(w)).toBe(1 + 4)
  })

  it('splinter + split COMPOSE: a forward fork AND a radial shatter both fire', () => {
    const p = armed(w, 20, 20, 'pistol', [
      { id: 'split', stacks: 1 }, // 2 forward-fork children on the first body
      { id: 'splinterShot', stacks: 1 }, // 4 radial fragments on death
    ])
    npc(w, 22, 20)
    fire(w, p)
    advance(w, 12)
    // parent (1) + split fork (2) + splinter shatter (4) = 7, and neither child
    // type carries split/splinter → no further children.
    expect(projTotal(w)).toBe(1 + 2 + 4)
  })

  it('splinter fragments inherit the parent element (splinter + frost → icy shards)', () => {
    const p = armed(w, 20, 20, 'pistol', [
      { id: 'frost', stacks: 1 },
      { id: 'splinterShot', stacks: 1 },
    ])
    npc(w, 22, 20)
    fire(w, p)
    advance(w, 12)
    // Fragments are the projectiles WITHOUT a splinter field (the parent keeps its).
    const frags = w.entities.filter((e) => e.kind === 'projectile' && e.projectile!.splinter === undefined)
    expect(frags.length).toBeGreaterThan(0)
    expect(frags.every((f) => f.projectile!.onHit?.status === 'frozen')).toBe(true)
  })

  it('a seeded splinter build replays identically from two deserialized copies', () => {
    const seed = createWorld(7, 1)
    const shooter = armed(seed, 20, 20, 'pistol', [{ id: 'splinterShot', stacks: 3 }])
    npc(seed, 23, 20)
    shooter.combat!.cooldown = 0
    const json = serializeWorld(seed)
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    for (let i = 0; i < 40; i++) {
      tickWorld(a, new Map([[0, { ...emptyInput(), attack: true }]]))
      tickWorld(b, new Map([[0, { ...emptyInput(), attack: true }]]))
    }
    expectWorldEqual(a, b) // identical fragment positions/angles ⇒ RNG-deterministic
  })

  it('detonator: killing an NPC chain-explodes onto a neighbor (on-kill trigger)', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'detonator', stacks: 1 }])
    const weak = npc(w, 22, 20, 10) // dies to one 14-dmg pistol shot
    const neighbor = npc(w, 22, 21.5, 40) // inside the on-kill blast radius (2)
    fire(w, p)
    advance(w, 20)
    expect(weak.dead).toBe(true)
    expect(neighbor.health!.hp).toBeLessThan(40) // caught the detonation
  })

  it('homing: a NEAR-MISS target inside the aim cone pulls the bullet toward it', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'homing', stacks: 3 }])
    npc(w, 25, 22) // ~22° below the due-east shot — inside the ~28° cone
    fire(w, p)
    const proj = w.entities.find((e) => e.kind === 'projectile')!
    expect(proj.vel.y).toBeCloseTo(0) // starts flying straight east
    advance(w, 5)
    expect(proj.dead ? 1 : proj.vel.y).toBeGreaterThan(0) // curved toward the NPC (or already hit)
  })

  it('homing: a target OUTSIDE the aim cone is ignored — the bullet flies straight', () => {
    // The bug this guards: homing used to grab the nearest body at any angle, so
    // a shot east would hook onto someone behind you. Aim overrules homing.
    const p = armed(w, 20, 20, 'pistol', [{ id: 'homing', stacks: 3 }])
    npc(w, 20, 26) // due SOUTH — 90° off the due-east shot
    fire(w, p)
    const proj = w.entities.find((e) => e.kind === 'projectile')!
    advance(w, 5)
    expect(proj.dead).toBeFalsy()
    expect(proj.vel.y).toBeCloseTo(0) // never curved: still flying due east
  })

  it('homing: never steers toward a body it has no line of sight to', () => {
    const p = armed(w, 20, 20, 'pistol', [{ id: 'homing', stacks: 3 }])
    // Wall the target off: a solid tile between the muzzle and the NPC.
    for (let ty = 20; ty <= 22; ty++) {
      w.level.tiles[ty * w.level.w + 23] = Tile.Wall
      w.level.solid[ty * w.level.w + 23] = 1 // isSolidTile reads `solid`, not `tiles`
    }
    npc(w, 25, 22) // inside the cone, but behind the wall
    fire(w, p)
    const proj = w.entities.find((e) => e.kind === 'projectile')!
    advance(w, 2) // before the round reaches the wall
    expect(proj.dead ? 0 : proj.vel.y).toBeCloseTo(0) // no pull through the wall
  })

  it('bounce: a ricochet bullet survives a wall impact instead of dying', () => {
    // Find an open tile with a solid neighbor, aim a fast bullet into the wall.
    let open: [number, number] | undefined
    let dir: [number, number] = [1, 0]
    for (let ty = 1; ty < w.level.h - 1 && !open; ty++) {
      for (let tx = 1; tx < w.level.w - 1 && !open; tx++) {
        if (isBlocked(w, tx, ty)) continue
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
          if (isBlocked(w, tx + dx, ty + dy)) {
            open = [tx, ty]
            dir = [dx, dy]
            break
          }
        }
      }
    }
    expect(open).toBeDefined()
    const [ox, oy] = open!
    const e = addEntity(w, makeEntity('projectile', 'projectile', ox + 0.5, oy + 0.5, 0.15))
    e.vel = { x: dir[0] * 40, y: dir[1] * 40 } // fast enough to cross into the wall in one tick
    e.projectile = { ownerId: 999, damage: 10, ttl: 40, bounceLeft: 2 }
    advance(w, 3)
    // It bounced: still alive and burned at least one bounce charge.
    expect(e.dead).toBeFalsy()
    expect(e.projectile!.bounceLeft).toBeLessThan(2)
  })

  it('ADVERSARIAL: lifesteal when the owner died mid-flight does not crash', () => {
    const t = npc(w, 22, 20)
    const e = addEntity(w, makeEntity('projectile', 'projectile', 21, 20, 0.15))
    e.vel = { x: 14, y: 0 }
    e.projectile = { ownerId: 12345, damage: 14, ttl: 40, lifestealFrac: 0.3 } // owner not in world
    expect(() => advance(w, 10)).not.toThrow()
    expect(t.health!.hp).toBeLessThan(40)
  })
})

describe('modded loadouts — determinism & serialization', () => {
  const build = (): World => {
    const w = createWorld(7, 1)
    const p = armed(w, 20, 20, 'shotgun', [
      { id: 'bulk', stacks: 2 },
      { id: 'bounce', stacks: 1 },
      { id: 'frost', stacks: 1 },
    ])
    p.loadout!.inventory[0].qty = 999
    npc(w, 24, 20, 40)
    npc(w, 24, 22, 40)
    return w
  }

  it('a modded weapon round-trips byte-identically through serialize/deserialize', () => {
    const w = build()
    const json = serializeWorld(w)
    const restored = deserializeWorld(json)
    expect(serializeWorld(restored)).toEqual(json)
    // the mods survived the trip
    const stack = restored.entities.find((e) => e.playerCtl)!.loadout!.inventory[0]
    expect(stack.mods).toEqual([
      { id: 'bulk', stacks: 2 },
      { id: 'bounce', stacks: 1 },
      { id: 'frost', stacks: 1 },
    ])
  })

  it('a seeded modded build replays identically from two deserialized copies', () => {
    const json = serializeWorld(build())
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    const attack = new Map([[0, { attack: true }]])
    for (let i = 0; i < 40; i++) {
      tickWorld(a, new Map([...attack].map(([s, c]) => [s, { ...emptyInput(), ...c }])))
      tickWorld(b, new Map([...attack].map(([s, c]) => [s, { ...emptyInput(), ...c }])))
    }
    expectWorldEqual(a, b)
  })

  it('snapshot mid-run → deserialize → continue matches an unbroken run byte-for-byte', () => {
    const json = serializeWorld(build())
    const unbroken = deserializeWorld(json)
    const split = deserializeWorld(json)
    const step = (w: World): void => tickWorld(w, new Map([[0, { ...emptyInput(), attack: true }]]))
    for (let i = 0; i < 20; i++) step(unbroken)
    for (let i = 0; i < 10; i++) step(split)
    const resumed = deserializeWorld(serializeWorld(split))
    for (let i = 0; i < 10; i++) step(resumed)
    expectWorldEqual(unbroken, resumed)
  })
})
