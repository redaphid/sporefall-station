// Feature: INFINITE_AMMO — a TEMPORARY, testing-only toggle (systems/combat.ts).
// While ON, firing a RANGED weapon does not decrement ammo and the gun never
// reads as empty, so it always fires (effectively infinite ammo). While OFF, the
// normal finite economy is restored byte-for-byte. These tests set world state
// exactly, run the REAL combat system / full tick pipeline, and assert — covering
// the degenerate cases (empty mag, firing far past the magazine) and determinism.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { spawnPlayer, STARTER_AMMO } from '../player'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { combatSystem, INFINITE_AMMO } from './combat'
import { spendAmmo } from './inventory'

/** A one-slot input map with `attack` (the fire button) pressed. */
const fire = (extra: Partial<InputCmd> = {}): Map<number, InputCmd> =>
  new Map([[0, { ...emptyInput(), attack: true, ...extra }]])

/** A player on the guaranteed-open spawn tile, facing +x. */
const player = (w: World, id = 0): Entity => {
  const p = spawnPlayer(w, id, w.level.spawn.x, w.level.spawn.y)
  p.facing = 0
  return p
}

const bullets = (w: World): Entity[] =>
  w.entities.filter((e) => e.kind === 'projectile' && !e.dead && e.archetype === 'projectile')

/** Fire `n` times, resetting the per-shot cooldown between calls so every press
 * lands (mirrors the cadence-independent firing used across the combat tests). */
const fireN = (w: World, p: Entity, n: number): void => {
  for (let i = 0; i < n; i++) {
    combatSystem(w, fire())
    p.combat!.cooldown = 0
  }
}

describe('INFINITE_AMMO toggle — the temporary testing state', () => {
  // These assertions describe the CURRENT (toggle-ON) behavior. If the owner
  // flips INFINITE_AMMO off, this block is inert and the OFF-economy block below
  // (plus the finite-economy tests across the suite) takes over.
  describe.runIf(INFINITE_AMMO)('while ON: ranged weapons never deplete or run dry', () => {
    let w: World
    let p: Entity
    beforeEach(() => {
      w = createWorld(1, 1)
      p = player(w)
    })

    it('firing far past the magazine leaves ammo unchanged and keeps spawning bullets', () => {
      const mag = 5
      p.loadout!.inventory = [{ itemId: 'pistol', qty: mag }]
      p.loadout!.activeSlot = 0
      const shots = mag * 8 // 40 presses on a 5-round mag
      fireN(w, p, shots)
      expect(bullets(w)).toHaveLength(shots) // bullets keep coming past the old mag
      expect(p.loadout!.inventory[0].qty).toBe(mag) // ...and the mag never dropped
    })

    it('an already-empty mag (qty 0) still fires — the gun never reads as out-of-ammo', () => {
      p.loadout!.inventory = [{ itemId: 'pistol', qty: 0 }]
      p.loadout!.activeSlot = 0
      fireN(w, p, 10)
      expect(bullets(w)).toHaveLength(10)
      expect(p.loadout!.inventory[0].qty).toBe(0) // stays 0, never goes negative
    })

    it('an automatic weapon (machinegun) empties nothing across a long burst', () => {
      p.combat!.weapon = 'machinegun'
      p.loadout!.inventory = [{ itemId: 'machinegun', qty: 3 }]
      p.loadout!.activeSlot = 0
      fireN(w, p, 30)
      expect(bullets(w)).toHaveLength(30)
      expect(p.loadout!.inventory[0].qty).toBe(3)
    })

    it('the default STARTER_AMMO loadout never draws down', () => {
      // Default pistol loadout carries STARTER_AMMO; fire more than a full mag.
      fireN(w, p, STARTER_AMMO + 25)
      expect(p.loadout!.inventory[0].qty).toBe(STARTER_AMMO)
      expect(bullets(w).length).toBeGreaterThan(STARTER_AMMO) // past the old cap
    })
  })

  // Guard the NORMAL (finite) economy so flipping the toggle off is a byte-exact
  // revert: run the real fire path with a tiny mag and assert it depletes and then
  // clicks empty. Inert while the toggle is ON.
  describe.runIf(!INFINITE_AMMO)('while OFF: the finite ammo economy is intact', () => {
    it('firing depletes the mag and an empty gun then produces no bullet', () => {
      const w = createWorld(1, 1)
      const p = player(w)
      p.loadout!.inventory = [{ itemId: 'pistol', qty: 2 }]
      p.loadout!.activeSlot = 0
      fireN(w, p, 2)
      expect(p.loadout!.inventory[0].qty).toBe(0)
      expect(bullets(w)).toHaveLength(2)
      combatSystem(w, fire()) // empty mag → dry click, no shot
      expect(bullets(w)).toHaveLength(2)
    })
  })

  // Toggle-INDEPENDENT: the pure ammo primitive is untouched by the gate, so the
  // economy it implements is always available to restore. This holds in BOTH
  // states — it proves the toggle only bypasses the CALL, not the mechanism.
  it('spendAmmo itself still decrements and empties (mechanism preserved either way)', () => {
    const w = createWorld(1, 1)
    const p = player(w)
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 2 }]
    p.loadout!.activeSlot = 0
    expect(spendAmmo(p)).toBe(true)
    expect(p.loadout!.inventory[0].qty).toBe(1)
    expect(spendAmmo(p)).toBe(true)
    expect(p.loadout!.inventory[0].qty).toBe(0)
    expect(spendAmmo(p)).toBe(false) // empty → clicks
  })

  it('firing under the toggle round-trips and replays byte-identically (determinism)', () => {
    const w = createWorld(7, 1)
    const p = player(w)
    p.loadout!.inventory = [{ itemId: 'pistol', qty: 3 }]
    p.loadout!.activeSlot = 0
    tickWorld(w, fire()) // one real tick with the fire button down
    const json = serializeWorld(w)
    const a = deserializeWorld(json)
    const b = deserializeWorld(json)
    for (let i = 0; i < 20; i++) {
      tickWorld(a, fire())
      tickWorld(b, fire())
    }
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})
