// §4.1 THE VIGIL showcase — the sim-side pin for the recorded run.
//
// e2e/vigil.mjs asserts these same beats in a real browser off `window.__world`
// and produces the video. This file asserts them with no browser at all, which
// is what makes the choreography a REGRESSION TEST rather than a demo: if a
// later tuning pass moves the wake table, the noise decay or the resist swap,
// the video's narration goes quietly wrong and only this file says so.
//
// Same shape as input/scripted.test.ts: the real HostSession, the real scenario,
// the real per-tick input timeline, the real systems.

import { describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { applyScenario } from './scenarios'
import { createScriptedInput, SCRIPTS, scriptTicks } from '../input/scripted'
import { VIGIL_ASLEEP_RESIST, VIGIL_AWAKE_RESIST, VIGIL_WAKE_TICKS, vigilAwake } from './systems/vigil'
import type { Entity } from './entity'

/** Tick windows the `vigil` script hands us, derived from its own segments so a
 * timeline edit moves these with it rather than silently desynchronising. */
const seg = SCRIPTS.vigil.map((s) => s.ticks)
const at = (n: number): number => seg.slice(0, n).reduce((a, b) => a + b, 0)
const BEAT1 = { from: at(2), to: at(3) } // knife, dormant
const BEAT2 = { from: at(5), to: at(6) } // knife, awake
const GRENADE1 = at(3)

const play = () => {
  const steps = SCRIPTS.vigil
  const s = new HostSession(7, createScriptedInput(steps))
  applyScenario(s.world, 'vigil')
  const boss = s.world.entities.find((e) => e.ai?.behavior === 'vigil') as Entity
  const hpAt = new Map<number, number>()
  const wakes: number[] = []
  const settles: number[] = []
  const resistWhileAwake = new Set<number>()
  const resistWhileAsleep = new Set<number>()
  let awake = false
  let wokeDuringBeat1 = false

  const total = scriptTicks(steps)
  for (let t = 0; t <= total; t++) {
    hpAt.set(t, boss.health!.hp)
    s.tick()
    const nowAwake = vigilAwake(boss)
    if (nowAwake && !awake) wakes.push(s.world.tick)
    if (!nowAwake && awake) settles.push(s.world.tick)
    awake = nowAwake
    if (nowAwake) resistWhileAwake.add(boss.resist!.physical!)
    else resistWhileAsleep.add(boss.resist!.physical!)
    if (nowAwake && s.world.tick <= BEAT1.to) wokeDuringBeat1 = true
  }
  hpAt.set(total, boss.health!.hp)
  const damage = (w: { from: number; to: number }): number => hpAt.get(w.from)! - hpAt.get(w.to)!
  return { w: s.world, boss, wakes, settles, damage, wokeDuringBeat1, resistWhileAwake, resistWhileAsleep, total }
}

describe('the `vigil` showcase run tells the truth about the fight', () => {
  const r = play()

  it('BEAT 1: a dormant Vigil takes real damage from the knife', () => {
    expect(r.damage(BEAT1)).toBeGreaterThan(0)
  })

  it('BEAT 1: and being hit that hard NEVER wakes it — damage is silent', () => {
    // The contradiction systems/vigil.ts exists to resolve, restated at the
    // level a viewer of the video can check.
    expect(r.wokeDuringBeat1).toBe(false)
  })

  it('BEAT 2: the GRENADE is what wakes it — loudness, not injury', () => {
    expect(r.wakes.length).toBeGreaterThanOrEqual(1)
    expect(r.wakes[0]).toBeGreaterThan(GRENADE1)
  })

  it('BEAT 2: awake, the same knife barely scratches it', () => {
    // 1.5 vs 0.15 — a full order of magnitude. Asserted as a RATIO between two
    // equal-length beats of the identical weapon, so it survives retuning of
    // the knife, the cadence or the beat length; only the resist swap moves it.
    expect(r.damage(BEAT2)).toBeGreaterThan(0)
    expect(r.damage(BEAT1)).toBeGreaterThan(r.damage(BEAT2) * 5)
  })

  it('the resist swap is real and goes BOTH ways', () => {
    expect([...r.resistWhileAwake]).toEqual([VIGIL_AWAKE_RESIST])
    expect([...r.resistWhileAsleep]).toEqual([VIGIL_ASLEEP_RESIST])
  })

  it('BEAT 3: backing off and going quiet SETTLES it back to dormant', () => {
    expect(r.settles.length).toBeGreaterThanOrEqual(1)
    expect(r.settles[0] - r.wakes[0]).toBe(VIGIL_WAKE_TICKS[0])
  })

  it('BEAT 4: the second wake lasts longer than the first', () => {
    expect(r.wakes.length).toBeGreaterThanOrEqual(2)
    expect(r.settles.length).toBeGreaterThanOrEqual(2)
    const first = r.settles[0] - r.wakes[0]
    const second = r.settles[1] - r.wakes[1]
    expect(second).toBeGreaterThan(first)
    expect(second).toBe(VIGIL_WAKE_TICKS[1])
  })

  it('the clip ends on a dormant, soft Vigil — the meter narrates itself', () => {
    expect(vigilAwake(r.boss)).toBe(false)
    expect(r.boss.resist!.physical).toBe(VIGIL_ASLEEP_RESIST)
    const meter = r.w.annotations.find((a) => a.id === `vigil:${r.boss.id}`)
    expect(meter?.text).toContain('ASLEEP')
  })

  it('the boss survives the whole clip, so every beat is on camera', () => {
    expect(r.boss.dead).toBeFalsy()
    expect(r.boss.health!.hp).toBeGreaterThan(0)
  })
})
