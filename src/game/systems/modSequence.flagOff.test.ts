// Flag-off proof for the sequenced-mods prototype. The golden digests below
// were captured on `main` BEFORE any sequencing code existed. A world that has
// not opted into sequencing must reproduce them exactly, including when its
// inputs carry reorder requests that `main` had no idea about.
//
// If one of these fails, the prototype has leaked into the default path. Do not
// re-pin the digest; find the leak.

import { describe, expect, it } from 'vitest'
import { worldDigest } from '../../debug/worldDigest'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { playerSpawnPoint } from '../spawnPlacement'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
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
 * pickup order, the way a draft would have left it. */
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
 * swap two mod slots. `main` has no such input, so it must be inert here. */
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

describe('mod sequencing: flag off matches main', () => {
  // Captured on main @ 9d0894d with this exact file. Seed 7 re-captured for #87:
  // its incendiary rounds now make the burning target panic (a deliberate sim
  // change, not a sequencing leak). With panic disabled it still reproduced
  // 'deaefb3a' exactly, so nothing else moved.
  const GOLDEN: Record<number, string> = {
    7: 'ea5f5b29',
    1234: '6251b800',
  }

  for (const seed of [7, 1234]) {
    it(`seed ${seed}: 400 ticks of fire and swap requests digest exactly as on main`, () => {
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

  it('an unopted world never grows sequencing state', () => {
    const w = run(7, 200)
    const json = JSON.stringify(worldDigest(w))
    expect(json).not.toContain('castIndex')
    expect(json).not.toContain('rechargeUntil')
    expect(json).not.toContain('modCasting')
  })
})
