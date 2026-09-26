// The bullet's look is composed from its provenance, so it must match what the
// round does on a hit: its own cast, never another cast's element. Fires the
// first pull through the real combat system, then composes the look with the
// renderer's own pure function (the same call bullets.ts makes).

import { describe, expect, it } from 'vitest'
import type { WeaponMod } from '../game/entity'
import { spawnPlayer } from '../game/player'
import { combatSystem } from '../game/systems/combat'
import { arm } from '../game/testkit'
import { emptyInput } from '../game/types'
import { createWorld } from '../game/world'
import { composeBulletTraits, type BulletTraits } from './bulletVisuals'

const m = (id: string, stacks = 1): WeaponMod => ({ id, stacks })

const lookOfShot = (mods: WeaponMod[]): BulletTraits => {
  const w = createWorld(1, 1)
  const p = spawnPlayer(w, 0, 20, 20)
  p.loadout!.inventory = []
  arm(p, 'pistol').mods = mods
  p.facing = 0
  combatSystem(w, new Map([[0, { ...emptyInput(), attack: true }]]))
  const round = w.entities.find((e) => e.kind === 'projectile')!
  return composeBulletTraits(round.projectile!.mods)
}

describe('a round looks like the element it applies', () => {
  it('Tesla then Cryo and Cryo then Tesla open with different looks', () => {
    const zaps = lookOfShot([m('shock'), m('frost')])
    const freezes = lookOfShot([m('frost'), m('shock')])
    expect(freezes.color).not.toBe(zaps.color)
    expect(freezes.glowColor).not.toBe(zaps.glowColor)
    expect(freezes.jitter).not.toBe(zaps.jitter)
  })

  it('the first round of Tesla then Cryo looks exactly like a Tesla-only round', () => {
    expect(lookOfShot([m('shock'), m('frost')])).toEqual(lookOfShot([m('shock')]))
  })

  it('the first round of Cryo then Tesla looks exactly like a Cryo-only round', () => {
    expect(lookOfShot([m('frost'), m('shock')])).toEqual(lookOfShot([m('frost')]))
  })

  it("with modifiers mixed in, a round looks like its own cast and nothing after it", () => {
    const first = lookOfShot([m('pierce', 2), m('rapid'), m('frost'), m('incendiary'), m('shock')])
    expect(first).toEqual(lookOfShot([m('pierce', 2), m('rapid'), m('frost')]))
  })
})
