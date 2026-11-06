// The drawn one-shots `draw` and `fidget`, driven by the REAL sim: worlds built
// from authored rows, real NPCs from populate.spawnNpc, real tickWorld via
// runTicks. Each tick the render-side tracker (animTracker.trackAnim) observes
// the entity exactly as EntityViews does, and the tests assert the resolved
// state and the frame index animFrame would show.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../game/entity'
import { NPCS } from '../game/data/npcs'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { runTicks, walledRoom, worldFromRows } from '../game/testkit'
import type { World } from '../game/world'
import { animFrame, DEFAULT_TPF, FIDGET, MAX_ANIM_FRAMES, fidgetGrid, fidgetStart, type AnimStateName } from './animState'
import { DRAW_REARM_TICKS, trackAnim, type AnimMemory } from './animTracker'

/** A tiny fake pack: 8 drawn frames per action, at the engine's default tpf. */
const DRAW_FRAMES = 8
const FIDGET_FRAMES = 8
const DRAW_TICKS = DRAW_FRAMES * DEFAULT_TPF.draw
const FIDGET_TICKS = FIDGET_FRAMES * DEFAULT_TPF.fidget
const PACK = { draw: DRAW_TICKS, fidget: FIDGET_TICKS }
const NO_FRAMES = {}

interface Seen {
  tick: number
  state: AnimStateName
  start: number
  frame: number
  mode: string | undefined
  cooldown: number | undefined
}

/** Observe `e` after every tick for `n` ticks; `before(i)` may set world state
 * exactly (teleport, flags) ahead of tick i. */
const watch = (
  w: World,
  e: Entity,
  n: number,
  clips: Partial<Record<AnimStateName, number>>,
  before: (i: number) => void = () => {},
  mem: AnimMemory = {},
): Seen[] => {
  const out: Seen[] = []
  for (let i = 0; i < n; i++) {
    before(i)
    runTicks(w, new Map(), 1)
    const a = trackAnim(mem, e, w.tick, clips)
    const frames = a.state === 'draw' ? DRAW_FRAMES : a.state === 'fidget' ? FIDGET_FRAMES : 1
    out.push({
      tick: w.tick,
      state: a.state,
      start: a.start,
      frame: animFrame(a.state, frames, w.tick, a.start, DEFAULT_TPF[a.state], e.id),
      mode: e.ai?.mode,
      cooldown: e.combat?.cooldown,
    })
  }
  return out
}

const teleport = (e: Entity, x: number, y: number): void => {
  e.pos = { x, y }
  e.prevPos = { x, y }
}

// ---------------------------------------------------------------------------
// draw

/** A long room: the player waits out of the drowner's sight (9 tiles), then
 * steps into it at tick 60, leaves at 160, and comes back at `returnAt`. */
const drawScene = (clips: Partial<Record<AnimStateName, number>>, returnAt = 260, n = 330) => {
  const w = worldFromRows(walledRoom(40, 12), { seed: 7 })
  const p = spawnPlayer(w, 0, 3.5, 5.5)
  const d = spawnNpc(w, 'drowner', 33.5, 5.5)
  const seen = watch(w, d, n, clips, (i) => {
    if (i === 60) teleport(p, d.pos.x - 6, d.pos.y)
    if (i === 160) teleport(p, 1.5, 1.5)
    if (i === returnAt) teleport(p, d.pos.x - 6, d.pos.y)
  })
  return { w, d, seen }
}

/** Ticks at which the drowner went from not-aggro to aggro. */
const engageTicks = (seen: Seen[]): number[] =>
  seen.filter((s, i) => i > 0 && s.mode === 'aggro' && seen[i - 1].mode !== 'aggro').map((s) => s.tick)

