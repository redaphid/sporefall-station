// SKID TO A STOP, at the entity layer the game draws with (EntityViews over the
// real sim, animTestkit.ts) and at the tracker and model underneath.
//
// Most tests here are relational: the same scene rendered with the skid ON and
// OFF. OFF is the renderer as it was before skids existed (the action-anims
// golden trace pins that), so every frame where ON differs from OFF is the
// skid, and nothing else may differ.

import type { Graphics } from 'pixi.js'
import { describe, expect, it } from 'vitest'
import { createEventLog } from '../app/eventLog'
import { makeEntity, type Entity } from '../game/entity'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { arm, runTicks, walledRoom, worldFromRows } from '../game/testkit'
import type { InputCmd } from '../game/types'
import { fakeArt, fakeWeapons, hiveScene, trace, type Frame, type Scene, type TraceOpts } from './animTestkit'
import { SKID_GATE, trackAnim, type AnimMemory } from './animTracker'
import { composeMotion, MOTION, skidEnvelope, skidSlide, type MotionInput } from './motion'
import { DUST, skidDust } from './skidDust'
import { EntityViews } from './sprites'

const ON: TraceOpts = { skid: true }
const OFF: TraceOpts = { skid: false }
const { rad, rise, ticks, cutTicks, slide, slideTicks } = MOTION.skid

/** The 8 compass runs, as stick vectors (screen coords: +y is down/south). */
const DIRS8: readonly [string, number, number][] = [
  ['e', 1, 0],
  ['se', 1, 1],
  ['s', 0, 1],
  ['sw', -1, 1],
  ['w', -1, 0],
  ['nw', -1, -1],
  ['n', 0, -1],
  ['ne', 1, -1],
]

interface RunOpts {
  /** Ticks the stick is held. */
  run?: number
  /** Stick magnitude while running. */
  mag?: number
  /** Input from the release on (`k` ticks after it); default: nothing held. */
  after?: (k: number) => Partial<InputCmd>
  n?: number
  x?: number
  y?: number
  /** Edit the world and the player before the run. */
  setup?: (p: Entity, w: Scene['w']) => void
  /** Called before tick i, after the input is set. */
  during?: (i: number, p: Entity) => void
  /** Aim held throughout (aim-walk); default: aim where you run, then none. */
  aim?: readonly [number, number]
}

const RUN0 = 4
const STILL: Partial<InputCmd> = { aimX: 0, aimY: 0 }

/** A player in an open room: stands RUN0 ticks, runs `run` ticks along (x, y),
 * lets go. `stops` collects every tick the body went from moving to still. */
const runStop = (x: number, y: number, o: RunOpts = {}): Scene & { stops: number[] } => {
  const w = worldFromRows(walledRoom(40, 40), { seed: 3 })
  const p = spawnPlayer(w, 0, o.x ?? 20.5, o.y ?? 20.5)
  p.health!.max = 1_000_000
  p.health!.hp = 1_000_000
  o.setup?.(p, w)
  const run = o.run ?? 20
  const m = o.mag ?? 1
  const inputs = new Map<number, Partial<InputCmd>>()
  const stops: number[] = []
  let was = false
  return {
    w,
    focus: [p],
    n: o.n ?? 60,
    inputs,
    stops,
    before: (i: number): void => {
      const now = p.pos.x !== p.prevPos.x || p.pos.y !== p.prevPos.y
      if (was && !now) stops.push(w.tick)
      was = now
      const aim = o.aim ? { aimX: o.aim[0], aimY: o.aim[1] } : undefined
      if (i < RUN0) inputs.set(0, { ...STILL, ...aim })
      else if (i < RUN0 + run) inputs.set(0, { moveX: x * m, moveY: y * m, aimX: x, aimY: y, ...aim })
      else inputs.set(0, { ...STILL, ...aim, ...o.after?.(i - RUN0 - run) })
      o.during?.(i, p)
    },
  }
}

const framesOf = (scene: Scene, opts: TraceOpts, art = fakeArt()): Frame[] => trace(scene, art, opts)[scene.focus[0].id]

