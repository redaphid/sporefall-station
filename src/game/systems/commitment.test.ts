// Goal commitment: a goal holds for its minimum duration, a higher tier still
// interrupts at once. Each scene is authored (worldFromScene) to reproduce one
// flip-flop the goal census measured on generated floors, then run through the
// real systems and held against what main's AI did on the same scene.

import { describe, expect, it } from 'vitest'
import { summarize, traceGoals } from '../../debug/goalCensus'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { worldFromScene, type CastSpawner } from '../testkit'
import { emptyInput, SIM_RATE } from '../types'
import { tickWorld, type World } from '../world'
import { commitTicks, TIER_AMBIENT, TIER_PANIC, TIER_THREAT } from './behaviors'
import { FLEE } from './goalCodes'

const npc =
  (archetype: string): CastSpawner =>
  (w, x, y) =>
    spawnNpc(w, archetype, x + 0.5, y + 0.5)

const CAST: Record<string, CastSpawner> = { s: npc('civilian'), p: npc('stalker') }


interface Scene {
  rows: string[]
  /** The stimulus the scene keeps up, before every tick. */
  before?: (w: World) => void
}

const stage = (scene: Scene): World => worldFromScene(scene.rows, CAST, { hostile: false })

/** A scream and a noise kept up at one spot: the scream drives a settler off,
 * the noise draws it back to look. The station floors' garrison→flee loop. */
const SCREAM: Scene = {
  rows: [
    '####################',
    '#..................#',
    '#..................#',
    '#........s.........#',
    '#..................#',
    '#..................#',
    '####################',
  ],
  before: (w) => {
    w.fear.push({ x: 5.5, y: 3.5, expires: w.tick + 30, sourceId: 9999, born: w.tick - 1 })
    w.noises.push({ x: 5.5, y: 3.5, expires: w.tick + 30 })
  },
}

/** A predator facing a healthy pack: it breaks off at the pack radius, then
 * stalks straight back in. */
const PACK: Scene = {
  rows: [
    '##########################',
    '#........................#',
    '#..s.s...................#',
    '#..s.....................#',
    '#.............p..........#',
    '#........................#',
    '##########################',
  ],
}

/** A noise that comes and goes: investigate, wander, investigate. */
const FLICKER: Scene = {
  rows: [
    '####################',
    '#..................#',
    '#..s...............#',
    '#..................#',
    '####################',
  ],
  before: (w) => {
    if (w.tick % 20 < 10) w.noises.push({ x: 12.5, y: 2.5, expires: w.tick + 1 })
  },
}

/** The two loops the census measured on generated floors, with what main's AI
 * (before commitment, at 2d8fd8c) did on each authored scene over TICKS. */
const MEASURED: [string, Scene, { switches: number; aba: number; dwellS: number }][] = [
  ['scream', SCREAM, { switches: 224, aba: 223, dwellS: 0.2 }],
  ['pack', PACK, { switches: 13, aba: 8, dwellS: 1.6 }],
]
const SCENES: [string, Scene][] = [...MEASURED.map(([n, sc]): [string, Scene] => [n, sc]), ['flicker', FLICKER]]

const TICKS = 60 * SIM_RATE