describe('draw — an armed NPC pulls its weapon the tick it engages', () => {
  it('starts on the engage tick, plays all 8 frames exactly once, and the first shot follows the clip', () => {
    const { seen } = drawScene(PACK)
    const [t0] = engageTicks(seen)
    expect(t0, 'the drowner engaged the player').toBeDefined()
    const at = seen.findIndex((s) => s.tick === t0)
    // The sim holds fire for the drowner's drawTicks (its engage wind-up), so
    // no shot lands inside the clip ...
    expect(NPCS.drowner.drawTicks).toBe(DRAW_TICKS)
    const fired = (i: number): boolean => (seen[i].cooldown ?? 0) > (seen[i - 1].cooldown ?? 0)
    expect(seen.slice(at, at + DRAW_TICKS).some((_, k) => fired(at + k))).toBe(false)
    // ... and the first one comes the tick the clip ends: attack takes over
    // directly, no frame of draw and attack competing.
    expect(fired(at + DRAW_TICKS)).toBe(true)
    expect(`${seen[at + DRAW_TICKS].state}@${seen[at + DRAW_TICKS].start}`).toBe(`attack@${t0 + DRAW_TICKS}`)
    const clip = seen.slice(at, at + DRAW_TICKS)
    expect(clip.map((s) => s.state)).toEqual(Array(DRAW_TICKS).fill('draw'))
    expect(clip.every((s) => s.start === t0)).toBe(true)
    expect(clip.map((s) => s.frame)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7])
    // Before engaging: never drawing.
    expect(seen.slice(0, at).some((s) => s.state === 'draw')).toBe(false)
    // The clip ends and hands back; the drowner is still engaged.
    expect(seen[at + DRAW_TICKS].state).not.toBe('draw')
    expect(seen[at + DRAW_TICKS].mode).toBe('aggro')
  })

  it('is not re-triggered while the NPC stays engaged (battle -> pursue is still one engagement)', () => {
    const { seen } = drawScene(PACK)
    const [t0] = engageTicks(seen)
    const from = seen.findIndex((s) => s.tick === t0)
    const end = seen.findIndex((s, i) => i > from && s.mode !== 'aggro')
    const contiguous = seen.slice(from, end)
    expect(contiguous.length, 'a long engagement').toBeGreaterThan(DRAW_TICKS * 4)
    expect(new Set(contiguous.filter((s) => s.state === 'draw').map((s) => s.start))).toEqual(new Set([t0]))
  })

  it('re-arms after a real disengage: the next engagement draws again', () => {
    const { seen } = drawScene(PACK)
    const engages = engageTicks(seen)
    expect(engages.length, 'engaged, lost the player, engaged again').toBeGreaterThanOrEqual(2)
    const t1 = engages[1]
    const lastAggro = Math.max(...seen.filter((s) => s.tick < t1 && s.mode === 'aggro').map((s) => s.tick))
    expect(t1 - lastAggro, 'disengaged for longer than the re-arm window').toBeGreaterThan(DRAW_REARM_TICKS)
    const at = seen.findIndex((s) => s.tick === t1)
    expect(seen.slice(at, at + DRAW_TICKS).map((s) => `${s.state}@${s.start}`)).toEqual(
      Array(DRAW_TICKS).fill(`draw@${t1}`),
    )
  })

  it('missing draw frames: the drowner never enters draw and resolves exactly what it would without the feature', () => {
    const withPack = drawScene(PACK).seen
    const without = drawScene(NO_FRAMES).seen
    expect(without.some((s) => s.state === 'draw')).toBe(false)
    // Same seed, same inputs: the sim ran identically, and every tick that was
    // not `draw` resolved the same state in both runs.
    expect(without.map((s) => s.mode)).toEqual(withPack.map((s) => s.mode))
    withPack.forEach((s, i) => {
      if (s.state !== 'draw') expect(without[i].state, `tick ${s.tick}`).toBe(s.state)
      else expect(['attack', 'walk', 'idle'], `tick ${s.tick}`).toContain(without[i].state)
    })
  })

  it('is deterministic: the same seed and inputs give the same states and frames', () => {
    expect(drawScene(PACK).seen).toEqual(drawScene(PACK).seen)
  })
})