/** Ticks on which ON and OFF differ at all. */
const diffTicks = (on: Frame[], off: Frame[]): number[] =>
  on.filter((f, i) => JSON.stringify(f) !== JSON.stringify(off[i])).map((f) => f.tick)

const skidMotion = (at: number, dirX: number, dirY: number) => ({ at, dirX, dirY })

describe('a full-speed stop skids, in every direction', () => {
  for (const [name, x, y] of DIRS8) {
    it(`${name}: slides on past the stop and back, leans back against the run, braced, then idles exactly as before`, () => {
      const sOn = runStop(x, y)
      const on = framesOf(sOn, ON)
      const off = framesOf(runStop(x, y), OFF)
      const T = sOn.stops[0]
      expect(T).toBe(RUN0 + 20 + 1) // the sim stops dead the tick after the stick lets go
      const len = Math.hypot(x, y)
      const dx = x / len
      const dy = y / len
      for (let i = 0; i < on.length; i++) {
        const a = on[i]
        const b = off[i]
        expect(a.tick).toBe(b.tick)
        // The sim stopped dead; the display slides on along the run and back.
        const q = skidSlide(skidMotion(T, dx, dy), a.tick + 0.5) * slide
        expect(a.x - b.x).toBeCloseTo(dx * q, 10)
        expect(a.y - b.y).toBeCloseTo(dy * q, 10)
        const k = skidEnvelope(skidMotion(T, dx, dy), a.tick + 0.5)
        if (k === 0 && q === 0) {
          expect(a, `tick ${a.tick} is outside the skid and must match OFF`).toEqual(b)
          continue
        }
        expect(a.tick).toBeGreaterThanOrEqual(T)
        expect(a.tick).toBeLessThan(T + Math.max(ticks, slideTicks))
        expect(a.rot - b.rot).toBeCloseTo(-dx * rad * k, 10)
        if (k > 0) expect(Math.abs(a.sy)).toBeLessThan(Math.abs(b.sy)) // the brace
      }
      // It did skid, and the lean is against the run: head back, feet forward.
      const peak = on.find((f) => f.tick === T + rise)!
      const base = off.find((f) => f.tick === T + rise)!
      if (dx !== 0) expect(Math.sign(peak.rot - base.rot)).toBe(-Math.sign(dx))
      else expect(peak.rot).toBe(base.rot) // straight up/down the screen: brace only
      expect(peak.sy).toBeLessThan(base.sy)
      expect(diffTicks(on, off).length).toBeGreaterThan(0)
    })
  }

  it('the lean is the full MOTION.skid.rad at the peak of a profile stop, and a diagonal leans by its sideways share', () => {
    const at = (x: number, y: number): number => {
      const s = runStop(x, y)
      const on = framesOf(s, ON)
      const off = framesOf(runStop(x, y), OFF)
      const T = s.stops[0]
      const i = on.findIndex((f) => f.tick === T + rise)
      return on[i].rot - off[i].rot
    }
    const k = skidEnvelope(skidMotion(0, 1, 0), rise + 0.5)
    expect(at(1, 0)).toBeCloseTo(-rad * k, 10)
    expect(at(-1, 0)).toBeCloseTo(rad * k, 10)
    expect(at(1, 1)).toBeCloseTo(-rad * k * Math.SQRT1_2, 10)
  })
})

