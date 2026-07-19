import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addStatus } from './statusFx'
import { addEntity, createWorld, type World } from '../world'
import { spawnPlayer } from '../player'
import { spawnObject } from './objects'
import { applyDamage, kill, meleeAttack } from './combat'
import { missionSystem } from './missions'
import { buildSnapshot } from '../snapshot'
import type { SimEvent } from '../types'

/** A plain damageable NPC at (x,y). Civilians have ai + status so damage
 * side-effects (flee, hitFlash) exercise their branches. */
const npc = (w: World, x: number, y: number, hp = 40, archetype = 'civilian'): Entity => {
  const e = addEntity(w, makeEntity('npc', archetype, x, y))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.speed = 4
  return e
}

const events = (w: World, type: SimEvent['type']): SimEvent[] => w.events.filter((e) => e.type === type)

describe('applyDamage — core arithmetic and iframes', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('subtracts damage, grants iframes, flashes, and wakes sleepers', () => {
    const e = npc(w, 20, 20)
    e.status!.sleep = 100
    applyDamage(w, e, 10, 19, 20, 0, 99)
    expect(e.health!.hp).toBe(30)
    expect(e.health!.iframes).toBe(5)
    expect(e.status!.hitFlashUntil).toBe(w.tick + 3)
    expect(e.status!.sleep).toBe(0)
    expect(events(w, 'hit')).toHaveLength(1)
  })

  it('an iframed target shrugs off the hit entirely (no hp change, no event)', () => {
    const e = npc(w, 20, 20)
    e.health!.iframes = 1
    applyDamage(w, e, 10, 19, 20, 0, 99)
    expect(e.health!.hp).toBe(40)
    expect(events(w, 'hit')).toHaveLength(0)
  })

  it('iframe boundary: exactly 0 iframes still takes damage', () => {
    const e = npc(w, 20, 20)
    e.health!.iframes = 0
    applyDamage(w, e, 10, 19, 20, 0, 99)
    expect(e.health!.hp).toBe(30)
  })

  it('a dead target is inert', () => {
    const e = npc(w, 20, 20)
    e.dead = true
    applyDamage(w, e, 10, 19, 20, 0, 99)
    expect(e.health!.hp).toBe(40)
  })

  it('a target with no health component is skipped without throwing', () => {
    const e = addEntity(w, makeEntity('pickup', 'pickup.cash', 20, 20))
    expect(() => applyDamage(w, e, 10, 19, 20, 0, 99)).not.toThrow()
  })

  it('zero damage still lands (iframes, flash, knockback, event) but never kills a live target', () => {
    const e = npc(w, 20, 20)
    applyDamage(w, e, 0, 19, 20, 5, 99)
    expect(e.health!.hp).toBe(40)
    expect(e.health!.iframes).toBe(5)
    expect(e.vel.x).toBeGreaterThan(0) // knocked along +x (hit from the left)
    expect(e.dead).toBeFalsy()
    expect(events(w, 'death')).toHaveLength(0)
  })

  it('ADVERSARIAL: negative damage NEVER heals — it is clamped to a harmless 0-damage blow', () => {
    const e = npc(w, 20, 20, 30)
    applyDamage(w, e, -100, 19, 20, 5, 99)
    expect(e.health!.hp).toBe(30) // no heal — hp unchanged
    expect(e.dead).toBeFalsy()
    expect(e.health!.iframes).toBe(5) // still lands as a blow
    expect(e.vel.x).toBeGreaterThan(0) // knockback still applies
    expect(events(w, 'hit')).toHaveLength(1)
  })

  it('ADVERSARIAL: a negative-damage "hit" on a full-hp target cannot push hp over max', () => {
    const e = npc(w, 20, 20, 40)
    applyDamage(w, e, -9999, 19, 20, 0, 99)
    expect(e.health!.hp).toBe(40)
  })

  it('huge overkill damage drops hp well below zero and kills', () => {
    const e = npc(w, 20, 20, 40)
    applyDamage(w, e, 9999, 19, 20, 0, 99)
    expect(e.health!.hp).toBeLessThan(0)
    expect(e.dead).toBe(true)
  })

  it('knockback pushes directly away from the hit source', () => {
    const e = npc(w, 20, 20)
    applyDamage(w, e, 1, 20, 18, 10, 99) // hit from below → pushed +y
    expect(e.vel.y).toBeGreaterThan(0)
    expect(Math.abs(e.vel.x)).toBeLessThan(1e-9)
  })
})

