// #65 — panic contagion / stampede. A fleeing or dying body throws a fear pulse
// nearby timid crew CATCH and flee from, re-emitting their own so terror rolls
// down a line as a wave — even with no first-hand sight of the threat. Hardened
// factions (gang/retaliators) don't stampede. Sets exact state, runs the REAL
// tickWorld, asserts the wave.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'

const line = (): { w: World; civs: ReturnType<typeof spawnNpc>[]; gang: ReturnType<typeof spawnNpc> } => {
  const w = createWorld(1, 1, 'normal', false) // peaceful — the only fear is contagious
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 3; y <= cy + 3; y++)
    for (let x = cx - 2; x <= cx + 30; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  const civs: ReturnType<typeof spawnNpc>[] = []
  for (let i = 0; i < 6; i++) {
    const e = spawnNpc(w, 'civilian', cx + i * 4, cy) // 4-tile spacing (< fear radius 5)
    e.health = { hp: 1e6, max: 1e6, iframes: 0 }
    e.ai!.sightRange = 4
    civs.push(e)
  }
  // A hardened gangster sitting right in the crowd — it must NOT catch the panic.
  const gang = spawnNpc(w, 'gangster', cx + 8, cy + 1)
  gang.health = { hp: 1e6, max: 1e6, iframes: 0 }
  return { w, civs, gang }
}

describe('#65 stampede — fear propagates cell-by-cell down a line', () => {
  it('the crowd flees in a rolling wave, not all at once', () => {
    const { w, civs, gang } = line()
    // Scare the end one: a pulse from off-stage (a scream it heard) — `born` in
    // the past so it is catchable immediately.
    w.fear.push({ x: civs[0].pos.x, y: civs[0].pos.y, expires: w.tick + 30, sourceId: -1, born: -1 })

    const onset = new Array(6).fill(-1)
    let gangFled = false
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 60; t++) {
      tickWorld(w, input)
      civs.forEach((e, i) => {
        if (onset[i] < 0 && e.ai!.mode === 'flee') onset[i] = t
      })
      if (gang.ai!.mode === 'flee') gangFled = true
    }

    // Every civilian caught the panic…
    for (let i = 0; i < 6; i++) expect(onset[i], `civ ${i} should have fled`).toBeGreaterThanOrEqual(0)
    // …in order — terror travels down the line, near end first.
    for (let i = 0; i < 5; i++) expect(onset[i + 1]).toBeGreaterThanOrEqual(onset[i])
    // …as a genuine WAVE (a real delay from the first to the far end), not a flash.
    expect(onset[5]).toBeGreaterThan(onset[0] + 5)
    expect(onset[2]).toBeGreaterThan(onset[1]) // it propagated past the first pulse's own radius
    // The hardened gangster standing among them never stampedes.
    expect(gangFled).toBe(false)
  })

  it('with no pulse nearby, a caught NPC calms back down (the window decays)', () => {
    const { w, civs } = line()
    const victim = civs[0]
    w.fear.push({ x: victim.pos.x, y: victim.pos.y, expires: w.tick + 30, sourceId: -1, born: -1 })
    const input = new Map([[0, emptyInput()]])
    // Isolate it: remove the rest of the crowd so no fresh pulses are emitted.
    for (let i = 1; i < civs.length; i++) civs[i].dead = true
    let fled = false
    for (let t = 0; t < 40; t++) {
      tickWorld(w, input)
      if (victim.ai!.mode === 'flee') fled = true
    }
    expect(fled).toBe(true) // it did stampede…
    // …and once the pulses decayed (and it stopped re-scaring itself) it settles.
    for (let t = 0; t < 120; t++) tickWorld(w, input)
    expect(w.fear.length).toBe(0)
    expect(victim.ai!.mode).not.toBe('flee')
  })
})
