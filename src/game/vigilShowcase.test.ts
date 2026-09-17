// §4.1 THE VIGIL showcase — the sim-side pin for the recorded run.
//
// e2e/vigil.mjs asserts these same beats in a real browser off `window.__world`
// and produces the video. This file asserts them with no browser at all, which
// is what makes the choreography a REGRESSION TEST rather than a demo: if a
// later tuning pass moves the wake table, the noise decay or the resist swap,
// the video's narration goes quietly wrong and only this file says so.
//
// The clip's thesis is CADENCE. One player, one gun — the starter pistol every
// player has and nobody can swap away from — fired two different ways, and a
// boss that answers differently to each. Nothing here arms anybody.
//
// Same shape as input/scripted.test.ts: the real HostSession, the real scenario,
// the real per-tick input timeline, the real systems.

import { describe, expect, it } from 'vitest'
import { HostSession } from '../app/hostSession'
import { applyScenario } from './scenarios'
import { createScriptedInput, SCRIPTS, scriptTicks } from '../input/scripted'
import { PLAYER_START_WEAPON, starterLoadout } from './player'
import { VIGIL_ASLEEP_RESIST, VIGIL_AWAKE_RESIST, VIGIL_WAKE_TICKS, vigilAwake, wakeThreshold } from './systems/vigil'
import type { Entity } from './entity'

/** Tick windows the `vigil` script hands us, derived from its own segments so a
 * timeline edit moves these with it rather than silently desynchronising. The
 * paced beat expands to ten segments (five shot/gap pairs), which is why the
 * indices jump from 1 to 11. */
const seg = SCRIPTS.vigil.map((s) => s.ticks)
const at = (n: number): number => seg.slice(0, n).reduce((a, b) => a + b, 0)
const PACED = { from: at(1), to: at(11) } // five spaced shots, boss DORMANT throughout
const SPRAY = { from: at(11), to: at(12) } // the trigger held down — this is what wakes it
const AWAKE = { from: at(12), to: at(13) } // the same held trigger, now against an awake boss
const GRENADE = at(16)

const play = () => {
  const steps = SCRIPTS.vigil
  const s = new HostSession(7, createScriptedInput(steps))
  applyScenario(s.world, 'vigil')
  const boss = s.world.entities.find((e) => e.ai?.behavior === 'vigil') as Entity
  const player = s.world.entities.find((e) => !!e.playerCtl) as Entity
  const hpAt = new Map<number, number>()
  const wakes: number[] = []
  const settles: number[] = []
  const resistWhileAwake = new Set<number>()
  const resistWhileAsleep = new Set<number>()
  let awake = false
  let wokeDuringPaced = false
  let pacedNoisePeak = 0

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
    if (nowAwake && s.world.tick <= PACED.to) wokeDuringPaced = true
    if (s.world.tick <= PACED.to) pacedNoisePeak = Math.max(pacedNoisePeak, boss.ai!.noise ?? 0)
  }
  hpAt.set(total, boss.health!.hp)
  const damage = (w: { from: number; to: number }): number => hpAt.get(w.from)! - hpAt.get(w.to)!
  return {
    w: s.world, boss, player, wakes, settles, damage,
    wokeDuringPaced, pacedNoisePeak, resistWhileAwake, resistWhileAsleep, total,
  }
}

describe('the `vigil` showcase run tells the truth about the fight', () => {
  const r = play()

  it('the timeline e2e/vigil.mjs mirrors is still the timeline this file runs', () => {
    // e2e/vigil.mjs cannot import TypeScript, so it hard-codes a copy of these
    // segment lengths and takes its beat windows from it. That header has always
    // claimed "a drift between the two fails there" — it did not, because every
    // window on this side is DERIVED from SCRIPTS and so moves silently with it.
    // This is the assertion that makes the claim true. Edit the timeline → edit
    // the array in e2e/vigil.mjs → edit this line.
    expect(seg).toEqual([40, 1, 44, 1, 44, 1, 44, 1, 44, 1, 44, 160, 90, 60, 90, 20, 1, 60, 60, 300, 40])
  })

  it('the player fought the whole clip with the starter pistol and nothing else', () => {
    // The root cause of the original bug, pinned at the level the video shows:
    // if this ever fails, the clip is narrating a fight the player cannot have.
    expect(r.player.loadout).toEqual(starterLoadout(PLAYER_START_WEAPON))
    expect(r.player.combat!.weapon).toBe(PLAYER_START_WEAPON)
  })

  it('BEAT 1: paced pistol fire takes real hp off a DORMANT Vigil', () => {
    expect(r.damage(PACED)).toBeGreaterThan(0)
  })

  it('BEAT 1: and never wakes it — five spaced shots leave the budget untouched', () => {
    // The fight's promise, and the half that was unreachable when it shipped.
    // Being SHOT is silent to it; being shot FAST is not.
    expect(r.wokeDuringPaced).toBe(false)
    // Not merely "under the threshold" — barely on the meter at all. A shot's
    // charge decays away before the next one lands, so the peak is one shot's
    // worth (~6.2 of 45) however long the player keeps it up.
    expect(r.pacedNoisePeak).toBeLessThan(wakeThreshold(r.w) / 4)
  })

  it('BEAT 2: HOLDING THE TRIGGER is what wakes it — cadence, not injury', () => {
    expect(r.wakes.length).toBeGreaterThanOrEqual(1)
    expect(r.wakes[0]).toBeGreaterThan(SPRAY.from)
    expect(r.wakes[0]).toBeLessThanOrEqual(SPRAY.to)
  })

  it('BEAT 3: awake, the very same gun barely scratches it', () => {
    // 1.5 vs 0.15 — a full order of magnitude. Asserted as a RATIO, and the
    // comparison is deliberately unfair in the AWAKE beat's favour: it lands
    // more shots (held trigger) than the paced beat does, and still does a
    // fraction of the damage. Only the resist swap can produce that.
    expect(r.damage(AWAKE)).toBeGreaterThan(0)
    expect(r.damage(PACED)).toBeGreaterThan(r.damage(AWAKE) * 5)
  })

  it('the resist swap is real and goes BOTH ways', () => {
    expect([...r.resistWhileAwake]).toEqual([VIGIL_AWAKE_RESIST])
    expect([...r.resistWhileAsleep]).toEqual([VIGIL_ASLEEP_RESIST])
  })

  it('BEAT 4: backing off and holding fire SETTLES it back to dormant', () => {
    expect(r.settles.length).toBeGreaterThanOrEqual(1)
    expect(r.settles[0] - r.wakes[0]).toBe(VIGIL_WAKE_TICKS[0])
  })

  it('BEAT 5: the grenade still wakes it, and that wake lasts longer than the first', () => {
    expect(r.wakes.length).toBeGreaterThanOrEqual(2)
    expect(r.wakes[1]).toBeGreaterThan(GRENADE)
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
