import { describe, it } from 'vitest'
import { ARENAS, stageArena } from '../game/arenas'
import { levelFromJson } from '../game/levelgen/levelText'
import { spawnPlayer } from '../game/player'
import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import { expectWorldEqual } from '../game/testkit'
import { worldFromState, type World } from '../game/world'
import { CENSUS_BUILDS, botInput } from './census'
import { runVerb } from './verbs'

// The review test reloads each arena at tick 0. This one reloads mid-fight, with
// statuses, projectiles and a mod sequence in flight. Each arena is staged in an
// authored room, so the level is data and no seed is involved. The two rooms
// span the census's range of shapes: a long open hall and a square room with a
// pillar the fight has to path around.
const ROOMS: Readonly<Record<string, readonly string[]>> = {
  'open 11x8': [
    '#############',
    '#@..........#',
    '#...........#',
    '#...........#',
    '#...........#',
    '#...........#',
    '#...........#',
    '#...........#',
    '#...........#',
    '#############',
  ],
  'pillared 7x7': [
    '#########',
    '#@......#',
    '#.......#',
    '#.......#',
    '#...#...#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
  ],
}

const stage = (rows: readonly string[], arena: string): World => {
  const w = worldFromState({ level: levelFromJson({ rows: [...rows] }) })
  const me = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  stageArena(w, ARENAS[arena], { x: 1, y: 1, w: rows[0].length - 2, h: rows.length - 2 })
  for (const m of CENSUS_BUILDS.find((b) => b.name === 'hand fire-lead')!.mods) runVerb(w, `addMod ${me.id} ${m}`)
  return w
}

const botStep = (w: World): void => {
  const me = w.entities.find((e) => e.playerCtl)!
  const s = botInput(w, me)
  runVerb(w, s ? `step 1 ${JSON.stringify(s)}` : 'step 1')
}

describe('arenas reload mid-fight with a modded bot', () => {
  const cases = Object.keys(ARENAS).flatMap((a) => Object.keys(ROOMS).flatMap((r) => [37, 91].map((at) => [a, r, at] as const)))
  it.each(cases)('%s in the %s room, reload at tick %i', (arena, room, at) => {
    const w = stage(ROOMS[room], arena)
    for (let i = 0; i < at; i++) botStep(w)
    const re = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))) as WorldJson)
    for (let i = 0; i < 120; i++) {
      botStep(w)
      botStep(re)
    }
    expectWorldEqual(re, w)
  })
})