describe('draw — the clip fits the sim wind-up', () => {
  it('every archetype with a wind-up holds fire for at least a full 8-frame draw at the default tpf', () => {
    const armed = Object.values(NPCS).filter((d) => (d.drawTicks ?? 0) > 0)
    expect(armed.map((d) => d.archetype).sort()).toEqual(['acolyte', 'bellwether', 'drowner'])
    for (const d of armed) expect(d.drawTicks, d.archetype).toBeGreaterThanOrEqual(MAX_ANIM_FRAMES * DEFAULT_TPF.draw)
  })
})

describe('draw — adversarial engage edges (entity state set exactly, tracker only)', () => {
  const body = (mode: 'aggro' | 'wander'): Entity =>
    ({
      id: 9,
      pos: { x: 5, y: 5 },
      prevPos: { x: 5, y: 5 },
      ai: { mode },
    }) as unknown as Entity

  const run = (modes: ('aggro' | 'wander')[]): AnimStateName[] => {
    const mem: AnimMemory = {}
    return modes.map((m, i) => trackAnim(mem, body(m), 100 + i, PACK).state)
  }

  it('a body first seen already engaged does not draw (it was never seen holstered)', () => {
    expect(run(Array(30).fill('aggro'))).not.toContain('draw')
  })

  it('a flicker out of aggro shorter than DRAW_REARM_TICKS does not draw twice', () => {
    const modes = [
      ...Array(5).fill('wander'),
      ...Array(DRAW_TICKS + 4).fill('aggro'),
      ...Array(DRAW_REARM_TICKS - 1).fill('wander'),
      ...Array(DRAW_TICKS + 4).fill('aggro'),
    ]
    const states = run(modes)
    const second = 5 + DRAW_TICKS + 4 + DRAW_REARM_TICKS - 1
    expect(states.slice(5, 5 + DRAW_TICKS)).toEqual(Array(DRAW_TICKS).fill('draw'))
    expect(states.slice(second)).not.toContain('draw')
  })

  it('exactly DRAW_REARM_TICKS out of aggro re-arms', () => {
    const modes = [
      'wander',
      ...Array(DRAW_TICKS).fill('aggro'),
      ...Array(DRAW_REARM_TICKS).fill('wander'),
      ...Array(DRAW_TICKS).fill('aggro'),
    ]
    const states = run(modes)
    expect(states.slice(1 + DRAW_TICKS + DRAW_REARM_TICKS)).toEqual(Array(DRAW_TICKS).fill('draw'))
  })

  it('a hit mid-draw shows hurt (hurt outranks draw), and the draw does not restart afterwards', () => {
    const mem: AnimMemory = {}
    const e = body('wander')
    const states: string[] = []
    for (let i = 0; i < 40; i++) {
      e.ai!.mode = i === 0 ? 'wander' : 'aggro'
      if (i === 4) e.status = { stun: 0, sleep: 0, hitFlashUntil: 100 + i + 3, cloakUntil: 0 }
      states.push(trackAnim(mem, e, 100 + i, PACK).state)
    }
    expect(states.slice(1, 4)).toEqual(['draw', 'draw', 'draw'])
    expect(states.slice(4, 12)).toEqual(Array(8).fill('hurt'))
    // What is left of the draw window still plays out, then it is done for good.
    expect(states.slice(12, 1 + DRAW_TICKS)).toEqual(Array(1 + DRAW_TICKS - 12).fill('draw'))
    expect(states.slice(1 + DRAW_TICKS)).not.toContain('draw')
  })
})

// ---------------------------------------------------------------------------
// fidget

/** Two gloamhounds on a short tether (speed 0, set exactly): the real AI runs
 * and wants to wander, but they cannot go anywhere, so they stand still. */