describe('goal commitment', () => {
  for (const [name, scene, main] of MEASURED) {
    it(`${name}: commitment ends the A→B→A flip-flop main showed on this scene`, () => {
      const r = summarize(name, traceGoals(stage(scene), TICKS, { before: scene.before }))
      expect(r.aba, `${name}: ${JSON.stringify(r.topAba)}`).toBeLessThanOrEqual(main.aba / 4)
      expect(r.switches).toBeLessThan(main.switches)
    })
  }

  for (const [name, scene] of SCENES) {
    it(`${name}: a committed goal is only left for a higher tier or when steering finishes it`, () => {
      const w = stage(scene)
      // Each NPC's commitment as it stood at the end of the previous tick.
      const before = new Map<number, { goal?: string; commit?: { until: number; tier: number } }>()
      for (let i = 0; i < TICKS; i++) {
        scene.before?.(w)
        tickWorld(w, new Map())
        for (const e of w.entities) {
          if (!e.ai || e.dead) continue
          const prev = before.get(e.id)
          const live = prev?.commit && prev.commit.until > w.tick - 1
          if (prev && live && prev.goal !== e.ai.goal) {
            const tier = e.ai.commit?.tier ?? -1
            expect(tier, `#${e.id} left ${prev.goal} for ${e.ai.goal} at tick ${w.tick}, ${prev.commit!.until - w.tick} ticks early`).toBeGreaterThan(prev.commit!.tier)
          }
          before.set(e.id, { goal: e.ai.goal, commit: e.ai.commit && { ...e.ai.commit } })
        }
      }
    })
  }

  it('census regression: over the measured scenes, flip-flops fall at least 80% and switches at least 40% from main', () => {
    const on = summarize('on', MEASURED.flatMap(([, scene]) => traceGoals(stage(scene), TICKS, { before: scene.before })))
    const mainSwitches = MEASURED.reduce((n, [, , m]) => n + m.switches, 0)
    const mainAba = MEASURED.reduce((n, [, , m]) => n + m.aba, 0)
    const report = `main ${mainSwitches} switches, ${mainAba} A→B→A; now ${on.switches}, ${on.aba}`
    expect(on.aba, report).toBeLessThanOrEqual(mainAba * 0.2)
    expect(on.switches, report).toBeLessThanOrEqual(mainSwitches * 0.6)
    expect(on.medianDwellS, report).toBeGreaterThan(Math.max(...MEASURED.map(([, , m]) => m.dwellS)))
  })

  it('a goal commits for at least a second, except flight from an enemy seen at the threat tier', () => {
    for (const code of ['battle', 'pursue', 'investigate', 'garrison', 'work', 'patrol']) expect(commitTicks(code, TIER_AMBIENT), code).toBeGreaterThanOrEqual(SIM_RATE)
    expect(commitTicks(FLEE, TIER_PANIC)).toBeGreaterThanOrEqual(SIM_RATE)
    expect(commitTicks(FLEE, TIER_THREAT)).toBe(0)
    expect(commitTicks('wander', TIER_AMBIENT)).toBe(0)
  })
})

describe('threats still interrupt at once', () => {
  it('a settler committed to investigating reacts the think a hostile comes into view', () => {
    const w = worldFromScene(FLICKER.rows, CAST, { hostile: true })
    const s = w.entities.find((e) => e.archetype === 'civilian')!
    for (let i = 0; i < 20; i++) {
      w.noises.push({ x: 12.5, y: 2.5, expires: w.tick + 30 })
      tickWorld(w, new Map())
    }
    expect(s.ai!.goal).toBe('investigate')
    expect(s.ai!.commit!.until).toBeGreaterThan(w.tick + 10)
    const player = spawnPlayer(w, 0, s.pos.x + 2, s.pos.y)
    const t0 = w.tick
    while (w.tick - t0 < 12 && s.ai!.goal === 'investigate') tickWorld(w, new Map([[0, emptyInput()]]))
    expect(['flee', 'battle', 'alert']).toContain(s.ai!.goal)
    expect(s.ai!.targetId ?? s.ai!.fearId).toBe(player.id)
  })
})

describe('co-op targeting: a new enemy breaks a held fight', () => {
  // A thug fights P1 across an open room. P1 ducks behind the wall into the
  // east room; P2 steps up three tiles from the thug. The fight on P1 is held
  // (its candidate vanished with P1's sightline), but P2 is a new target on
  // the same tier and must win at once.
  const ROOMS = [
    '####################',
    '#........#.........#',
    '#...t....#.........#',
    '#........#.........#',
    '####################',
  ]

  it('turns on the second player within one think, not after the hold runs out', () => {
    const w = worldFromScene(ROOMS, { t: npc('thug') }, { hostile: true })
    const thug = w.entities.find((e) => e.archetype === 'thug')!
    const tough = (e: Entity): Entity => {
      e.health = { hp: 1e6, max: 1e6, iframes: 0 }
      return e
    }
    const p1 = tough(spawnPlayer(w, 0, 7.5, 2.5))
    const p2 = tough(spawnPlayer(w, 1, 15.5, 2.5))
    const idle = new Map([
      [0, emptyInput()],
      [1, emptyInput()],
    ])
    for (let i = 0; i < 60 && !(thug.ai!.goal === 'battle' && thug.ai!.targetId === p1.id); i++) tickWorld(w, idle)
    expect(thug.ai!).toMatchObject({ goal: 'battle', targetId: p1.id })
    p1.pos = { x: 16.5, y: 1.5 }
    p1.prevPos = { ...p1.pos }
    p2.pos = { x: thug.pos.x - 3, y: thug.pos.y }
    p2.prevPos = { ...p2.pos }
    const t0 = w.tick
    while (w.tick - t0 < 45 && thug.ai!.targetId !== p2.id) tickWorld(w, idle)
    expect(thug.ai!.targetId).toBe(p2.id)
    expect(w.tick - t0, 'ticks to turn on P2').toBeLessThanOrEqual(10)
  })
})
