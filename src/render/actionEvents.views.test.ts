// Event-driven one-shots at the entity layer: the lobber's shell (`lob`) and a
// hive spire's budding and spreading (`hiveSpawn`, `hiveSpread`) raise no
// combat.cooldown, so their attack clip starts from the sim event
// (animTracker.EVENT_STARTS). An event lives one tick; the views read every
// tick since their last update from the event log main.ts keeps
// (app/eventLog.ts). These tests drive the real sim and EntityViews and read
// the sprite back per rendered tick: rendered every tick, three ticks to a
// frame, and through a hitstop that freezes the entity layer.

import { describe, expect, it } from 'vitest'
import { runTicks } from '../game/testkit'
import type { SimEvent } from '../game/types'
import { fakeArt, hiveScene, shown, siegeScene, trace, type Frame, type Scene } from './animTestkit'

/** 8 attack frames at the default tpf 2: a 16-tick clip. */
const CLIP = 16
const expected = (dt: number): string => `attack.${Math.floor(dt / 2)}`

interface Case {
  name: string
  scene: () => Scene
  kind: 'lobber' | 'hivespire'
  types: readonly SimEvent['type'][]
  /** The acting entity an event names. */
  actor: (ev: SimEvent) => number | undefined
}

const CASES: Case[] = [
  {
    name: 'the lobber, on each lob',
    scene: siegeScene,
    kind: 'lobber',
    types: ['lob'],
    actor: (ev) => (ev.type === 'lob' ? ev.entityId : undefined),
  },
  {
    name: 'a hive spire, on each hiveSpawn and hiveSpread',
    scene: hiveScene,
    kind: 'hivespire',
    types: ['hiveSpawn', 'hiveSpread'],
    actor: (ev) => (ev.type === 'hiveSpawn' || ev.type === 'hiveSpread' ? ev.byId : undefined),
  },
]

/** Ticks on which the focus entity acted, from the same sim run unrendered. */
const actTicks = (c: Case): number[] => {
  const s = c.scene()
  const id = s.focus[0].id
  const out: number[] = []
  for (let i = 0; i < s.n; i++) {
    runTicks(s.w, new Map(), 1)
    if (s.w.events.some((ev) => c.types.includes(ev.type) && c.actor(ev) === id)) out.push(s.w.tick)
  }
  return out
}

/** The act the frame at `tick` belongs to, if any: the latest act ≤ tick
 * whose clip still runs. */
const actAt = (acts: number[], tick: number): number | undefined => {
  const a = acts.filter((t) => t <= tick).at(-1)
  return a !== undefined && tick < a + CLIP ? a : undefined
}

/** Every rendered frame inside an act's clip shows the clip frame for its
 * own tick, counted from the act's tick; every other frame shows no attack. */
const expectClips = (frames: Frame[], acts: number[]): number => {
  let inClip = 0
  for (const f of frames) {
    const a = actAt(acts, f.tick)
    if (a === undefined) expect(shown(f), `tick ${f.tick}`).not.toMatch(/^attack/)
    else {
      expect(shown(f), `tick ${f.tick}, act at ${a}`).toBe(expected(f.tick - a))
      inClip++
    }
  }
  return inClip
}

describe.each(CASES)('$name starts its drawn attack clip', (c) => {
  const acts = actTicks(c)
  const art = () => fakeArt({ [c.kind]: { attack: 8 } })

  it('the scene acts at least twice, and its acts are a clip apart', () => {
    expect(acts.length).toBeGreaterThanOrEqual(2)
    for (let k = 1; k < acts.length; k++) expect(acts[k] - acts[k - 1]).toBeGreaterThanOrEqual(CLIP)
  })

  it('rendered every tick: attack.0 .. attack.7 from the act tick, and no attack otherwise', () => {
    const s = c.scene()
    const frames = trace(s, art())[s.focus[0].id]
    expect(frames.length).toBe(s.n)
    expect(expectClips(frames, acts)).toBe(acts.reduce((n, a) => n + Math.min(CLIP, s.n - a + 1), 0))
  })

  it.each([2, 3])('a frame that runs %i ticks still starts every clip on its act tick', (stride) => {
    const s = c.scene()
    const frames = trace(s, art(), { stride })[s.focus[0].id]
    // Some act fell on a tick that was never rendered.
    expect(acts.some((a) => !frames.some((f) => f.tick === a))).toBe(true)
    expectClips(frames, acts)
    for (const a of acts.filter((a) => a + CLIP <= s.n)) {
      const seen = frames.filter((f) => f.tick >= a && f.tick < a + CLIP)
      expect(seen.length).toBeGreaterThanOrEqual(Math.floor(CLIP / stride))
    }
  })

  it('an act during a hitstop: the clip is already running, on the right frame, when the layer thaws', () => {
    const s = c.scene()
    // Freeze the entity layer from 1 tick before each act to 3 after it.
    const frozen = (t: number): boolean => acts.some((a) => t >= a - 1 && t <= a + 3)
    const frames = trace(s, art(), { frozen })[s.focus[0].id]
    for (const a of acts.filter((a) => a + 4 <= s.n)) {
      const thaw = frames.find((f) => f.tick > a)!
      expect(thaw.tick).toBe(a + 4)
      expect(shown(thaw)).toBe(expected(4))
    }
    expectClips(frames, acts)
  })

  it('NEGATIVE CONTROL: handed only the rendered tick`s events, a 3-tick frame misses the acts between frames', () => {
    const s = c.scene()
    const frames = trace(s, art(), { stride: 3, events: 'lastTick' })[s.focus[0].id]
    const missed = acts.filter((a) => !frames.some((f) => f.tick >= a && f.tick < a + CLIP && shown(f).startsWith('attack')))
    expect(missed.length).toBeGreaterThan(0)
  })

  it('without attack frames the act changes nothing: same sprite as a run that never reads events', () => {
    const plain = trace(c.scene(), fakeArt())
    const blind = trace(c.scene(), fakeArt(), { events: 'none' })
    expect(plain).toEqual(blind)
    for (const frames of Object.values(plain)) for (const f of frames) expect(shown(f)).not.toMatch(/^attack/)
  })
})