describe('stops that must NOT skid', () => {
  const noSkid = (label: string, make: () => Scene): void => {
    it(label, () => {
      expect(diffTicks(framesOf(make(), ON), framesOf(make(), OFF))).toEqual([])
    })
  }

  noSkid('a walk (a half-pushed stick, under SKID_GATE.minSpeed) stops without one', () => runStop(1, 0, { mag: 0.4 }))
  noSkid('an eased stop (the stick let up over ten ticks) stops without one', () =>
    runStop(1, 0, { after: (k) => (k < 10 ? { moveX: 0.85 - k * 0.085, aimX: 1 } : STILL) }),
  )
  noSkid(`a 1-tick jitter stops without one`, () => runStop(1, 0, { run: 1 }))
  noSkid(`a run one tick short of SKID_GATE.runUp (${SKID_GATE.runUp}) stops without one`, () =>
    runStop(1, 0, { run: SKID_GATE.runUp - 1 }),
  )
  noSkid('a run into a wall, stick still held, stops without one (the wall stopped it, not the legs)', () =>
    runStop(1, 0, { x: 33.5, run: 60, n: 80 }),
  )
  noSkid('a stop into an attack stops without one: the swing carries the momentum', () =>
    runStop(1, 0, { setup: (p) => void arm(p, 'pistol'), after: (k) => (k < 6 ? { attack: true, aimX: 1, aimY: 0 } : STILL) }),
  )
  noSkid('a stop into a roll stops without one, and so does the end of the roll', () =>
    runStop(1, 0, { after: (k) => (k === 0 ? { roll: true, aimX: 1 } : STILL), n: 70 }),
  )
  noSkid('a body stunned mid-run halts without one', () =>
    runStop(1, 0, {
      run: 40,
      n: 70,
      during: (i, p) => {
        if (i === RUN0 + 20) p.status = { stun: 30, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
      },
    }),
  )

  it('exactly SKID_GATE.runUp ticks of running is enough', () => {
    expect(diffTicks(framesOf(runStop(1, 0, { run: SKID_GATE.runUp }), ON), framesOf(runStop(1, 0, { run: SKID_GATE.runUp }), OFF))).not.toEqual([])
  })

  it('a rooted hive spire never skids (it does not travel)', () => {
    expect(diffTicks(framesOf(hiveScene(), ON), framesOf(hiveScene(), OFF))).toEqual([])
  })

  it('a hover drone never skids and kicks no dust: there are no feet to skid on', () => {
    const art = (): ReturnType<typeof fakeArt> => fakeArt({}, {}, { player: 'spore-drone' })
    const on = framesOf(runStop(1, 0), ON, art())
    const off = framesOf(runStop(1, 0), OFF, art())
    expect(diffTicks(on, off)).toEqual([])
    expect(skidDust({ at: 10, dirX: 1, dirY: 0, x: 5, y: 5, speed: 4.5 }, 1, 12, 'hover')).toEqual([])
    expect(skidDust({ at: 10, dirX: 1, dirY: 0, x: 5, y: 5, speed: 4.5 }, 1, 12, 'pulse')).toEqual([])
  })
})

describe('priorities: what cuts a skid, and how', () => {
  it('moving again mid-skid cuts it cleanly: it fades out over cutTicks, no frame jumps more than the rise does', () => {
    const make = (): ReturnType<typeof runStop> => runStop(1, 0, { after: (k) => (k >= 3 ? { moveX: 1, aimX: 1 } : STILL), n: 50 })
    const s = make()
    const on = framesOf(s, ON)
    const off = framesOf(make(), OFF)
    const T = s.stops[0]
    const R = T + 3 // the body moves again on this tick
    const d = diffTicks(on, off)
    expect(d[0]).toBe(T)
    expect(d[d.length - 1]).toBeLessThan(R + cutTicks) // gone cutTicks after the cut
    // No pop: the lean never jumps by more per frame than its own steepest rise.
    const steepest = rad * Math.sin((Math.PI / 2) * (1 / rise)) + 1e-9
    for (let i = 1; i < on.length; i++) expect(Math.abs(on[i].rot - off[i].rot - (on[i - 1].rot - off[i - 1].rot))).toBeLessThanOrEqual(steepest)
    // And it is fading after the cut, not still leaning into it.
    const lean = (t: number): number => Math.abs(on.find((f) => f.tick === t)!.rot - off.find((f) => f.tick === t)!.rot)
    expect(lean(R + 1)).toBeLessThan(lean(R))
    expect(lean(R + 2)).toBeLessThan(lean(R + 1))
  })

  it('an attack mid-skid cuts it the same way, and the attack plays as it would have', () => {
    const make = (): ReturnType<typeof runStop> =>
      runStop(1, 0, { setup: (p) => void arm(p, 'pistol'), after: (k) => (k >= 3 && k < 6 ? { attack: true, aimX: 1, aimY: 0 } : STILL) })
    const s = make()
    const on = framesOf(s, ON)
    const off = framesOf(make(), OFF)
    const T = s.stops[0]
    const d = diffTicks(on, off)
    expect(d[0]).toBe(T)
    expect(d[d.length - 1]).toBeLessThan(T + 3 + cutTicks)
    for (let i = 0; i < on.length; i++) expect(on[i].tex).toBe(off[i].tex)
  })

  it('a roll mid-skid ends it outright (the tumble is whole-body) and nothing skids after', () => {
    const make = (): ReturnType<typeof runStop> => runStop(1, 0, { after: (k) => (k === 3 ? { roll: true, aimX: 1 } : STILL), n: 70 })
    const s = make()
    const on = framesOf(s, ON)
    const off = framesOf(make(), OFF)
    const T = s.stops[0]
    const d = diffTicks(on, off)
    expect(d[0]).toBe(T)
    expect(d[d.length - 1]).toBeLessThan(T + 3) // the roll starts at T+3: identical from there on
  })
})

// --- The tracker alone, on hand-driven bodies: a hurt, a death, first sight,
// and a network client's remote mirror (no intent, no speed on the wire).

/** A body moved by hand one tick at a time, observed by trackAnim. */
const driven = (o: { intent?: { x: number; y: number } } = {}) => {
  const e = makeEntity('npc', 'mutant', 10, 10, 0.35)
  const mem: AnimMemory = {}
  let tick = 0
  const step = (dx: number, dy: number, mutate?: (e: Entity, tick: number) => void, observe = true): void => {
    tick++
    e.prevPos = { ...e.pos }
    e.pos = { x: e.pos.x + dx, y: e.pos.y + dy }
    if (o.intent) e.intent = { ...o.intent }
    mutate?.(e, tick)
    if (observe) trackAnim(mem, e, tick, {})
  }
  return { e, mem, step, tick: () => tick }
}
const STEP = 4.5 / 30

describe('the tracker', () => {
  it('a remote mirror (intent 0, speed 0: what a network client holds) skids on a dead stop', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0)
    expect(b.mem.skid).toMatchObject({ at: 13, dirX: 1, dirY: 0 })
    expect(b.mem.skid!.speed).toBeCloseTo(4.5, 10)
  })

  it('…but not when its last step was the short one that snaps a body flush to a wall', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(STEP * 0.4, 0)
    b.step(0, 0)
    expect(b.mem.skid).toBeUndefined()
  })

  it('a body still pushing toward its run (intent) stopped on a wall: no skid', () => {
    const b = driven({ intent: { x: 1, y: 0 } })
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0)
    expect(b.mem.skid).toBeUndefined()
  })

  it('a stop on the tick a hit lands: the flinch wins, no skid', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0, (e, t) => (e.status = { stun: 0, sleep: 0, hitFlashUntil: t + 3, cloakUntil: 0 }))
    expect(b.mem.skid).toBeUndefined()
  })

  it('a hit mid-skid cuts it on the hit tick', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0)
    b.step(0, 0)
    b.step(0, 0, (e, t) => (e.status = { stun: 0, sleep: 0, hitFlashUntil: t + 3, cloakUntil: 0 }))
    expect(b.mem.skid).toMatchObject({ at: 13, cutAt: 15 })
  })

  it('a stop on the tick the body is first seen: nothing to skid from', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0, undefined, false)
    b.step(0, 0)
    expect(b.mem.skid).toBeUndefined()
    expect(b.mem.run).toBeUndefined()
  })

  it('first seen mid-run and stopping a tick later: no run-up seen, no skid', () => {
    const b = driven()
    for (let i = 0; i < 11; i++) b.step(STEP, 0, undefined, false)
    b.step(STEP, 0)
    b.step(0, 0)
    expect(b.mem.skid).toBeUndefined()
  })

  it('the same tick observed twice (two frames of one tick) changes nothing', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0)
    const before = JSON.stringify(b.mem)
    trackAnim(b.mem, b.e, b.tick(), {})
    expect(JSON.stringify(b.mem)).toBe(before)
  })

  it('a rewind (an earlier tick than last seen) forgets the run and the skid', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0)
    trackAnim(b.mem, b.e, 5, {})
    expect(b.mem.skid).toBeUndefined()
    expect(b.mem.run).toBeUndefined()
  })

  it('forgets a skid once its lean and dust are over', () => {
    const b = driven()
    for (let i = 0; i < 12; i++) b.step(STEP, 0)
    b.step(0, 0)
    for (let i = 0; i < SKID_GATE.life; i++) b.step(0, 0)
    expect(b.mem.skid).toBeUndefined()
  })

  it('reconstructs the stop tick from distance when frames skip ticks, at every stride and offset', () => {
    for (const stride of [2, 3, 5, 8]) {
      for (let offset = 0; offset < stride; offset++) {
        const b = driven()
        // Stand 8 ticks, run 12, stop on 21; render until the stop has surely
        // been seen. (A body first seen mid-run has no run-up to go on.)
        for (let i = 1; i <= 21 + stride; i++) b.step(i > 8 && i <= 20 ? STEP : 0, 0, undefined, i === 1 || (i + offset) % stride === 0)
        expect(b.mem.skid?.at, `stride ${stride} offset ${offset}`).toBe(21)
      }
    }
  })
})

