// The player's draw: when the gun comes up, the motion-captured `draw` clip
// plays and hands into `aim`. Two layers:
// - the tracker alone, with the player's state set exactly each tick (spawn,
//   swaps, revive, lockpick, stun, freeze, a co-op mirror), so every edge is
//   pinned down;
// - the real sim and the real entity layer (EntityViews over a fake pack whose
//   every frame is its own texture), so the clip, the hand-off and the stowed
//   weapon are what the game draws.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../game/entity'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { arm, walledRoom, worldFromRows } from '../game/testkit'
import type { InputCmd } from '../game/types'
import type { World } from '../game/world'
import { DEFAULT_TPF, MAX_ANIM_FRAMES, type AnimStateName } from './animState'
import { fakeArt, shown, tank, trace, type Scene } from './animTestkit'
import { DRAW_REARM_TICKS, trackAnim, type AnimMemory } from './animTracker'

/** The shipped cut: 14 frames at the default draw cadence. */
const DRAW_FRAMES = 14
const DRAW_TICKS = DRAW_FRAMES * DEFAULT_TPF.draw
const PACK = { draw: DRAW_TICKS, aim: 2 * DEFAULT_TPF.idle, aimwalk: 8 * DEFAULT_TPF.walk }
const NO_DRAW = { aim: PACK.aim, aimwalk: PACK.aimwalk }

const room = (): World => worldFromRows(walledRoom(20, 10), { seed: 3 })

const player = (w: World): Entity => {
  const p = spawnPlayer(w, 0, 5.5, 5.5)
  arm(p, 'pistol')
  return p
}

const still = (e: Entity): void => {
  e.prevPos = { ...e.pos }
}
const step = (e: Entity): void => {
  e.prevPos = { ...e.pos }
  e.pos = { x: e.pos.x + 0.1, y: e.pos.y }
}

/** Observe `e` at ticks t0..t0+n-1; `set(i, e)` sets its state exactly before
 * observation i. Returns the state resolved each tick. */
const observe = (
  e: Entity,
  n: number,
  set: (i: number, e: Entity) => void = () => {},
  clips: Partial<Record<AnimStateName, number>> = PACK,
  t0 = 100,
  mem: AnimMemory = {},
): AnimStateName[] => {
  const out: AnimStateName[] = []
  for (let i = 0; i < n; i++) {
    still(e)
    set(i, e)
    out.push(trackAnim(mem, e, t0 + i, clips).state)
  }
  return out
}

const drawsIn = (states: AnimStateName[]): number[] =>
  states.flatMap((s, i) => (s === 'draw' && (i === 0 || states[i - 1] !== 'draw') ? [i] : []))

describe('player draw — the clip fits the engine', () => {
  it('a 14-frame draw is inside the frame grammar, and the default cadence plays it in under a second', () => {
    expect(DRAW_FRAMES).toBeLessThanOrEqual(MAX_ANIM_FRAMES)
    expect(DRAW_TICKS).toBeLessThan(30)
  })
})

