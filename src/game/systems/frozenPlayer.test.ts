// Regression: "I can die in 1-2 hits right at the beginning… it's when I freeze."
//
// `applyDamage` opened with `if (isFrozen(target)) return shatter(w, target)`,
// and `shatter` is an INSTANT KILL regardless of the blow's damage. That applied
// to players. Enemies carry freeze rays and freeze grenades (120 ticks — four
// seconds — of total immobilisation), so the sequence was:
//
//     enemy freezes you → ANY enemy lands ANY hit → you are downed
//
// with no counterplay, because being frozen is precisely the state in which you
// cannot dodge, roll or retreat. It only became visible when the station alert
// started sending the whole floor at the player at once.
//
// A player now cracks free instead: the freeze breaks and the blow does ordinary
// damage. Enemies still shatter, so freeze is still an execute in the player's
// hands.

import { describe, expect, it } from 'vitest'
import { spawnNpc } from '../populate'
import { addStatus, isFrozen } from './statusFx'
import { applyDamage } from './combat'
import { createWorld } from '../world'
import { spawnPlayer } from '../player'

const arena = () => {
  const w = createWorld(1, 1, 'normal', false)
  return w
}

/** A real player entity via the real spawn path, at a known health. */
const addPlayer = (w: ReturnType<typeof arena>, hp = 100) => {
  const p = spawnPlayer(w, 0, 5.5, 5.5)
  p.health = { hp, max: 100, iframes: 0 }
  return p
}

describe('a frozen PLAYER is not shattered', () => {
  it('takes ordinary damage instead of being instantly downed', () => {
    const w = arena()
    const p = addPlayer(w, 100)
    addStatus(w, p, 'frozen', 120)
    expect(isFrozen(p)).toBe(true)

    applyDamage(w, p, 12, 0, 0, 0, -1)

    // THE regression: this used to be hp 0 + downed from a 12-damage hit.
    expect(p.health!.hp).toBeGreaterThan(0)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeFalsy()
  })

  it('the blow cracks the ice, so a second hit is not another free execute', () => {
    const w = arena()
    const p = addPlayer(w, 100)
    addStatus(w, p, 'frozen', 120)

    applyDamage(w, p, 10, 0, 0, 0, -1)
    // Freed by the impact — not still a statue waiting to be executed.
    expect(isFrozen(p)).toBe(false)

    const afterFirst = p.health!.hp
    p.health!.iframes = 0 // ignore i-frame spacing; we care about the shatter rule
    applyDamage(w, p, 10, 0, 0, 0, -1)
    expect(p.health!.hp).toBeLessThan(afterFirst) // it hurt…
    expect(p.playerCtl!.downed).toBeFalsy() // …but did not execute
  })

  it('survives a burst that would previously have downed it instantly', () => {
    const w = arena()
    const p = addPlayer(w, 100)
    addStatus(w, p, 'frozen', 120)
    for (let i = 0; i < 3; i++) {
      p.health!.iframes = 0
      applyDamage(w, p, 8, 0, 0, 0, -1)
    }
    expect(p.playerCtl!.downed).toBeFalsy()
    expect(p.health!.hp).toBeGreaterThan(0)
  })
})

describe('a frozen ENEMY still shatters', () => {
  it('is executed by a solid impact, so freeze stays a player tool', () => {
    const w = arena()
    const npc = spawnNpc(w, 'thug', 8.5, 8.5)
    npc.health = { hp: 100, max: 100, iframes: 0 }
    addStatus(w, npc, 'frozen', 120)

    applyDamage(w, npc, 1, 0, 0, 0, -1) // a single point of damage

    expect(npc.health!.hp).toBe(0)
    expect(npc.dead).toBe(true)
  })
})
