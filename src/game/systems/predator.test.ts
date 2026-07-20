// #67 — predator-prey ecology. A scavenger (`predator` behavior) hunts the
// WEAKEST body it perceives and shies from a healthy pack, culling the wounded
// of every side while refusing a losing fight. Sets exact state, runs the REAL
// decide(), asserts target choice and disengagement.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { emptyInput } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { decide } from './behaviors'

const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 12; y <= cy + 12; y++)
    for (let x = cx - 12; x <= cx + 12; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}
const wound = (e: ReturnType<typeof spawnNpc>, frac: number): void => {
  e.health = { hp: Math.max(1, Math.round(e.health!.max * frac)), max: e.health!.max, iframes: 0 }
}

describe('#67 predator — culls the weakest', () => {
  it('between a full-HP and a 10%-HP target it stalks the wounded one', () => {
    const { w, cx, cy } = arena()
    const stalker = spawnNpc(w, 'stalker', cx, cy)
    stalker.ai!.sightRange = 14
    spawnNpc(w, 'gangster', cx + 3, cy) // full HP, and CLOSER
    const weak = spawnNpc(w, 'gangster', cx + 5, cy) // wounded, farther
    wound(weak, 0.1)
    const goal = decide(w, stalker).goal
    expect(['battle', 'pursue']).toContain(goal.code)
    expect(goal.target).toBe(weak.id) // weakest wins over nearest
  })

  it('leaves its own kind (the pack, same faction) alone', () => {
    const { w, cx, cy } = arena()
    const stalker = spawnNpc(w, 'stalker', cx, cy)
    stalker.ai!.sightRange = 14
    const packmate = spawnNpc(w, 'stalker', cx + 3, cy)
    wound(packmate, 0.1) // even a badly hurt packmate is not prey
    const goal = decide(w, stalker).goal
    expect(goal.target).not.toBe(packmate.id)
  })
})

describe('#67 predator — refuses a losing fight', () => {
  it('disengages (flees) when outnumbered by a healthy pack', () => {
    const { w, cx, cy } = arena()
    const stalker = spawnNpc(w, 'stalker', cx, cy)
    stalker.ai!.sightRange = 14
    const weak = spawnNpc(w, 'gangster', cx + 5, cy)
    wound(weak, 0.05) // a tempting straggler…
    for (let i = 0; i < 3; i++) spawnNpc(w, 'cop', cx + 2 + i * 0.5, cy + 1) // …but 3 healthy cops on top of it
    const goal = decide(w, stalker).goal
    expect(goal.code).toBe('flee') // pack-avoid (PANIC) overrides the stalk
  })

  it('with the pack thinned to below K it commits to the kill again', () => {
    const { w, cx, cy } = arena()
    const stalker = spawnNpc(w, 'stalker', cx, cy)
    stalker.ai!.sightRange = 14
    const weak = spawnNpc(w, 'gangster', cx + 5, cy)
    wound(weak, 0.05)
    const cops = [0, 1, 2].map((i) => spawnNpc(w, 'cop', cx + 2 + i * 0.5, cy + 1))
    expect(decide(w, stalker).goal.code).toBe('flee') // outnumbered → break off
    cops[0].dead = true
    cops[1].dead = true // pack thinned below K=3
    const goal = decide(w, stalker).goal
    expect(['battle', 'pursue']).toContain(goal.code) // back on the hunt
  })

  it('runs through tickWorld without breaking (integration smoke)', () => {
    const { w, cx, cy } = arena()
    const stalker = spawnNpc(w, 'stalker', cx, cy)
    stalker.ai!.sightRange = 14
    const weak = spawnNpc(w, 'gangster', cx + 4, cy)
    wound(weak, 0.15)
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 30; t++) tickWorld(w, input)
    // It closed on and started finishing the wounded straggler.
    expect(weak.health!.hp).toBeLessThan(Math.round(weak.health!.max * 0.15))
  })
})