describe('player draw — when the gun comes up (tracker, state set exactly)', () => {
  it('first seen standing armed: draws for exactly frames x tpf, then hands straight into aim', () => {
    const s = observe(player(room()), DRAW_TICKS + 10)
    expect(s.slice(0, DRAW_TICKS).every((x) => x === 'draw')).toBe(true)
    expect(s.slice(DRAW_TICKS)).toEqual(Array(10).fill('aim'))
  })

  it('first seen moving: no draw at all, aimwalk from the first tick', () => {
    const s = observe(player(room()), 40, (_, e) => step(e))
    expect(s).toEqual(Array(40).fill('aimwalk'))
  })

  it('first seen unarmed (fists): no draw; arming later while standing draws', () => {
    const p = player(room())
    p.combat!.weapon = 'fists'
    const s = observe(p, 80, (i, e) => {
      if (i === 40) arm(e, 'pistol')
    })
    expect(s.slice(0, 40).includes('draw')).toBe(false)
    expect(drawsIn(s)).toEqual([40])
  })

  it('a swap from a wrench to a gun, and from one gun to another, each draw', () => {
    const p = player(room())
    const s = observe(p, 200, (i, e) => {
      if (i === 40) arm(e, 'wrench')
      if (i === 100) arm(e, 'pistol')
      if (i === 150) arm(e, 'shotgun')
    })
    expect(drawsIn(s)).toEqual([0, 100, 150])
    expect(s.slice(40, 100).includes('aim')).toBe(false) // the wrench is not aimed
  })

  it('a gun down for less than the rearm window comes back up without a re-draw', () => {
    const p = player(room())
    const s = observe(p, 120, (i, e) => {
      if (i === 40) arm(e, 'wrench')
      if (i === 40 + DRAW_REARM_TICKS - 1) arm(e, 'pistol')
    })
    expect(drawsIn(s)).toEqual([0])
    const s2 = observe(player(room()), 120, (i, e) => {
      if (i === 40) arm(e, 'wrench')
      if (i === 40 + DRAW_REARM_TICKS) arm(e, 'pistol')
    })
    expect(drawsIn(s2)).toEqual([0, 40 + DRAW_REARM_TICKS])
  })

  it('a step mid-draw ends it on that tick: aimwalk, and stopping again does not resume the draw', () => {
    const s = observe(player(room()), 60, (i, e) => {
      if (i >= 6 && i < 12) step(e)
    })
    expect(s.slice(0, 6)).toEqual(Array(6).fill('draw'))
    expect(s.slice(6, 12)).toEqual(Array(6).fill('aimwalk'))
    expect(s.slice(12)).toEqual(Array(48).fill('aim'))
  })

  it('a shot mid-draw ends it: the gun is out, the draw never comes back', () => {
    const s = observe(player(room()), 60, (i, e) => {
      if (i === 8) e.combat!.cooldown = 10 // the sim only ever raises it on a shot
      else if (i > 8) e.combat!.cooldown = Math.max(0, e.combat!.cooldown - 1)
    })
    expect(s.slice(0, 8)).toEqual(Array(8).fill('draw'))
    expect(s.slice(8).includes('draw')).toBe(false)
    expect(s.slice(8).every((x) => x === 'aim')).toBe(true) // the undrawn attack yields to aim
  })

  it('a swap fired on the same tick it lands does not draw', () => {
    const p = player(room())
    const s = observe(p, 80, (i, e) => {
      if (i === 40) arm(e, 'wrench')
      if (i === 75) {
        arm(e, 'pistol')
        e.combat!.cooldown = 10
      }
    })
    expect(drawsIn(s)).toEqual([0])
  })

  it('stunned, asleep, frozen or shocked for seconds: the thaw does not re-draw', () => {
    for (const lock of ['stun', 'sleep', 'frozen', 'electrified'] as const) {
      const s = observe(player(room()), 200, (i, e) => {
        const on = i >= 40 && i < 140
        if (lock === 'stun') e.status!.stun = on ? 1 : 0
        else if (lock === 'sleep') e.status!.sleep = on ? 1 : 0
        else if (on) e.fx = { [lock]: { until: 10_000 } }
        else delete e.fx
      })
      expect(drawsIn(s), lock).toEqual([0])
      expect(s.slice(40, 140).includes('aim'), `${lock}: a locked body does not aim`).toBe(false)
      expect(s.slice(140).every((x) => x === 'aim'), lock).toBe(true)
    }
  })

  it('downed, then revived: getting up draws', () => {
    const s = observe(player(room()), 200, (i, e) => {
      if (i === 40) e.playerCtl!.downed = { bleedTicks: 300, reviveProgress: 0 }
      if (i === 140) e.playerCtl!.downed = undefined
    })
    expect(drawsIn(s)).toEqual([0, 140])
  })

  it('a finished lockpick and a finished draft pick each draw', () => {
    const s = observe(player(room()), 260, (i, e) => {
      if (i === 40) e.playerCtl!.channel = { kind: 'lockpick', targetId: 99, ticksLeft: 60, total: 60 }
      if (i === 100) e.playerCtl!.channel = undefined
      if (i === 150) e.playerCtl!.draft = { cards: [] } as unknown as NonNullable<Entity['playerCtl']>['draft']
      if (i === 210) e.playerCtl!.draft = undefined
    })
    expect(drawsIn(s)).toEqual([0, 100, 210])
  })

  it('a pack that draws no draw clip never shows draw, and every other tick resolves the same', () => {
    const script = (i: number, e: Entity): void => {
      if (i === 40) arm(e, 'wrench')
      if (i === 100) arm(e, 'pistol')
      if (i >= 104 && i < 110) step(e)
    }
    const withDraw = observe(player(room()), 160, script)
    const without = observe(player(room()), 160, script, NO_DRAW)
    expect(without.includes('draw')).toBe(false)
    withDraw.forEach((s, i) => {
      if (s !== 'draw') expect(without[i], `tick ${i}`).toBe(s)
      else expect(without[i], `tick ${i}`).toBe('aim')
    })
  })

  it('a co-op mirror (no playerCtl, the host aim verdict) draws on the same edge', () => {
    const w = room()
    const m = player(w)
    delete m.playerCtl
    const s = observe(m, 120, (i, e) => {
      e.aimShown = !(i >= 40 && i < 80) // the host says the gun went down for 40 ticks
    })
    expect(drawsIn(s)).toEqual([0, 80])
    // A stun the host mirrors (gun down, stun flag) is a pause, not a holster.
    const s2 = observe(player(w), 120, (i, e) => {
      delete e.playerCtl
      const stunned = i >= 40 && i < 80
      e.aimShown = !stunned
      e.status!.stun = stunned ? 1 : 0
    })
    expect(drawsIn(s2)).toEqual([0])
  })

  it('an NPC holding a gun never draws from the gun edge: its draw is the engage', () => {
    const w = room()
    const d = spawnNpc(w, 'drowner', 10.5, 5.5)
    d.ai!.mode = 'wander'
    const s = observe(d, 60, (i, e) => {
      e.aimShown = i >= 20 // a gun edge with no engage
    })
    expect(s.includes('draw')).toBe(false)
  })

  it('a rewound tracker (tick goes back) never shows draw from the future', () => {
    const p = player(room())
    const mem: AnimMemory = {}
    observe(p, 10, () => {}, PACK, 500, mem)
    expect(trackAnim(mem, p, 400, PACK).state).not.toBe('draw')
  })
})