const tethered = (w: World, x: number, y: number): Entity => {
  const h = spawnNpc(w, 'gloamhound', x, y)
  h.speed = 0
  return h
}
const kennel = (clips: Partial<Record<AnimStateName, number>>, n = 900) => {
  const w = worldFromRows(walledRoom(20, 10), { seed: 11 })
  const a = tethered(w, 9.5, 3.5)
  const b = tethered(w, 9.5, 6.5)
  const memA: AnimMemory = {}
  const memB: AnimMemory = {}
  const seenA: Seen[] = []
  const seenB: Seen[] = []
  for (let i = 0; i < n; i++) {
    runTicks(w, new Map(), 1)
    for (const [e, mem, seen] of [
      [a, memA, seenA],
      [b, memB, seenB],
    ] as const) {
      const r = trackAnim(mem, e, w.tick, clips)
      const frames = r.state === 'fidget' ? FIDGET_FRAMES : 1
      seen.push({
        tick: w.tick,
        state: r.state,
        start: r.start,
        frame: animFrame(r.state, frames, w.tick, r.start, DEFAULT_TPF[r.state], e.id),
        mode: e.ai?.mode,
        cooldown: e.combat?.cooldown,
      })
    }
  }
  return { w, a, b, seenA, seenB }
}

/** Distinct fidget start ticks in a trace. */
const fidgetStarts = (seen: Seen[]): number[] => [...new Set(seen.filter((s) => s.state === 'fidget').map((s) => s.start))]

describe('fidget — an occasional idle variant on a still, calm body', () => {
  it('the tether holds: both hounds are calm and never move', () => {
    const { seenA, seenB } = kennel(PACK, 300)
    for (const s of [...seenA, ...seenB]) {
      expect(['idle', 'fidget']).toContain(s.state)
      expect(['aggro', 'flee', 'seek']).not.toContain(s.mode)
    }
  })

  it('only after FIDGET.stillTicks of stillness, then plays all 8 frames once and returns to idle', () => {
    const { seenA, seenB } = kennel(PACK)
    for (const seen of [seenA, seenB]) {
      const firstTick = seen[0].tick // still from the first observation
      const starts = fidgetStarts(seen)
      expect(starts.length, 'fidgets more than once in 30 s').toBeGreaterThanOrEqual(2)
      expect(starts[0] - firstTick).toBeGreaterThanOrEqual(FIDGET.stillTicks)
      expect(seen.filter((s) => s.tick < firstTick + FIDGET.stillTicks).some((s) => s.state === 'fidget')).toBe(false)
      for (const s0 of starts) {
        const at = seen.findIndex((s) => s.tick === s0)
        if (at + FIDGET_TICKS > seen.length) continue // cut off by the end of the trace
        const clip = seen.slice(at, at + FIDGET_TICKS)
        expect(clip.map((s) => s.state)).toEqual(Array(FIDGET_TICKS).fill('fidget'))
        expect(clip.map((s) => s.frame)).toEqual(Array.from({ length: FIDGET_TICKS }, (_, k) => Math.floor(k / 3)))
        if (at + FIDGET_TICKS < seen.length) expect(seen[at + FIDGET_TICKS].state).toBe('idle')
      }
      // Occasional: consecutive fidgets are a whole period apart.
      for (let k = 1; k < starts.length; k++) expect(starts[k] - starts[k - 1]).toBeGreaterThanOrEqual(FIDGET.period)
    }
  })

  it('is staggered: two hounds side by side never start a fidget on the same tick', () => {
    const { seenA, seenB } = kennel(PACK)
    const a = fidgetStarts(seenA)
    const b = fidgetStarts(seenB)
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(a.filter((t) => b.includes(t))).toEqual([])
  })

  it('is deterministic: the same seed gives the same fidgets, frame for frame', () => {
    const one = kennel(PACK)
    const two = kennel(PACK)
    expect(two.seenA).toEqual(one.seenA)
    expect(two.seenB).toEqual(one.seenB)
  })

  it('missing fidget frames: never fidgets, idles exactly as today', () => {
    const { seenA, seenB } = kennel(NO_FRAMES)
    for (const s of [...seenA, ...seenB]) expect(s.state).toBe('idle')
  })

  it('never while engaged: a hound that sees the player never fidgets, even standing still', () => {
    const w = worldFromRows(walledRoom(20, 10), { seed: 11 })
    spawnPlayer(w, 0, 4.5, 4.5)
    const a = tethered(w, 9.5, 3.5)
    const seen = watch(w, a, 600, PACK)
    expect(seen.some((s) => s.mode === 'aggro'), 'the hound engaged').toBe(true)
    for (const s of seen) if (s.mode === 'aggro' || s.mode === 'flee') expect(s.state, `tick ${s.tick}`).not.toBe('fidget')
  })

  it('never while walking: a free hound in an open room only fidgets on still ticks', () => {
    const w = worldFromRows(walledRoom(24, 14), { seed: 5 })
    const h = spawnNpc(w, 'gloamhound', 12.5, 7.5)
    const states: { state: AnimStateName; moving: boolean }[] = []
    const mem: AnimMemory = {}
    for (let i = 0; i < 1500; i++) {
      runTicks(w, new Map(), 1)
      const moving = h.pos.x !== h.prevPos.x || h.pos.y !== h.prevPos.y
      states.push({ state: trackAnim(mem, h, w.tick, PACK).state, moving })
    }
    expect(states.some((s) => s.moving), 'the hound wandered').toBe(true)
    for (const s of states) if (s.state === 'fidget') expect(s.moving).toBe(false)
  })

  it('a hit cancels a fidget into hurt and restarts the stillness count', () => {
    const first = kennel(PACK, 0)
    const s0 = fidgetStarts(watch(first.w, first.a, 900, PACK))[0]
    expect(s0).toBeDefined()
    // The same world from scratch, the hound hit 3 ticks into that fidget.
    const { w, a } = kennel(PACK, 0)
    const hitAt = s0 + 3
    const seen = watch(w, a, 900, PACK, () => {
      if (w.tick + 1 === hitAt) a.status = { ...a.status!, hitFlashUntil: hitAt + 3 }
    })
    const at = seen.findIndex((s) => s.tick === hitAt)
    expect(seen.slice(at - 3, at).map((s) => s.state)).toEqual(['fidget', 'fidget', 'fidget'])
    expect(seen.slice(at, at + 8).map((s) => s.state)).toEqual(Array(8).fill('hurt'))
    const next = fidgetStarts(seen.slice(at))
    expect(next.length).toBeGreaterThan(0)
    expect(next[0] - (hitAt + 8), 'still again only after the hurt window').toBeGreaterThanOrEqual(FIDGET.stillTicks)
  })
})

