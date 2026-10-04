// Golden digests for sequenced casting: a real floor, a pistol wand of three
// casts, 400 ticks of held fire with a sweeping aim and a reorder request every
// 37th tick. Any change to what a pull fires, to the reorder input, or to the
// per-weapon cast state moves these digests. Re-pin one only for a deliberate
// sim change, and say in the comment what reproduces the old value.

import { describe, expect, it } from 'vitest'
import { worldDigest } from '../../debug/worldDigest'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { playerSpawnPoint } from '../spawnPlacement'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { weaponStack } from './inventory'
import { setupFloor } from './missions'

/** FNV-1a over a string: a short, stable fingerprint of a (long) digest. */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A real floor with a player whose pistol carries a mixed bag of mods, in
 * pickup order, the way a draft would have left it: three casts,
 * [incendiary] [overload x2, frost] [pierce]. */
const buildRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  const p = spawnPlayer(w, 0, at.x, at.y)
  p.loadout!.inventory[0].mods = [
    { id: 'incendiary', stacks: 1 },
    { id: 'overload', stacks: 2 },
    { id: 'frost', stacks: 1 },
    { id: 'pierce', stacks: 1 },
  ]
  return w
}

/** Hold fire while sweeping aim in a slow circle; every 37th tick also ask to
 * swap two mod slots. */
const inputAt = (t: number): InputCmd => {
  const a = t * 0.07
  const cmd = { ...emptyInput(), seq: t, attack: true, aimX: Math.cos(a), aimY: Math.sin(a), moveX: Math.sin(t * 0.01) * 0.3 }
  return t % 37 === 0 ? ({ ...cmd, modSwap: ((t % 4) << 8) | ((t + 1) % 4) } as InputCmd) : cmd
}

const run = (seed: number, ticks: number): World => {
  const w = buildRun(seed)
  for (let t = 1; t <= ticks; t++) tickWorld(w, new Map([[0, inputAt(t)]]))
  return w
}

describe('sequenced casting: golden digests', () => {
  // Captured when sequencing became the only way guns fire. These seeds and
  // this exact scenario were the flag-off goldens (a13b7b25, e92bcf60), which
  // pinned the old fold-everything-into-every-shot path. Restoring that fold
  // (fireWeapon firing the whole list as one cast, the reorder input ignored,
  // resolveWeapon's newest-element pick) reproduces both old digests.
  const GOLDEN: Record<number, string> = {
    7: 'ee39480f',
    1234: '5930fe81',
  }

  for (const seed of [7, 1234]) {
    it(`seed ${seed}: 400 ticks of fire and swap requests digest exactly`, () => {
      const w = run(seed, 400)
      expect(fnv1a(worldDigest(w))).toBe(GOLDEN[seed])
    })
  }

  it('the scenario really fires modded rounds (so the digests cover the fire path)', () => {
    const w = buildRun(7)
    const seen = new Set<number>()
    for (let t = 1; t <= 120; t++) {
      tickWorld(w, new Map([[0, inputAt(t)]]))
      for (const e of w.entities) if (e.projectile?.mods?.length) seen.add(e.id)
    }
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })

  it('the scenario walks the wand: the index advances, wraps, and recharges', () => {
    const w = buildRun(7)
    const p = w.entities.find((e) => e.playerCtl)!
    const indices = new Set<number>()
    let recharged = false
    for (let t = 1; t <= 200; t++) {
      tickWorld(w, new Map([[0, inputAt(t)]]))
      const stack = weaponStack(p)!
      indices.add(stack.castIndex ?? -1)
      if (stack.rechargeUntil !== undefined) recharged = true
    }
    for (const i of [0, 1, 2]) expect(indices.has(i), `castIndex ${i}`).toBe(true)
    expect(recharged).toBe(true)
  })
})