/** The real sim: a pistol player stands still, strafes north (aim held east),
 * stops, fires, swaps to a wrench and back. */
const realScene = (input: (i: number) => Partial<InputCmd>, n: number, before: Scene['before'] = () => {}): Scene => {
  const w = worldFromRows(walledRoom(30, 14), { seed: 9 })
  const p = tank(w, 12.5, 9.5)
  arm(p, 'pistol')
  return { w, focus: [p], before, n, inputsAt: (i) => new Map([[0, input(i)]]) }
}

describe('player draw — the real sim at the entity layer', () => {
  const art = fakeArt({ player: { draw: DRAW_FRAMES, aim: 2, aimwalk: 8 } })
  const plain = fakeArt({ player: { aim: 2, aimwalk: 8 } })

  it('standing: draw.0 .. draw.13 at tpf 2 with the held weapon stowed, then aim; strafing: aimwalk, no re-draw', () => {
    const scene = realScene((i) => (i >= 60 && i < 100 ? { aimX: 1, aimY: 0, moveY: -1 } : { aimX: 1, aimY: 0 }), 140)
    const frames = trace(scene, art)[scene.focus[0].id]
    const clip = frames.slice(0, DRAW_TICKS).map(shown)
    expect(clip).toEqual(Array.from({ length: DRAW_TICKS }, (_, k) => `draw.${Math.floor(k / DEFAULT_TPF.draw)}`))
    expect(frames.slice(0, DRAW_TICKS).every((f) => f.weapon === null)).toBe(true)
    // The hand-off: the tick after the last draw frame is the aim hold, gun still drawn by the frames.
    expect(shown(frames[DRAW_TICKS])).toMatch(/^aim\.\d$/)
    expect(frames[DRAW_TICKS].weapon).toBeNull()
    expect(frames.slice(61, 100).every((f) => shown(f).startsWith('aimwalk.'))).toBe(true)
    expect(frames.slice(DRAW_TICKS).some((f) => shown(f).startsWith('draw.'))).toBe(false)
    // Drawn-only: no procedural motion layered on the clip.
    for (const f of frames.slice(0, DRAW_TICKS)) expect([f.rot, Math.abs(f.sx), f.sy]).toEqual([0, 1, 1])
  })

  it('firing mid-draw: the shot wins on its own tick, no draw frame after it', () => {
    const scene = realScene((i) => (i >= 10 ? { aimX: 1, aimY: 0, attack: true } : { aimX: 1, aimY: 0 }), 60)
    const frames = trace(scene, art)[scene.focus[0].id]
    const firstNonDraw = frames.findIndex((f) => !shown(f).startsWith('draw.'))
    // Tick 11 runs the first shot; the frame rendered after it no longer draws.
    expect(firstNonDraw).toBe(10)
    expect(frames.slice(0, 10).every((f) => shown(f).startsWith('draw.'))).toBe(true)
    expect(frames.slice(firstNonDraw).some((f) => shown(f).startsWith('draw.'))).toBe(false)
  })

  it('a swap to a wrench and back, standing, re-draws 120 ticks after the first', () => {
    const scene = realScene(
      () => ({ aimX: 1, aimY: 0 }),
      200,
      (i) => {
        const p = scene.focus[0]
        if (i === 60) arm(p, 'wrench')
        if (i === 120) arm(p, 'pistol')
      },
    )
    const frames = trace(scene, art)[scene.focus[0].id]
    const starts = frames.flatMap((f, i) => (shown(f) === 'draw.0' && (i === 0 || shown(frames[i - 1]) !== 'draw.0') ? [f.tick] : []))
    expect(starts.length).toBe(2)
    expect(starts[1] - starts[0]).toBe(120)
  })

  it('without draw frames the same run never shows draw, and differs only where the draw was', () => {
    const mk = (): Scene => realScene((i) => (i >= 60 && i < 100 ? { aimX: 1, aimY: 0, moveY: -1 } : { aimX: 1, aimY: 0 }), 140)
    const a = trace(mk(), art)
    const b = trace(mk(), plain)
    const fa = Object.values(a)[0]
    const fb = Object.values(b)[0]
    expect(fb.some((f) => shown(f).startsWith('draw.'))).toBe(false)
    fa.forEach((f, i) => {
      if (!shown(f).startsWith('draw.')) expect(fb[i]).toEqual(f)
    })
  })

  it('is deterministic: the same seed and inputs give the same frames', () => {
    const mk = (): Scene => realScene((i) => ({ aimX: 1, aimY: 0, moveX: i % 50 < 10 ? 1 : 0 }), 150)
    expect(trace(mk(), art)).toEqual(trace(mk(), art))
  })
})

