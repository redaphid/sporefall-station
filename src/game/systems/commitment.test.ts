// Goal commitment: a goal holds for its minimum duration, a higher tier still
// interrupts at once. Each scene is authored (worldFromScene) to reproduce one
// flip-flop the goal census measured on generated floors, then run through the
// real systems with commitment off and on.

import { describe, expect, it } from 'vitest'
import { summarize, traceGoals } from '../../debug/goalCensus'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { worldFromScene, type CastSpawner } from '../testkit'
import { emptyInput, SIM_RATE } from '../types'
import { tickWorld, type World } from '../world'
import { COMMIT_TICKS } from './behaviors'

const npc =
  (archetype: string): CastSpawner =>
  (w, x, y) =>
    spawnNpc(w, archetype, x + 0.5, y + 0.5)

const CAST: Record<string, CastSpawner> = { s: npc('civilian'), p: npc('stalker') }

type Flags = NonNullable<World['aiFlags']>
const OFF: Flags = { commitment: false, activities: false }
const ON: Flags = { activities: false }

interface Scene {
  rows: string[]
  /** The stimulus the scene keeps up, before every tick. */
  before?: (w: World) => void
}

const stage = (scene: Scene, flags: Flags): World => {
  const w = worldFromScene(scene.rows, CAST, { hostile: false })
  w.aiFlags = flags
  return w
}

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

/** The two loops the census measured on generated floors. */
const MEASURED: [string, Scene][] = [
  ['scream', SCREAM],
  ['pack', PACK],
]
const SCENES: [string, Scene][] = [...MEASURED, ['flicker', FLICKER]]

const TICKS = 60 * SIM_RATE

describe('goal commitment', () => {
  for (const [name, scene] of MEASURED) {
    it(`${name}: commitment ends the A→B→A flip-flop the scene provokes`, () => {
      const off = summarize(name, traceGoals(stage(scene, OFF), TICKS, { before: scene.before }))
      const on = summarize(name, traceGoals(stage(scene, ON), TICKS, { before: scene.before }))
      // The scene is a real repro: without commitment it flip-flops.
      expect(off.aba, `${name} off: ${JSON.stringify(off.topAba)}`).toBeGreaterThanOrEqual(5)
      expect(on.aba, `${name} on: ${JSON.stringify(on.topAba)}`).toBeLessThanOrEqual(off.aba / 4)
      expect(on.switchesPerMin).toBeLessThan(off.switchesPerMin)
    })
  }

  for (const [name, scene] of SCENES) {
    it(`${name}: a committed goal is only left for a higher tier or when steering finishes it`, () => {
      const w = stage(scene, ON)
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

  it('census regression: over the measured scenes, flip-flops fall at least 80% and switches at least 40%', () => {
    const traces = (flags: Flags) => MEASURED.flatMap(([, scene]) => traceGoals(stage(scene, flags), TICKS, { before: scene.before }))
    const off = summarize('off', traces(OFF))
    const on = summarize('on', traces(ON))
    const report = `off ${off.switchesPerMin.toFixed(2)} sw/min, ${off.abaPerMin.toFixed(2)} aba/min; on ${on.switchesPerMin.toFixed(2)}, ${on.abaPerMin.toFixed(2)}`
    expect(on.abaPerMin, report).toBeLessThanOrEqual(off.abaPerMin * 0.2)
    expect(on.switchesPerMin, report).toBeLessThanOrEqual(off.switchesPerMin * 0.6)
    expect(on.medianDwellS, report).toBeGreaterThan(off.medianDwellS)
  })

  it('every committing goal holds for at least a second', () => {
    for (const [code, ticks] of Object.entries(COMMIT_TICKS)) expect(ticks, code).toBeGreaterThanOrEqual(SIM_RATE)
  })
})

describe('threats still interrupt at once', () => {
  it('a settler committed to investigating reacts the think a hostile comes into view', () => {
    const w = worldFromScene(FLICKER.rows, CAST, { hostile: true })
    w.aiFlags = ON
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