describe('frame cadence: the lean is a function of the tick, not of when frames land', () => {
  const sceneE = (): ReturnType<typeof runStop> => runStop(1, 1)
  const one = framesOf(sceneE(), ON)
  const byTick = new Map(one.map((f) => [f.tick, f]))

  for (const stride of [2, 3, 8]) {
    it(`a frame every ${stride} ticks (a slow device) draws the same sprite at the same tick`, () => {
      const f = framesOf(sceneE(), { ...ON, stride })
      expect(f.length).toBeGreaterThan(3)
      for (const x of f) expect(x).toEqual(byTick.get(x.tick))
    })
  }

  it('a hitstop freezing the entity layer through the stop draws the same sprite once it thaws', () => {
    const T = RUN0 + 21 // the stop (first test above)
    const f = framesOf(sceneE(), { ...ON, frozen: (t) => t >= T - 2 && t <= T + 3 })
    for (const x of f) expect(x).toEqual(byTick.get(x.tick))
    expect(f.some((x) => x.tick === T + 4)).toBe(true)
  })

  it('several frames per tick (a 120 Hz display) draw the same sprite as one frame per tick', () => {
    const f = framesOf(sceneE(), { ...ON, alphas: [0, 0.25, 0.75, 0.5] })
    expect(f).toEqual(one)
  })
})

