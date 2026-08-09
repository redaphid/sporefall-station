// One root cause, three bugs: NOTHING told a caller whether `applyDamage` had
// actually landed, or how much it dealt. i-frames, the dodge-roll and the downed
// state suppressed the DAMAGE only, so every other consequence of a hit — the
// element, the lifesteal heal, the mod trigger — fired anyway on blows that
// never connected. And lifesteal, having no way to read what was dealt, paid out
// on the bullet's INTENDED damage and never saw resist.
//
// Symptoms this file guards against coming back:
//   1. You dodge-roll through a sledgehammer swing, take no damage, get stunned.
//   2. Lifesteal heals off i-framed pellets: measured +23.5hp healed for 12.0
//      damage dealt, i.e. a build that outheals its own output.
//   3. Lifesteal ignores armour, paying ~3x too much against a 0.35 brute.
//   4. Mod triggers fire on hits that were voided.
//
// Plus the missing anti-chain-lock on the legacy `stun`/`sleep` counters, which
// is what made symptom 1 unescapable rather than merely annoying.

import { beforeEach, describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { makeEntity, type Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { applyDamage, fireWeapon } from './combat'
import { applyModPickup, weaponStack } from './inventory'
import { resolveWeapon } from './resolveWeapon'
import { isRolling } from './roll'
import { addStatus, applyStatus, hasStatus } from './statusFx'

const body = (w: World, hp = 100): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', 20, 20))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

describe('applyDamage reports HOW MUCH it dealt, or null if it never landed', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('returns the damage actually applied for an ordinary hit', () => {
    const e = body(w)
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBe(10)
    expect(e.health!.hp).toBe(90)
  })

  it('returns the RESISTED amount, not the intended amount', () => {
    // The number a damage-scaled effect (lifesteal) must key off. Reading the
    // intended 10 here is what paid a shooter in full for a blow an armoured
    // body mostly absorbed.
    const e = body(w)
    e.resist = { physical: 0.35 }
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBe(4) // round(10 * 0.35)
    expect(e.health!.hp).toBe(96)
  })

  it('returns NULL when i-frames swallow the hit', () => {
    const e = body(w)
    e.health!.iframes = 3
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBeNull()
    expect(e.health!.hp).toBe(100)
  })

  it('returns NULL for a dead target', () => {
    const e = body(w)
    e.dead = true
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBeNull()
  })

  it('returns NULL while the target is dodge-rolling', () => {
    // The i-frame window of a real roll. This is the case that let a rolled-through
    // sledgehammer still land its stun.
    const e = body(w)
    e.playerCtl = {
      playerId: 0,
      abilityCooldown: 0,
      cash: 0,
      crimeUntilTick: 0,
      roll: { untilTick: w.tick + 10, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 },
    }
    expect(isRolling(e, w.tick)).toBe(true)
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBeNull()
    expect(e.health!.hp).toBe(100)
  })

  // ── THE DISTINCTION THE RETURN TYPE EXISTS TO MAKE ────────────────────────
  // `0` and `null` are DIFFERENT EVENTS and every caller must compare, never
  // test truthiness. A zero-damage LANDED hit is a real thing — the freeze ray
  // deals 0 and exists purely for its status. If a caller writes `if (dealt)`
  // it reads that as blocked, and every 0-damage utility weapon silently stops
  // working: no throw, no red test elsewhere, and the UI still shows the mod.
  it('DISTINGUISHES a zero-damage LANDED hit from a BLOCKED hit', () => {
    const landedForZero = body(w)
    const blocked = body(w)
    blocked.health!.iframes = 3

    const a = applyDamage(w, landedForZero, 0, 0, 0, 0, 99)
    const b = applyDamage(w, blocked, 10, 0, 0, 0, 99)

    expect(a).toBe(0) // landed, dealt nothing
    expect(b).toBeNull() // never landed at all
    expect(a).not.toBe(b) // and they are not the same value
    // The landed one took i-frames; the blocked one changed nothing.
    expect(landedForZero.health!.iframes).toBeGreaterThan(0)
    expect(blocked.health!.hp).toBe(100)
  })

  it('a shatter reports 0 dealt — the ice killed it, not the blow', () => {
    // Guards against a NEW exploit created by the fix: if shatter reported the
    // victim's whole hp pool as "dealt", one lifesteal round would heal a boss's
    // entire lifebar off a grenade somebody else threw.
    const e = body(w, 320)
    addStatus(w, e, 'frozen', 120)
    expect(applyDamage(w, e, 1, 0, 0, 0, 99)).toBe(0)
    expect(e.dead).toBe(true)
  })
})

// Unit-testing `applyDamage` in isolation cannot catch a CALLER that compares
// wrongly, and the caller is where both historical bugs actually lived. These
// drive the real fire path.
describe('callers read the result correctly (the bugs lived here, not in applyDamage)', () => {
  /**
   * Fire a modded pistol at `arch` for `ticks` and report what moved.
   *
   * The foe is DISARMED and IMMOBILISED (no `combat`, no `ai`) and pinned in
   * place. That is load-bearing, not tidiness: a live brute hits back, and the
   * player's net hp change then mixes lifesteal healing with incoming melee
   * damage. The first version of this test did exactly that, and as a result it
   * stayed green when the bug was deliberately reintroduced — it was measuring
   * the sum of two effects rather than the one under test.
   */
  const fireAt = (mods: string[], arch: string, ticks: number) => {
    const w = createWorld(9, 1)
    const sp = w.level.spawn
    const p = spawnPlayer(w, 0, sp.x, sp.y)
    let foe: Entity | undefined
    for (const [dx, dy] of [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
      [3, 0],
    ] as const) {
      foe = spawnNpc(w, arch, sp.x + dx, sp.y + dy)
      if (foe) break
    }
    if (!p || !foe?.health) throw new Error('probe setup failed')
    for (const m of mods) applyModPickup(p, m)
    foe.combat = undefined // cannot hit back
    foe.ai = undefined // cannot walk away
    const foeX = foe.pos.x
    const foeY = foe.pos.y
    foe.health.hp = 100000 // a pool the probe cannot clear, so it never stops
    foe.health.max = 100000
    p.health!.max = 100000 // headroom so the heal is never clamped away
    p.health!.hp = 10
    const foeHp0 = foe.health.hp
    const pHp0 = p.health!.hp
    for (let t = 0; t < ticks; t++) {
      foe.pos.x = foeX
      foe.pos.y = foeY
      const dx = foe.pos.x - p.pos.x
      const dy = foe.pos.y - p.pos.y
      const len = Math.hypot(dx, dy) || 1
      tickWorld(w, new Map([[0, { ...emptyInput(), attack: true, aimX: dx / len, aimY: dy / len }]]))
    }
    const stack = weaponStack(p)
    const frac = resolveWeapon(WEAPONS[p.combat!.weapon], stack?.mods).behavior.lifestealFrac
    return { dealt: foeHp0 - foe.health.hp, healed: p.health!.hp - pHp0, frac }
  }

  it('LIFESTEAL pays out on damage DEALT, not on damage intended', () => {
    // Against an armoured target these two differ by the resist multiplier, and
    // that gap is the bug: a brute's 0.35 plating absorbed 65% of every blow
    // while the shooter was still paid for the full 100%.
    //
    // NOTE the assertion has to compare against the CORRECT payout, not merely
    // check "healed < dealt". An earlier version asserted the looser thing and
    // stayed GREEN when the bug was deliberately reintroduced — with the
    // landed-gate already in place the remaining error is only the resist
    // factor, which is not large enough to push healing above damage. A test
    // that cannot fail is not measuring anything.
    const { dealt, healed, frac } = fireAt(['lifesteal', 'bulk', 'bulk'], 'brute', 40)
    expect(dealt).toBeGreaterThan(0)
    expect(healed).toBeGreaterThan(0) // the mod still works
    // Correct payout is dealt x frac. The bug pays intended x frac, and against
    // 0.35 armour that is nearly 3x too much, so this bound separates them.
    expect(healed).toBeLessThanOrEqual(dealt * frac * 1.2 + 1)
  })

  it('a 0-damage utility hit STILL applies its status through the real fire path', () => {
    // The freeze ray deals 0 and exists only for its status. A caller that tested
    // truthiness instead of `!== null` would silently break every weapon like it.
    const w = createWorld(3, 1)
    const sp = w.level.spawn
    const shooter = spawnNpc(w, 'gangster', sp.x + 3, sp.y)
    const victim = spawnNpc(w, 'civilian', sp.x + 5, sp.y)
    if (!shooter || !victim) throw new Error('probe setup failed')
    shooter.combat!.weapon = 'freezeRay'
    expect(WEAPONS.freezeRay.damage).toBe(0) // the premise of this test
    shooter.facing = Math.atan2(victim.pos.y - shooter.pos.y, victim.pos.x - shooter.pos.x)
    let froze = false
    for (let t = 0; t < 60 && !froze; t++) {
      shooter.combat!.cooldown = 0
      fireWeapon(w, shooter)
      tickWorld(w, new Map())
      if (hasStatus(victim, 'frozen')) froze = true
    }
    expect(froze).toBe(true)
  })
})

describe('the legacy stun/sleep counters get the anti-chain-lock too', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('a single isolated stun still bites for its full duration', () => {
    const e = body(w)
    applyStatus(w, e, 'stun', 20)
    expect(e.status!.stun).toBe(20)
  })

  it('cannot be refreshed while it is still running — the perma-lock is closed', () => {
    const e = body(w)
    applyStatus(w, e, 'stun', 20)
    e.status!.stun = 5 // some of it has ticked away
    w.tick += 4
    applyStatus(w, e, 'stun', 20) // a second sledgehammer lands mid-lock
    expect(e.status!.stun).toBe(5) // NOT reset back to 20
  })

  it('grants a guaranteed free window after a lock ends', () => {
    const e = body(w)
    applyStatus(w, e, 'stun', 20)
    w.tick += 21 // the lock has expired...
    e.status!.stun = 0
    applyStatus(w, e, 'stun', 20) // ...but the immunity window has not
    expect(e.status!.stun).toBe(0)
  })

  it('diminishes successive locks in one hot chain, so sustained pressure converges', () => {
    const e = body(w)
    applyStatus(w, e, 'stun', 20)
    const first = e.status!.stun
    w.tick += 20 + 18 + 1 // past the lock AND past the immunity, still "hot"
    e.status!.stun = 0
    applyStatus(w, e, 'stun', 20)
    expect(e.status!.stun).toBeGreaterThan(0)
    expect(e.status!.stun).toBeLessThan(first)
  })

  it('sleep is guarded on its own independent track', () => {
    const e = body(w)
    applyStatus(w, e, 'sleep', 180)
    expect(e.status!.sleep).toBe(180)
    e.status!.sleep = 100
    w.tick += 5
    applyStatus(w, e, 'sleep', 180) // a second chloroform mid-nap
    expect(e.status!.sleep).toBe(100) // not re-armed to 180
  })

  it('stun and sleep do not share a lockout track', () => {
    const e = body(w)
    applyStatus(w, e, 'stun', 20)
    applyStatus(w, e, 'sleep', 180)
    expect(e.status!.stun).toBe(20)
    expect(e.status!.sleep).toBe(180)
  })

  it('a status the guard does not cover is unaffected', () => {
    const e = body(w)
    applyStatus(w, e, 'burning', 60)
    expect(hasStatus(e, 'burning')).toBe(true)
  })
})
