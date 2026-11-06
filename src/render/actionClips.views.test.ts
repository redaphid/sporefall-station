// attack, hurt and death as DRAWN clips at the entity layer: EntityViews over a
// real createArt registry and a fake pack (animTestkit.ts), the real sim
// underneath, read back tick by tick.
//
// The contract (animState.ts OnceWindow `{ clipAtLeast }`): a pack that draws
// one of these states plays its whole clip, frames × tpf, never less than the
// fixed window; without frames nothing changes (the golden trace in
// actionAnims.views.test.ts). The effects timed against the fixed window keep
// it: the weapon swing, the lunge, the hit flash, the death topple.

import { describe, expect, it } from 'vitest'
import { runTicks } from '../game/testkit'
import { HURT_FLASH_TICKS, hurtStart, STATE_TICKS } from './animState'
import { brawlScene, fakeArt, shown, trace, type Frame, type Scene } from './animTestkit'

/** The brawl with the player holding fire: the mutant swings at a player it
 * never quite reaches, and nobody is hurt. */
const swingScene = (): Scene => ({ ...brawlScene(), inputs: new Map() })

/** Ticks (index into frames) where `state.0` begins. */
const onsets = (frames: Frame[], state: string): number[] =>
  frames.flatMap((f, i) => (shown(f) === `${state}.0` && (i === 0 || shown(frames[i - 1]) !== `${state}.0`) ? [i] : []))

/** The label sequence a clip of `n` frames at `tpf` shows from its onset. */
const clip = (state: string, n: number, tpf: number): string[] =>
  Array.from({ length: n * tpf }, (_, k) => `${state}.${Math.floor(k / tpf)}`)

/** The mutant swings its wrench every 15 ticks, so a clip up to 15 ticks
 * plays whole between swings. */
const SWING_EVERY = 15

