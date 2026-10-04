// Deep-floor Sporefall mission generation (floors 5+), the no-dead-end gate
// guarantee, determinism, and proof that shallow floors are untouched (the
// frozen steal/assassinate placement table must stay byte-identical).

import { describe, expect, it } from 'vitest'
import { isSolidTile } from '../levelgen/level'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import { detonate } from './combat'
import { setupFloor } from './missions'

const idle = (...ids: number[]): Map<number, Partial<InputCmd>> => new Map(ids.map((id) => [id, emptyInput()]))

const boot = (seed: number, floor: number): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  return w
}

/** Tile BFS from spawn — doors are Floor tiles, so this is pure walkability. */
const reaches = (w: World, tx: number, ty: number): boolean => {
  const { w: W, h: H } = w.level
  const seen = new Uint8Array(W * H)
  const q = [Math.floor(w.level.spawn.y) * W + Math.floor(w.level.spawn.x)]
  seen[q[0]] = 1
  while (q.length) {
    const i = q.pop()!
    const x = i % W
    const y = (i / W) | 0
    if (x === tx && y === ty) return true
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const ni = ny * W + nx
      if (seen[ni] || isSolidTile(w.level, nx, ny)) continue
      seen[ni] = 1
      q.push(ni)
    }
  }
  return false
}

describe('deep floors field Sporefall objectives', () => {
  it('both contain and infiltrate appear on floors 5+', () => {
    const seen = new Set<string>()
    for (let seed = 1; seed <= 60 && seen.size < 2; seed++) {
      for (const floor of [5, 6, 7, 8]) {
        const w = boot(seed, floor)
        if (w.mission.template === 'contain' || w.mission.template === 'infiltrate') seen.add(w.mission.template)
      }
    }
    expect(seen.has('contain')).toBe(true)
    expect(seen.has('infiltrate')).toBe(true)
  })

  it('every deep mission target exists, is reachable, and its gateway is a breachable seal', () => {
    let checked = 0
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [5, 6]) {
        const w = boot(seed, floor)
        if (w.mission.template !== 'contain' && w.mission.template !== 'infiltrate') continue
        checked++
        const ctx = `seed=${seed} floor=${floor} ${w.mission.template}`
        const target = w.byId.get(w.mission.targetEntityId!)
        expect(target, `${ctx}: target missing`).toBeTruthy()
        expect(reaches(w, Math.floor(target!.pos.x), Math.floor(target!.pos.y)), `${ctx}: target unreachable`).toBe(true)

        // The building's gateway is genuinely sealed (biolock or overgrown)…
        const b = w.level.buildings[w.mission.targetBuilding!]
        const doors = w.entities.filter(
          (e) => e.door && b.doors.some((d) => d.x === Math.floor(e.pos.x) && d.y === Math.floor(e.pos.y)),
        )
        const sealed = doors.filter((e) => e.door!.sealKind !== undefined || e.door!.overgrown)
        expect(sealed.length, `${ctx}: no sealed gateway`).toBeGreaterThanOrEqual(1)

        // …and every sealed gateway yields to a breach (never a dead-end).
        for (const s of sealed) {
          detonate(w, s.pos.x, s.pos.y, 1.8, 40, 1)
          expect(s.door!.open, `${ctx}: gateway un-breachable`).toBe(true)
        }
      }
    }
    expect(checked).toBeGreaterThan(5) // the sweep actually exercised deep missions
  })
})

describe('determinism', () => {
  it('two worlds restored from one deep-floor snapshot stay byte-identical for 120 ticks', () => {
    const w = boot(7, 5)
    const j = serializeWorld(w)
    const a = deserializeWorld(j)
    const b = deserializeWorld(j)
    runTicks(a, idle(0), 120)
    runTicks(b, idle(0), 120)
    expectWorldEqual(a, b)
  })

  it('same seed+floor regenerates the identical mission + gateway seal + prop placement', () => {
    const a = boot(11, 5)
    const b = boot(11, 5)
    expectWorldEqual(a, b)
  })
})

describe('shallow floors are untouched (the frozen table holds)', () => {
  it('floors 1-4 only ever produce steal / assassinate / reach — never the deep templates', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [1, 2, 3, 4]) {
        const w = createWorld(seed, floor)
        setupFloor(w)
        expect(['steal', 'assassinate', 'reach']).toContain(w.mission.template)
      }
    }
  })

  it('a floor-1 world with no seals still ticks cleanly (the tutorial city is unchanged)', () => {
    const w = boot(3, 1)
    tickWorld(w, new Map([[0, emptyInput()]]))
    expect(w.tick).toBe(1)
  })
})