describe('locomotion styles', () => {
  it('a sporeling-mite (waddle) skids smaller, by MOTION.skid.gain.waddle', () => {
    const lean = (kind: string | undefined): number => {
      const art = (): ReturnType<typeof fakeArt> => fakeArt({}, {}, kind ? { player: kind } : {})
      const s = runStop(1, 0)
      const on = framesOf(s, ON, art())
      const off = framesOf(runStop(1, 0), OFF, art())
      const i = on.findIndex((f) => f.tick === s.stops[0] + rise)
      return on[i].rot - off[i].rot
    }
    expect(lean('sporeling-mite') / lean(undefined)).toBeCloseTo(MOTION.skid.gain.waddle, 10)
  })

  it('composeMotion: no skid term for hover or pulse, nor in a roll or a death', () => {
    const m: MotionInput = { state: 'idle', start: 0, tick: 12, t: 12, id: 1, facing: 0, vx: 0, moving: false }
    const skid = skidMotion(10, 1, 0)
    for (const style of ['hover', 'pulse'] as const) expect(composeMotion({ ...m, style, skid })).toEqual(composeMotion({ ...m, style }))
    for (const state of ['roll', 'death'] as const) expect(composeMotion({ ...m, state, skid })).toEqual(composeMotion({ ...m, state }))
    expect(composeMotion({ ...m, skid }).rot).toBeLessThan(0)
  })

  it('the envelope is 0 at the stop, peaks at 1 on `rise`, is back to 0 at `ticks`, and a cut takes it to 0 in cutTicks', () => {
    const s = skidMotion(100, 1, 0)
    expect(skidEnvelope(s, 100)).toBe(0)
    expect(skidEnvelope(s, 100 + rise)).toBeCloseTo(1, 12)
    expect(skidEnvelope(s, 100 + ticks)).toBe(0)
    expect(skidEnvelope(s, 100 + ticks - 1e-6)).toBeCloseTo(0, 5)
    expect(skidEnvelope({ ...s, cutAt: 101 }, 101 + cutTicks)).toBe(0)
    expect(skidEnvelope(s, 99)).toBe(0)
  })
})