describe('fidget schedule — pure in (id, tick, stillSince, clip length)', () => {
  it('no stillness or no clip: never', () => {
    for (let t = 0; t < 2000; t += 7) {
      expect(fidgetStart(4, t, undefined, FIDGET_TICKS)).toBeUndefined()
      expect(fidgetStart(4, t, 0, 0)).toBeUndefined()
    }
  })

  it('a crowd of 32 consecutive ids spreads its first fidget over many distinct ticks', () => {
    const firsts = Array.from({ length: 32 }, (_, id) => {
      for (let t = 0; t < 2000; t++) if (fidgetStart(id, t, 0, FIDGET_TICKS) !== undefined) return t
      return -1
    })
    expect(firsts).not.toContain(-1)
    expect(new Set(firsts).size).toBeGreaterThanOrEqual(28)
  })

  it('a clip longer than the base period never overlaps the next fidget', () => {
    const long = 8 * 30 // 8 frames at the slowest manifest cadence
    for (const id of [0, 1, 2, 77, 1234]) {
      expect(fidgetGrid(id, long).period).toBeGreaterThanOrEqual(long + FIDGET.gap)
      let prevStart: number | undefined
      for (let t = 0; t < 3000; t++) {
        const s = fidgetStart(id, t, 0, long)
        if (s !== undefined && s !== prevStart) {
          if (prevStart !== undefined) expect(s - prevStart).toBeGreaterThanOrEqual(long + FIDGET.gap)
          prevStart = s
        }
      }
    }
  })
})
