// Mash-out-of-shock: pressing dodge while ELECTRIFIED can't start a roll (you're
// immobilised), but each press shakes SHOCK_SHAKE_TICKS off the shock — clearing
// it outright when less than a chunk remains. Adversarial coverage: exact tick
// math, clear-at-clamp (no underflow), immobilise/roll-cooldown gates don't
// swallow the press, only electrified responds, NPC/downed immunity, that a
// cleared shock frees the body, and a byte-identical serialize round-trip.

import { beforeEach, describe, expect, it } from 'vitest'
import { ELEMENTS } from '../data/elements'
import type { Entity } from '../entity'
import { makeEntity } from '../entity'
import { spawnPlayer } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { ROLL_TICKS, SHOCK_SHAKE_TICKS, rollSystem } from './roll'
import { addStatus, hasStatus, isImmobilized } from './statusFx'

const rollCmd = (): Map<number, InputCmd> => new Map([[0, { ...emptyInput(), roll: true }]])
const noInput = (): Map<number, InputCmd> => new Map([[0, emptyInput()]])

const player = (w: World): Entity => {
  const s = w.level.spawn
  const p = spawnPlayer(w, 0, s.x, s.y)
  p.health!.iframes = 0
  return p
}

describe('dodge shakes off electric shock — exact tick math', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('sanity: the environmental zap is 30 ticks and one shake is 8', () => {
    expect(ELEMENTS.electrified.durationTicks).toBe(30)
    expect(SHOCK_SHAKE_TICKS).toBe(8)
  })

  it('one dodge press cuts exactly SHOCK_SHAKE_TICKS off the remaining shock', () => {
    addStatus(w, p, 'electrified', 45) // a Tesla-round hit
    const until0 = p.fx!.electrified.until
    rollSystem(w, rollCmd())
    expect(p.fx!.electrified.until).toBe(until0 - SHOCK_SHAKE_TICKS)
    expect(hasStatus(p, 'electrified')).toBe(true)
  })

  it('a shock with <= SHOCK_SHAKE_TICKS left is cleared outright — no underflow', () => {
    addStatus(w, p, 'electrified', SHOCK_SHAKE_TICKS)
    rollSystem(w, rollCmd())
    expect(hasStatus(p, 'electrified')).toBe(false)
  })

  it('mashing dodge clears a full 30-tick zap in ceil(30/8) = 4 presses', () => {
    addStatus(w, p, 'electrified', ELEMENTS.electrified.durationTicks)
    // Discrete presses (edge-triggered upstream): press, release, repeat. No
    // world time passes between them here, so the arithmetic is exact.
    for (let i = 0; i < 3; i++) {
      rollSystem(w, rollCmd())
      expect(hasStatus(p, 'electrified')).toBe(true) // 30→22→14→6 still shocked
    }
    rollSystem(w, rollCmd()) // 6 <= 8 → cleared
    expect(hasStatus(p, 'electrified')).toBe(false)
  })

  it('no dodge press → the shock is untouched (it must be a deliberate press)', () => {
    addStatus(w, p, 'electrified', 30)
    const until0 = p.fx!.electrified.until
    rollSystem(w, noInput())
    expect(p.fx!.electrified.until).toBe(until0)
  })
})

describe('dodge shakes off electric shock — gates and adversaries', () => {
  let w: World
  let p: Entity
  beforeEach(() => {
    w = createWorld(1, 1)
    p = player(w)
  })

  it('the shake does NOT start a roll (you are immobilised) — no roll object appears', () => {
    addStatus(w, p, 'electrified', 30)
    rollSystem(w, rollCmd())
    expect(p.playerCtl!.roll).toBeUndefined()
  })

  it('clearing the shock frees the body — isImmobilized flips false', () => {
    addStatus(w, p, 'electrified', SHOCK_SHAKE_TICKS)
    expect(isImmobilized(p)).toBe(true)
    rollSystem(w, rollCmd())
    expect(isImmobilized(p)).toBe(false)
  })

  it('works even while a spent roll is still cooling down (gate does not swallow it)', () => {
    // Start a real roll, then get shocked during its cooldown window: the roll
    // object still exists, but a dodge press must still shake the shock.
    rollSystem(w, rollCmd()) // roll starts; pc.roll set, cooling down
    expect(p.playerCtl!.roll).toBeDefined()
    addStatus(w, p, 'electrified', 30)
    const until0 = p.fx!.electrified.until
    rollSystem(w, rollCmd())
    expect(p.fx!.electrified.until).toBe(until0 - SHOCK_SHAKE_TICKS)
  })

  it('only electrified responds — frozen and other statuses are not shaken', () => {
    addStatus(w, p, 'frozen', 30)
    addStatus(w, p, 'poisoned', 30)
    const frozen = p.fx!.frozen.until
    const poison = p.fx!.poisoned.until
    rollSystem(w, rollCmd())
    expect(p.fx!.frozen.until).toBe(frozen) // frozen is a different CantDoAnything
    expect(p.fx!.poisoned.until).toBe(poison)
  })

  it('an electrified NPC cannot shake — nothing without playerCtl responds', () => {
    const npc = addEntity(w, makeEntity('npc', 'thug', p.pos.x + 3, p.pos.y))
    npc.health = { hp: 30, max: 30, iframes: 0 }
    addStatus(w, npc, 'electrified', 30)
    const until0 = npc.fx!.electrified.until
    rollSystem(w, rollCmd())
    expect(npc.fx!.electrified.until).toBe(until0)
  })

  it('a downed player cannot shake', () => {
    addStatus(w, p, 'electrified', 30)
    p.playerCtl!.downed = { bleedTicks: 300, reviveProgress: 0 }
    const until0 = p.fx!.electrified.until
    rollSystem(w, rollCmd())
    expect(p.fx!.electrified.until).toBe(until0)
  })
})

describe('dodge shakes off electric shock — determinism', () => {
  it('mid-shock-shake round-trips byte-identical and continues identically', () => {
    const w = createWorld(7, 1)
    const p = player(w)
    addStatus(w, p, 'electrified', 30)
    tickWorld(w, rollCmd()) // one shake lands inside a real tick

    const json = serializeWorld(w)
    const restored = deserializeWorld(JSON.parse(JSON.stringify(json)))
    expect(JSON.stringify(serializeWorld(restored))).toBe(JSON.stringify(json))

    const script = (t: number): Map<number, InputCmd> => (t % 2 === 0 ? rollCmd() : noInput())
    for (let i = 0; i < ROLL_TICKS * 3; i++) {
      tickWorld(w, script(i))
      tickWorld(restored, script(i))
    }
    expect(JSON.stringify(serializeWorld(restored))).toBe(JSON.stringify(serializeWorld(w)))
    const rp = restored.entities.find((e) => e.playerCtl)!
    expect(hasStatus(rp, 'electrified')).toBe(false) // and the shake actually resolved
  })
})