describe('the dust', () => {
  const skid = { at: 100, dirX: 1, dirY: 0, x: 10, y: 10, speed: 4.5 }

  it('kicks forward from the feet, on whole pixels, and settles to nothing in DUST.ticks', () => {
    expect(skidDust(skid, 7, 100)).toEqual([])
    expect(skidDust(skid, 7, 100 + DUST.ticks)).toEqual([])
    const feetX = 10 * 32
    const feetY = 10.5 * 32
    for (let s = 1; s < DUST.ticks; s++) {
      const puffs = skidDust(skid, 7, 100 + s)
      expect(puffs).toHaveLength(DUST.puffs.stride)
      for (const p of puffs) {
        expect(Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.r)).toBe(true)
        expect(p.x).toBeGreaterThanOrEqual(feetX) // ahead of the feet, along the run
        expect(Math.abs(p.y - feetY)).toBeLessThanOrEqual(DUST.reach)
      }
    }
    const late = skidDust(skid, 7, 100 + DUST.ticks - 1)
    const early = skidDust(skid, 7, 101)
    expect(Math.max(...late.map((p) => p.alpha))).toBeLessThan(Math.min(...early.map((p) => p.alpha)))
  })

  it('kicks the way the run went, in all eight directions', () => {
    for (const [, x, y] of DIRS8) {
      const l = Math.hypot(x, y)
      const puffs = skidDust({ ...skid, dirX: x / l, dirY: y / l }, 7, 106)
      const cx = puffs.reduce((n, p) => n + p.x, 0) / puffs.length - 320
      const cy = puffs.reduce((n, p) => n + p.y + DUST.rise, 0) / puffs.length - 336
      expect(cx * x + cy * y).toBeGreaterThan(0)
    }
  })

  it('varies per body and per stop, deterministically (hash of id and stop tick)', () => {
    expect(skidDust(skid, 7, 105)).toEqual(skidDust(skid, 7, 105))
    expect(skidDust(skid, 8, 105)).not.toEqual(skidDust(skid, 7, 105))
    expect(skidDust({ ...skid, at: 101 }, 7, 106)).not.toEqual(skidDust(skid, 7, 105))
  })

  it('is drawn at the entity layer while it is in the air, and only with the skid on', () => {
    const dustAt = (on: boolean): (Graphics | undefined)[] => {
      const s = runStop(1, 0)
      const views = new EntityViews(fakeArt(), { skid: on })
      const log = createEventLog()
      const out: (Graphics | undefined)[] = []
      for (let i = 0; i < s.n; i++) {
        s.before(i)
        runTicks(s.w, s.inputs!, 1)
        log.afterTick(s.w.tick, s.w.events)
        views.update(s.w.entities, 0.5, s.w.tick, s.w.floor, log.entries)
        out.push((views as unknown as { views: Map<number, { dust?: Graphics }> }).views.get(s.focus[0].id)?.dust)
      }
      return out
    }
    const T = RUN0 + 21
    const on = dustAt(true)
    // Frame i rendered tick i + 1.
    expect(on.slice(0, T - 1).every((g) => g === undefined)).toBe(true)
    expect(on.slice(T - 1, T - 1 + DUST.ticks).every((g) => g !== undefined)).toBe(true)
    expect(on.slice(T - 1 + DUST.ticks).every((g) => g === undefined)).toBe(true)
    expect(dustAt(false).every((g) => g === undefined)).toBe(true)
  })
})