describe('applyDamage — object resistance and destruction', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a barrel below its damage threshold bounces the hit off', () => {
    const barrel = spawnObject(w, 'barrel', 20, 20) // threshold 5
    const before = barrel.health!.hp
    applyDamage(w, barrel, 4, 19, 20, 0, 99)
    expect(barrel.health!.hp).toBe(before)
    expect(barrel.dead).toBeFalsy()
  })

  it('a barrel at/above threshold takes damage and, when depleted, destroys (not kill/downed)', () => {
    const barrel = spawnObject(w, 'barrel', 20, 20) // hp 15, threshold 5
    applyDamage(w, barrel, 999, 19, 20, 0, 99)
    expect(barrel.dead).toBe(true)
    expect(events(w, 'death')).not.toHaveLength(0)
  })
})

describe('kill — players go downed, everything else dies', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('kill on a non-player marks it dead and emits a death event', () => {
    const e = npc(w, 20, 20)
    kill(w, e)
    expect(e.dead).toBe(true)
    expect(events(w, 'death')).toHaveLength(1)
  })

  it('kill on a player DOWNS them (bleeding, immobile) — NOT dead, real death is deferred to run-over', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.vel = { x: 3, y: -2 }
    kill(w, p)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeDefined()
    expect(p.playerCtl!.downed!.bleedTicks).toBe(30 * 30)
    expect(p.playerCtl!.downed!.reviveProgress).toBe(0)
    expect(p.health!.hp).toBe(0)
    expect(p.vel).toEqual({ x: 0, y: 0 })
  })

  it('applyDamage cannot re-hit a downed player (they are out of the fight, not a piñata)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    kill(w, p)
    const downedRef = p.playerCtl!.downed
    applyDamage(w, p, 50, 19, 20, 5, 99)
    expect(p.health!.hp).toBe(0)
    expect(p.playerCtl!.downed).toBe(downedRef) // untouched
    expect(p.dead).toBeFalsy()
  })

  it('ADVERSARIAL: calling kill() again on a downed player is INERT — the bleed timer keeps its progress (#52)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    kill(w, p)
    p.playerCtl!.downed!.bleedTicks = 5 // almost bled out
    kill(w, p)
    expect(p.dead).toBeFalsy()
    // Must NOT re-arm to a fresh 900: a DOT tick re-killing the downed body every
    // interval used to reset this forever, trapping a downed solo player at hp 0
    // (the red-flash-forever dead-end). The existing bleed-out is preserved.
    expect(p.playerCtl!.downed!.bleedTicks).toBe(5)
  })
})

describe('shatter — frozen bodies gib on impact', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('any impact on a frozen NPC is an instant kill regardless of damage, clearing frost', () => {
    const e = npc(w, 20, 20)
    addStatus(w, e, 'frozen', 120)
    applyDamage(w, e, 1, 19, 20, 0, 99)
    expect(e.health!.hp).toBe(0)
    expect(e.dead).toBe(true)
    expect(e.shattered).toBe(true)
    expect(events(w, 'shatter')).toHaveLength(1)
  })

  it('iframes take priority over shatter: a frozen but iframed target is untouched', () => {
    const e = npc(w, 20, 20)
    addStatus(w, e, 'frozen', 120)
    e.health!.iframes = 2
    applyDamage(w, e, 50, 19, 20, 0, 99)
    expect(e.dead).toBeFalsy()
    expect(e.shattered).toBeFalsy()
  })

  it('a FROZEN PLAYER shattering DOWNS them without gib-vanishing: no shattered flag, no ice-gib event, still in the snapshot', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.iframes = 0 // shed spawn grace: this tests the frozen-shatter path
    addStatus(w, p, 'frozen', 120)
    applyDamage(w, p, 1, 19, 20, 0, 99)
    expect(p.shattered).toBeFalsy() // NOT gibbed — stays a visible body
    expect(events(w, 'shatter')).toHaveLength(0) // no ice-gib fx for a player
    expect(p.dead).toBeFalsy() // player rules win: downed, not dead
    expect(p.playerCtl!.downed).toBeDefined()
    expect(buildSnapshot(w).entities.some((s) => s.id === p.id)).toBe(true) // not vanished
  })

  it('a frozen player who is OUT OF LIVES shatters straight to a real death (still no gib flag)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.iframes = 0 // shed spawn grace: this tests the frozen-shatter path
    w.revivesLeft = 0
    addStatus(w, p, 'frozen', 120)
    applyDamage(w, p, 1, 19, 20, 0, 99)
    expect(p.shattered).toBeFalsy()
    expect(p.dead).toBe(true)
    expect(p.playerCtl!.downed).toBeUndefined()
  })
})

