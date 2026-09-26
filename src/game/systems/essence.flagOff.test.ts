// Flag-off proof for the essence-bubbles prototype. The golden digests below
// were captured on origin/feat/playtest-step (the prototype's base) BEFORE any
// essence code existed, with this exact file. A sequenced world that has not
// opted into essence bubbles must reproduce them exactly, including when its
// inputs carry vent requests the base had no idea about.
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

const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A real floor 1, sequenced casting on, a pistol racked with both elements the
 * prototype cares about. */
const buildRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  w.modCasting = 'sequence'
  populateWorld(w)
  setupFloor(w)
  const at = playerSpawnPoint(w.level, 0)
  const p = spawnPlayer(w, 0, at.x, at.y)
  p.loadout!.inventory[0].mods = [
    { id: 'frost', stacks: 1 },
    { id: 'heavy', stacks: 1 },
    { id: 'shock', stacks: 1 },
    { id: 'split', stacks: 1 },
  ]
  return w
}

/** Hold fire while sweeping aim; every 29th tick also ask to vent (op 1) a
 * rack entry, and every 31st press interact. The base has no vent input, so a
 * world without the flag must ignore it. */
const inputAt = (t: number): InputCmd => {
  const a = t * 0.07
  const cmd: InputCmd = { ...emptyInput(), seq: t, attack: true, aimX: Math.cos(a), aimY: Math.sin(a), moveX: Math.sin(t * 0.01) * 0.3 }
  if (t % 31 === 0) cmd.interact = true
  return t % 29 === 0 ? ({ ...cmd, still: (1 << 8) | (t % 4) } as InputCmd) : cmd
}

const run = (seed: number, ticks: number): World => {
  const w = buildRun(seed)
  for (let t = 1; t <= ticks; t++) tickWorld(w, new Map([[0, inputAt(t)]]))
  return w
}

describe('essence bubbles: flag off matches the base', () => {
  // Captured on origin/feat/playtest-step @ e6ef647 with this exact file.
  const GOLDEN: Record<number, string> = {
    7: '755bf2f9',
    1234: '598fe9a1',
  }

  for (const seed of [7, 1234]) {
    it(`seed ${seed}: 400 sequenced ticks of fire and vent requests digest exactly as on the base`, () => {
      expect(fnv1a(worldDigest(run(seed, 400)))).toBe(GOLDEN[seed])
    })
  }

  it('the run really fires elemental rounds (so the digests cover the hit path)', () => {
    const w = buildRun(7)
    const seen = new Set<string>()
    for (let t = 1; t <= 120; t++) {
      tickWorld(w, new Map([[0, inputAt(t)]]))
      for (const e of w.entities) if (e.projectile?.onHit) seen.add(e.projectile.onHit.status)
    }
    expect([...seen].sort()).toEqual(['electrified', 'frozen'])
  })
})