describe('it reads on a phone (the owner-review numbers)', () => {
  it('peaks at a 12-15 degree lean, slides 2-3 px past the stop, and settles by t+9', () => {
    expect((rad * 180) / Math.PI).toBeGreaterThanOrEqual(12)
    expect((rad * 180) / Math.PI).toBeLessThanOrEqual(15)
    expect(slide).toBeGreaterThanOrEqual(2)
    expect(slide).toBeLessThanOrEqual(3)
    const m = skidMotion(0, 1, 0)
    expect(skidEnvelope(m, ticks)).toBe(0)
    expect(skidSlide(m, slideTicks)).toBe(0)
    expect(Math.max(ticks, slideTicks)).toBeLessThanOrEqual(9)
  })

  it('an up- or down-screen stop squats visibly (a knee-bend of 15%+), a profile stop braces less', () => {
    const at = (dirX: number, dirY: number): MotionInput & { skid: ReturnType<typeof skidMotion> } => ({
      state: 'idle', start: 0, tick: 3, t: 3, id: 2, facing: 0, vx: 0, moving: false, drawn: true, skid: skidMotion(0, dirX, dirY),
    })
    expect(composeMotion(at(0, 1)).sy).toBeLessThanOrEqual(0.85)
    expect(composeMotion(at(0, -1)).sy).toBeLessThanOrEqual(0.85)
    expect(composeMotion(at(1, 0)).sy).toBeGreaterThan(composeMotion(at(0, 1)).sy)
  })

  it('the dust lands clear of the selection ring, 5-7 px puffs, in every direction', () => {
    for (const [, x, y] of DIRS8) {
      const l = Math.hypot(x, y)
      for (let s = 1; s < DUST.ticks; s++) {
        for (const p of skidDust({ at: 0, dirX: x / l, dirY: y / l, x: 10, y: 10, speed: 4.5 }, 3, s)) {
          const ex = (p.x - 320) / (0.22 * 32 + 1)
          const ey = (p.y - 336) / (0.22 * 32 * 0.52 + 1)
          expect(ex * ex + ey * ey, `puff at ${p.x},${p.y} sits on the ring`).toBeGreaterThan(1)
          expect(2 * p.r + 1).toBeGreaterThanOrEqual(5)
          expect(2 * p.r + 1).toBeLessThanOrEqual(7)
        }
      }
    }
  })
})

