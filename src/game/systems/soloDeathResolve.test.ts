// Ticket #52 — solo death must ALWAYS resolve (self-revive or run-over), never
// an infinite DOWNED dead-end that pulses the low-health vignette red forever.
//
// The failure this pins: a downed solo player (hp 0, bleed-out timer running) is
// still a live entity in the world. Damage-over-time paths that mutate hp
// directly — elementSystem (burning/poison) and the electrified shock — bypass
// the `downed` guard that applyDamage honours, drive hp below 0, and call kill()
// again. kill() on an already-downed player RESET the bleed timer to a fresh
// 900 ticks, so a downed-while-burning solo player is re-killed every DOT
// interval and NEVER bleeds out to a self-revive → stuck downed → red forever.
import { beforeEach, describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { createWorld, tickWorld, type World } from '../world'
import { emptyInput, type InputCmd } from '../types'
import { kill } from './combat'
import { ignite } from './fire'
import { addStatus } from './statusFx'
import { ELEMENTS } from '../data/elements'

const idle = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))

/** Down a player through the real kill() path so the life-gate is honoured. */
const down = (w: World, p: ReturnType<typeof spawnPlayer>): void => {
  p.health!.hp = 1
  kill(w, p)
}

/** Tick the whole sim until the downed player resolves, or the budget runs out. */
const tickUntilResolved = (w: World, p: ReturnType<typeof spawnPlayer>, budget = 2000): number => {
  let n = 0
  while (n < budget && p.playerCtl!.downed && !p.dead) {
    tickWorld(w, idle(p.playerCtl!.playerId))
    n++
  }
  return n
}

describe('#52 solo death always resolves — the infinite-downed dead-end', () => {
  let w: World
  beforeEach(() => {
    // Solo, normal mode.
    w = createWorld(7, 1)
  })

  it('a solo player downed while BURNING self-revives WITHIN the bleed window (DOT never re-arms the timer)', () => {
    const p = spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
    // Light the tile the player is standing on and put them ON fire, then down
    // them — exactly the "died to a molotov" case.
    ignite(w, p)
    addStatus(w, p, 'burning', ELEMENTS.burning.durationTicks)
    down(w, p)
    expect(p.playerCtl!.downed).toBeDefined()

    const ticks = tickUntilResolved(w, p, 2000)

    // MUST have resolved: self-revived (hp > 0, downed cleared) — not stuck.
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.dead).toBeFalsy()
    expect(p.health!.hp).toBeGreaterThan(0)
    // …and it must resolve within the intended 30s bleed-out window. Before the
    // fix, burning re-kills the downed body every DOT tick, re-arming the timer
    // and dragging this out to ~1495 ticks (~50s of stuck red). A downed player
    // is out of the fight — DOT must not touch them.
    expect(ticks).toBeLessThanOrEqual(30 * 30 + 5)
  })

  it('the plain solo down (no DOT) self-revives within the bleed-out window', () => {
    const p = spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
    down(w, p)
    const ticks = tickUntilResolved(w, p, 1200)
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.dead).toBeFalsy()
    expect(ticks).toBeLessThanOrEqual(30 * 30 + 5) // resolves by the bleed deadline
  })

  it('DOT on a downed player never re-arms the bleed timer (kill() is inert while already downed)', () => {
    const p = spawnPlayer(w, 0, 'soldier', w.level.spawn.x, w.level.spawn.y)
    down(w, p)
    // Simulate 100 ticks of bleed-out progress already elapsed.
    p.playerCtl!.downed!.bleedTicks -= 100
    const progressed = p.playerCtl!.downed!.bleedTicks
    // A DOT tick lands on the downed body: hp already 0, driven negative, kill().
    p.health!.hp = -5
    kill(w, p)
    // The bleed timer must NOT jump back up to a fresh 900 — progress is kept.
    expect(p.playerCtl!.downed!.bleedTicks).toBe(progressed)
    expect(p.dead).toBeFalsy()
  })
})