describe('a drawn attack plays its whole clip', () => {
  const scene = swingScene()
  const mutant = scene.focus[1]
  const drawn = trace(scene, fakeArt({ mutant: { attack: 7 } }))[mutant.id]
  const plain = trace(swingScene(), fakeArt())[mutant.id]

  it('7 frames at tpf 2: attack.0 .. attack.6 over 14 ticks from every swing, then out of the state', () => {
    const at = onsets(drawn, 'attack')
    expect(at.length).toBeGreaterThanOrEqual(8)
    for (const i of at.filter((i) => i + 14 < drawn.length)) {
      expect(drawn.slice(i, i + 14).map(shown)).toEqual(clip('attack', 7, 2))
      expect(shown(drawn[i + 14])).not.toMatch(/^attack\.6$/)
    }
  })

  it('a swing that lands mid-clip restarts it: an 8-frame clip (16 ticks) loses its last tick', () => {
    const long = trace(swingScene(), fakeArt({ mutant: { attack: 8 } }))[mutant.id]
    const at = onsets(long, 'attack')
    for (let k = 0; k + 1 < at.length; k++) {
      expect(at[k + 1] - at[k]).toBe(SWING_EVERY)
      expect(long.slice(at[k], at[k + 1]).map(shown)).toEqual(clip('attack', 8, 2).slice(0, SWING_EVERY))
    }
  })

  it('each swing starts on the tick the sim raised combat.cooldown', () => {
    const s = swingScene()
    const m = s.focus[1]
    const rose: number[] = []
    for (let i = 0, cd = m.combat!.cooldown; i < s.n; i++) {
      runTicks(s.w, new Map(), 1)
      if (m.combat!.cooldown > cd) rose.push(s.w.tick)
      cd = m.combat!.cooldown
    }
    expect(onsets(drawn, 'attack').map((i) => drawn[i].tick)).toEqual(rose)
  })

  it('the held wrench swings on the fixed window: its angle is the same tick for tick as without the clip', () => {
    const angle = (f: Frame): string | undefined => f.weapon?.split('@')[0]
    expect(drawn.map(angle)).toEqual(plain.map(angle))
    expect(new Set(drawn.map(angle)).size).toBeGreaterThan(2) // it does swing
  })

  it('the lunge is over after STATE_TICKS.attack: the rest of the clip stands where the plain body does', () => {
    let checked = 0
    for (const i of onsets(drawn, 'attack').filter((i) => i + 14 < drawn.length)) {
      for (let k = STATE_TICKS.attack; k < 14; k++) {
        expect([drawn[i + k].x, drawn[i + k].y]).toEqual([plain[i + k].x, plain[i + k].y])
        checked++
      }
      // ...and inside the window the lunge moved it.
      expect(drawn[i + 2].x).not.toBe(plain[i + 2].x)
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('a drawn clip shorter than the fixed window holds its last frame to the window', () => {
  it('2 attack frames at tpf 2 (4 ticks) still last STATE_TICKS.attack (6) ticks', () => {
    const scene = swingScene()
    const mutant = scene.focus[1]
    const frames = trace(scene, fakeArt({ mutant: { attack: 2 } }))[mutant.id]
    const at = onsets(frames, 'attack')
    expect(at.length).toBeGreaterThanOrEqual(8)
    for (const i of at.filter((i) => i + 6 < frames.length)) {
      expect(frames.slice(i, i + 6).map(shown)).toEqual(['attack.0', 'attack.0', 'attack.1', 'attack.1', 'attack.1', 'attack.1'])
      expect(shown(frames[i + 6])).not.toMatch(/^attack/)
    }
  })
})

describe('a drawn hurt plays its whole clip under the fixed hit flash', () => {
  it('6 frames at tpf 3 (18 ticks): the flash keeps its 3 ticks, then hurt.1 .. hurt.5 to the clip end', () => {
    // Hurt starts as the renderer derives them (hurtStart of hitFlashUntil),
    // read off the same sim run without rendering.
    const sim = brawlScene()
    const m = sim.focus[1]
    const starts: number[] = []
    for (let i = 0; i < sim.n && !m.dead; i++) {
      runTicks(sim.w, sim.inputs!, 1)
      const s0 = hurtStart(m.status?.hitFlashUntil)
      if (s0 !== undefined && s0 !== starts.at(-1)) starts.push(s0)
    }
    const scene = brawlScene()
    const frames = trace(scene, fakeArt({ mutant: { hurt: 6 } }))[m.id].filter((f) => !f.ghost)
    const whole = starts.filter((s0, k) => (starts[k + 1] ?? Infinity) - s0 >= 18 && s0 + 18 <= frames.at(-1)!.tick)
    expect(whole.length).toBeGreaterThanOrEqual(2)
    for (const s0 of whole) {
      // The hit lands during tick s0 + 1, so the first frame to see it is s0 + 1.
      const seen = frames.filter((f) => f.tick > s0 && f.tick < s0 + 18)
      expect(seen.map((f) => (f.tex === 'EMPTY' ? 'flash' : shown(f)))).toEqual(
        clip('hurt', 6, 3)
          .map((l, k) => (k < HURT_FLASH_TICKS ? 'flash' : l))
          .slice(1),
      )
      expect(shown(frames.find((f) => f.tick === s0 + 18)!)).not.toMatch(/^hurt/)
    }
  })
})

describe('a drawn death plays its whole clip on the ghost', () => {
  const scene = brawlScene()
  const mutant = scene.focus[1]
  const frames = trace(scene, fakeArt({ mutant: { death: 8 } }))[mutant.id]
  const ghost = frames.filter((f) => f.ghost)

  it('8 frames at tpf 5: death.0 .. death.7 over 40 ticks, then the ghost is gone', () => {
    expect(ghost.map(shown)).toEqual(clip('death', 8, 5))
    expect(ghost.map((f) => f.tick)).toEqual(Array.from({ length: 40 }, (_, k) => ghost[0].tick + k))
    expect(frames.at(-1)).toBe(ghost.at(-1)) // nothing after the clip
  })

  it('no topple on drawn frames, and the fade runs over the clip`s last STATE_TICKS.death ticks', () => {
    for (const f of ghost) expect(f.rot).toBe(0)
    // Frames render at view-time tick + 0.5.
    const fadeFrom = 40 - STATE_TICKS.death
    ghost.slice(0, fadeFrom).forEach((f) => expect(f.alpha).toBe(1))
    for (let k = fadeFrom; k < 40; k++) {
      expect(ghost[k].alpha).toBeLessThan(ghost[k - 1].alpha)
      expect(ghost[k].alpha).toBeCloseTo(1 - (k + 0.5 - fadeFrom) / STATE_TICKS.death, 9)
    }
  })

  it('without death frames the ghost lasts STATE_TICKS.death and topples', () => {
    const plain = trace(brawlScene(), fakeArt())[mutant.id].filter((f) => f.ghost)
    expect(plain.length).toBe(STATE_TICKS.death)
    expect(plain.some((f) => f.rot !== 0)).toBe(true)
  })
})
