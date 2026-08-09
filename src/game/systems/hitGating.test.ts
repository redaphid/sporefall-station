// One root cause, three bugs: NOTHING told a caller whether `applyDamage` had
// actually landed. i-frames, the dodge-roll and the downed state suppressed the
// DAMAGE only, so every other consequence of a hit — the element, the lifesteal
// heal, the mod trigger — fired anyway on blows that never connected.
//
// Symptoms this file guards against coming back:
//   1. You dodge-roll through a sledgehammer swing, take no damage, get stunned.
//   2. Lifesteal heals off i-framed pellets: measured +23.5hp healed for 12.0
//      damage dealt, i.e. a build that outheals its own output.
//   3. Mod triggers fire on hits that were voided.
//
// Plus the missing anti-chain-lock on the legacy `stun`/`sleep` counters, which
// is what made symptom 1 unescapable rather than merely annoying.

import { beforeEach, describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { addEntity, createWorld, type World } from '../world'
import { applyDamage } from './combat'
import { isRolling } from './roll'
import { applyStatus, hasStatus } from './statusFx'

const body = (w: World, hp = 100): Entity => {
  const e = addEntity(w, makeEntity('npc', 'civilian', 20, 20))
  e.health = { hp, max: hp, iframes: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  return e
}

describe('applyDamage reports whether the blow LANDED', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1)
  })

  it('returns true for an ordinary connecting hit', () => {
    const e = body(w)
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBe(true)
    expect(e.health!.hp).toBe(90)
  })

  it('returns FALSE when i-frames swallow the hit', () => {
    const e = body(w)
    e.health!.iframes = 3
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBe(false)
    expect(e.health!.hp).toBe(100)
  })

  it('returns FALSE for a dead target', () => {
    const e = body(w)
    e.dead = true
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBe(false)
  })

  it('returns FALSE while the target is dodge-rolling', () => {
    // The i-frame window of a real roll. This is the case that let a rolled-through
    // sledgehammer still land its stun.
    const e = body(w)
    e.playerCtl = { playerId: 0, abilityCooldown: 0, crimeUntilTick: 0, roll: { untilTick: w.tick + 10, cooldownUntilTick: w.tick + 99, dirX: 1, dirY: 0 } }
    expect(isRolling(e, w.tick)).toBe(true)
    expect(applyDamage(w, e, 10, 0, 0, 0, 99)).toBe(false)
    expect(e.health!.hp).toBe(100)
  })

  it('still returns true when a landed blow deals zero after resist', () => {
    // A landed-but-harmless blow is still a LANDED blow: it takes i-frames and
    // interrupts regen, so its on-hit effects should fire.
    const e = body(w)
    expect(applyDamage(w, e, 0, 0, 0, 0, 99)).toBe(true)
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