describe('the held weapon and the gun-hand stops', () => {
  /** Weapon rotation and position from a Frame's `<drawing>:rot@x,y`. */
  const weaponOf = (f: Frame): { rot: number; x: number; y: number } => {
    const [head, at] = f.weapon!.split('@')
    const [x, y] = at.split(',').map(Number)
    return { rot: Number(head.split(':').pop()), x, y }
  }
  /** Placeholder weapon art: a pack without it draws no held weapon. */
  const armedArt = (): ReturnType<typeof fakeArt> => fakeArt({}, {}, {}, fakeWeapons())
  /** The ON hand offset from the feet predicted from the OFF one: the hand in
   * the body's local frame (OFF has no rotation), carried through the ON body's
   * rotation and scale. Weapon v2 snaps it to whole art pixels, so allow 1.5. */
  const expectCarried = (on: Frame, off: Frame): void => {
    const w1 = weaponOf(on)
    const w0 = weaponOf(off)
    expect(off.rot).toBe(0)
    const lx = (w0.x - off.x) / Math.abs(off.sx)
    const ly = (w0.y - off.y) / off.sy
    const c = Math.cos(on.rot)
    const s = Math.sin(on.rot)
    expect(Math.abs(w1.x - on.x - (c * Math.abs(on.sx) * lx - s * on.sy * ly))).toBeLessThanOrEqual(1.5)
    expect(Math.abs(w1.y - on.y - (s * Math.abs(on.sx) * lx + c * on.sy * ly))).toBeLessThanOrEqual(1.5)
  }

  it('the held weapon goes with the lean, around the feet, hand and all (pixel art: never rotated)', () => {
    const make = (): ReturnType<typeof runStop> => runStop(1, 0, { setup: (p) => void arm(p, 'pistol') })
    const s = make()
    const on = framesOf(s, ON, armedArt())
    const off = framesOf(make(), OFF, armedArt())
    const T = s.stops[0]
    const i = on.findIndex((f) => f.tick === T + rise + 1)
    const lean = on[i].rot - off[i].rot
    expect(Math.abs(lean)).toBeGreaterThan(0.2)
    expect(weaponOf(on[i]).rot).toBe(0)
    expect(weaponOf(off[i]).rot).toBe(0)
    expect([weaponOf(on[i]).x, weaponOf(on[i]).y]).not.toEqual([weaponOf(off[i]).x, weaponOf(off[i]).y])
    expectCarried(on[i], off[i])
  })

  it('run, then fire on the release tick: the shot carries the momentum, no lean, slide or dust at all', () => {
    // Pinned above too ("a stop into an attack"); here with the aim held, the
    // way a player shoots the moment they let go of the stick.
    const make = (): ReturnType<typeof runStop> =>
      runStop(1, 0, { setup: (p) => void arm(p, 'pistol'), after: (k) => (k < 4 ? { attack: true, aimX: 1, aimY: 0 } : STILL) })
    expect(diffTicks(framesOf(make(), ON), framesOf(make(), OFF))).toEqual([])
  })

  it('aim-walk: strafing east while aiming north, then letting go, leans against the RUN (sideways to the gun), the gun with it', () => {
    // A sidestep stop tips the body sideways, whatever it faces; the gun stays
    // in the hand and keeps pointing north, turned only by the lean.
    const make = (): ReturnType<typeof runStop> => runStop(1, 0, { setup: (p) => void arm(p, 'pistol'), aim: [0, -1] })
    const s = make()
    const on = framesOf(s, ON, armedArt())
    const off = framesOf(make(), OFF, armedArt())
    const T = s.stops[0]
    const i = on.findIndex((f) => f.tick === T + rise + 1)
    expect(on[i].rot - off[i].rot).toBeCloseTo(-rad, 10)
    expect(on[i].tex).toMatch(/^player\.n\./) // still the back (north) view
    expect(on[i].tex).toBe(off[i].tex)
    // The same drawing (still pointing north), carried by the lean.
    expect(on[i].weapon!.split(':')[0]).toBe(off[i].weapon!.split(':')[0])
    expectCarried(on[i], off[i])
  })
})

describe('a walking NPC skids too', () => {
  it('a mutant run east by hand and stopped leans back like the player', () => {
    const make = (): Scene & { T: number } => {
      const w = worldFromRows(walledRoom(40, 20), { seed: 9 })
      const m = spawnNpc(w, 'mutant', 10.5, 10.5)
      delete m.ai // driven by hand, not by its brain
      const T = 25
      return {
        w,
        focus: [m],
        n: 45,
        T,
        before: (i: number): void => {
          m.intent = i >= 4 && i < T - 1 ? { x: 1, y: 0 } : { x: 0, y: 0 }
        },
      }
    }
    const s = make()
    const on = framesOf(s, ON)
    const off = framesOf(make(), OFF)
    const d = diffTicks(on, off)
    expect(d.length).toBeGreaterThan(0)
    const peak = on.find((f) => f.tick === d[0] + rise)!
    expect(peak.rot).toBeLessThan(off.find((f) => f.tick === d[0] + rise)!.rot)
  })
})