describe('meleeAttack — arc, targeting, backstab', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('hits the nearest live target within range and the facing arc', () => {
    const attacker = spawnPlayer(w, 0, 20, 20)
    attacker.facing = 0 // +x
    const near = npc(w, 20.8, 20)
    const far = npc(w, 21.4, 20)
    const hit = meleeAttack(w, attacker, 10, 1.5, 0)
    expect(hit).toBe(near)
    expect(near.health!.hp).toBe(30)
    expect(far.health!.hp).toBe(40)
  })

  it('misses a target behind the attacker (outside the 90° arc)', () => {
    const attacker = spawnPlayer(w, 0, 20, 20)
    attacker.facing = 0 // facing +x
    const behind = npc(w, 19, 20) // directly behind
    const hit = meleeAttack(w, attacker, 10, 1.5, 0)
    expect(hit).toBeNull()
    expect(behind.health!.hp).toBe(40)
  })

  it('a cloaked backstab triples damage and breaks the cloak', () => {
    const attacker = spawnPlayer(w, 0, 20, 20)
    attacker.facing = 0
    attacker.status!.cloakUntil = w.tick + 100
    const victim = npc(w, 20.8, 20)
    victim.facing = 0 // facing away from the attacker (same direction) → backstab
    meleeAttack(w, attacker, 10, 1.5, 0)
    expect(victim.health!.hp).toBe(10) // 40 − 30 (triple)
    expect(attacker.status!.cloakUntil).toBe(w.tick) // cloak broken
  })
})

describe('run-over — the real game-over, driven by missionSystem', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('SOLO with lives left: the lone player going down does NOT end the run (they self-revive)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    kill(w, p) // revivesLeft still 2 → downed, not dead
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeDefined()
    missionSystem(w)
    expect(w.gameOver).toBe(false)
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(0)
  })

  it('SOLO out of lives: a down is a real DEATH → run over, emitting runOver exactly once', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    w.revivesLeft = 0 // comeback economy spent
    kill(w, p)
    expect(p.dead).toBe(true) // no downed grace — permanent death
    expect(p.playerCtl!.downed).toBeUndefined()
    missionSystem(w)
    expect(w.gameOver).toBe(true)
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(1)
  })

  it('runOver fires only once — a second missionSystem pass is a no-op under the gameOver guard', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    w.revivesLeft = 0
    kill(w, p)
    missionSystem(w)
    const eventsBefore = w.events.length
    missionSystem(w)
    expect(w.events.length).toBe(eventsBefore) // guard returns early
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(1)
  })

  it('CASUAL: a lone player going down never ends the run, even repeatedly (kid mode)', () => {
    const cw = createWorld(1, 1, 'casual')
    const p = spawnPlayer(cw, 0, 20, 20)
    cw.revivesLeft = 0 // irrelevant in casual
    kill(cw, p)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeDefined()
    missionSystem(cw)
    expect(cw.gameOver).toBe(false)
  })

  it('CO-OP: one down + one standing does NOT end the run', () => {
    const p0 = spawnPlayer(w, 0, 20, 20)
    spawnPlayer(w, 1, 21, 20)
    kill(w, p0)
    missionSystem(w)
    expect(w.gameOver).toBe(false)
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(0)
  })

  it('CO-OP: the party fully wiped (all downed) is a run-over', () => {
    const p0 = spawnPlayer(w, 0, 20, 20)
    const p1 = spawnPlayer(w, 1, 21, 20)
    kill(w, p0)
    kill(w, p1)
    missionSystem(w)
    expect(w.gameOver).toBe(true)
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(1)
  })

  it('CO-OP: a mix of downed and dead players (both out of action) is a run-over', () => {
    const p0 = spawnPlayer(w, 0, 20, 20)
    const p1 = spawnPlayer(w, 1, 21, 20)
    kill(w, p0) // downed
    p1.dead = true // bled out earlier this tick, not yet swept
    missionSystem(w)
    expect(w.gameOver).toBe(true)
  })

  it('no players in the world → never a run-over (guarded against the empty-every trap)', () => {
    npc(w, 20, 20) // NPC only
    missionSystem(w)
    expect(w.gameOver).toBe(false)
  })
})
