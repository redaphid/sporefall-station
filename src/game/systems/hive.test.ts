// #66 — hive draw-field. A hive (spore-vermin / the Infected) with no direct
// target drifts toward the STRONGEST nearby stimulus (loudest noise / brightest
// bloom / fire), so a swarm pools on a shared focus the players can bait — while
// any perceived target still overrides the draw. Sets exact state, runs the REAL
// tickWorld/decide, asserts the swarm's shared focus.

import { describe, expect, it } from 'vitest'
import { Tile } from '../levelgen/level'
import { spawnNpc } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput } from '../types'
import { createWorld, type World } from '../world'
import { decide } from './behaviors'
import { igniteCell } from './fire'
import { spawnSporeBurst } from './spore'
import { strongestStimulus } from './stimulus'
import { tickWorld } from '../world'

const arena = (): { w: World; cx: number; cy: number } => {
  const w = createWorld(1, 1)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - 18; y <= cy + 18; y++)
    for (let x = cx - 20; x <= cx + 20; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  return { w, cx: cx + 0.5, cy: cy + 0.5 }
}

describe('#66 hive draw — a swarm pools on the strongest stimulus', () => {
  it('a horde between an unseen player and a bloom converges on the bloom', () => {
    const { w, cx, cy } = arena()
    const horde: ReturnType<typeof spawnNpc>[] = []
    for (let i = 0; i < 8; i++) {
      const e = spawnNpc(w, 'sporeling', cx + (i % 4) - 1.5, cy + Math.floor(i / 4) - 0.5)
      e.ai!.sightRange = 6 // the player is beyond sight → no direct target
      horde.push(e)
    }
    const player = spawnPlayer(w, 0, cx - 16, cy) // quiet, unseen, opposite the bloom
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    const bloomX = Math.floor(cx) + 12
    spawnSporeBurst(w, bloomX, Math.floor(cy))

    const centroidX = (): number => horde.reduce((s, e) => s + e.pos.x, 0) / horde.length
    const startX = centroidX()
    const input = new Map([[0, emptyInput()]])
    for (let t = 0; t < 90; t++) tickWorld(w, input)
    const endX = centroidX()

    // The swarm drifted toward the bloom (+x), away from the quiet player (−x).
    expect(endX).toBeGreaterThan(startX + 5)
    expect(endX).toBeLessThanOrEqual(bloomX + 1)
    // …and it's a shared FOCUS: the majority are on the draw goal.
    const drawn = horde.filter((e) => e.ai!.goal === 'drawn').length
    expect(drawn).toBeGreaterThanOrEqual(5)
  })

  it('a directly-perceived target OVERRIDES the draw (combat wins)', () => {
    const { w, cx, cy } = arena()
    const v = spawnNpc(w, 'sporeling', cx, cy)
    v.ai!.sightRange = 12
    const player = spawnPlayer(w, 0, cx + 3, cy) // in sight
    player.health = { hp: 1e6, max: 1e6, iframes: 0 }
    spawnSporeBurst(w, Math.floor(cx) - 10, Math.floor(cy)) // a bloom the other way
    const goal = decide(w, v).goal
    expect(['battle', 'pursue']).toContain(goal.code)
    expect(goal.target).toBe(player.id)
  })
})

describe('#66 hive draw — louder/brighter beats closer', () => {
  it('a bright fire outpulls a nearer faint noise', () => {
    const { w, cx, cy } = arena()
    // A quiet noise right next door…
    w.noises.push({ x: cx + 2, y: cy, expires: w.tick + 100 })
    // …and a bright fire further away (louder, so it still wins the pull).
    igniteCell(w, Math.floor(cx) + 7, Math.floor(cy))
    const s = strongestStimulus(w, cx, cy, 20)
    expect(s?.kind).toBe('fire') // the brighter, farther stimulus wins the pull
  })
})
