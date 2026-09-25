// @vitest-environment happy-dom
//
// The LOAD path's behaviour, which is where the tolerance actually changes what
// a person sees:
//
//   within tolerance  -> hands over control, SILENTLY. No banner about it, no
//                        console.warn. Noise in the last bits of a double is
//                        not information, and a "diverged slightly" notice
//                        trains the viewer to ignore the message that matters.
//   beyond tolerance  -> refuses loudly, and says which tick, which field, both
//                        values, and by how much.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureState, StateRing, type StateLinkCheck, type StateLinkPayload } from '../debug/stateLink'
import { spawnNpc } from '../game/populate'
import { spawnPlayer } from '../game/player'
import { deserializeWorld } from '../game/serialize'
import { runTicks } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { createWorld, tickWorld, type World } from '../game/world'
import { startStateReplay } from './stateReplay'

const DRIVE: Map<number, InputCmd> = new Map([[0, { ...emptyInput(), moveX: 1, attack: true }]])

const buildMidRun = (seed: number): World => {
  const w = createWorld(seed, 1)
  const sp = w.level.spawn
  spawnPlayer(w, 0, sp.x, sp.y)
  spawnNpc(w, 'cop', sp.x + 3, sp.y)
  spawnNpc(w, 'thug', sp.x - 3, sp.y)
  return runTicks(w, new Map([[0, { moveX: -1, attack: true }]]), 50)
}

const captureWithRewind = (seed: number): StateLinkPayload => {
  const w = buildMidRun(seed)
  const ring = new StateRing(w, 20)
  for (let i = 0; i < 50; i++) {
    tickWorld(w, new Map(DRIVE))
    ring.observe(w, DRIVE)
  }
  return JSON.parse(JSON.stringify(captureState(w, { note: 'replay' }, ring.rewind()))) as StateLinkPayload
}

/** Drive a payload's replay to completion against a world restored from its
 * rewind — exactly what main.ts's frame loop does. */
const runReplay = (payload: StateLinkPayload): { check: StateLinkCheck; banner: string; mount: HTMLElement } => {
  const mount = document.createElement('div')
  const world = deserializeWorld(payload.rewind!.world)
  let check!: StateLinkCheck
  const replay = startStateReplay(payload, () => world, mount, (c) => (check = c))
  while (replay.active) replay.step()
  const el = mount.querySelector('[data-role="state-replay-banner"]')
  return { check, banner: el?.textContent ?? '', mount }
}

afterEach(() => vi.restoreAllMocks())

describe('a replay that reconverges', () => {
  it('hands over control and says nothing about float noise', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { check, banner } = runReplay(captureWithRewind(0xc0de))

    expect(check.ok).toBe(true)
    expect(check.difference).toBeUndefined()
    expect(banner).toContain('LIVE')
    expect(banner).not.toMatch(/DIVERG|toleran|drift/i)
    // SILENT. This is the assertion he asked for by name.
    expect(errors).not.toHaveBeenCalled()
    expect(warns).not.toHaveBeenCalled()
  })

  it('publishes the verdict for e2e and for anyone automating a bug report', () => {
    runReplay(captureWithRewind(0xb0b))
    const published = (window as unknown as { __stateReplay: { ok: boolean; world: { tick: number } } }).__stateReplay
    expect(published.ok).toBe(true)
    expect(published.world.tick).toBeGreaterThan(0)
  })
})

describe('a replay that genuinely diverges', () => {
  it('refuses, and names the tick, the field, both values and the magnitude', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const payload = captureWithRewind(0xa11ce)
    // Sabotage the RNG cursor of the world the replay STARTS from: every
    // subsequent roll comes off the wrong stream. The world still LOOKS right.
    payload.rewind!.world.rng += 1

    const { check, banner } = runReplay(payload)

    expect(check.ok).toBe(false)
    // THE TICK — recorded per-tick signatures, which the load path used to
    // throw away. The very first replayed tick already draws from the stream.
    expect(check.divergedAtTick).toBe(payload.rewind!.frames[0]!.tick)
    expect(check.reason).toMatch(/from tick \d+/)
    expect(banner).toContain('DIVERGED')
    expect(banner).toMatch(/first drifted at tick \d+/)
    expect(banner).toContain('expected')
    expect(banner).toContain('got')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('did not reconverge'))
  })

  it('names a nudged position and how far past the tolerance it is', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const payload = captureWithRewind(0xdecaf)
    // Corrupt the CAPTURED end state instead, so the replay itself is fine and
    // the final compare is what fails — on one nameable float field.
    const e = payload.world.entities[0] as { pos: { x: number } }
    e.pos.x += 0.25

    const { check, banner } = runReplay(payload)

    expect(check.ok).toBe(false)
    expect(check.difference?.path).toBe('entities[0].pos.x')
    // No per-tick signature moved (a position drift draws no dice and spawns
    // nothing), so the tick is honestly unknown rather than guessed.
    expect(check.divergedAtTick).toBeUndefined()
    expect(banner).not.toMatch(/first drifted at tick/)
    expect(banner).toMatch(/off by 2\.50e-1/)
    expect(banner).toMatch(/tolerance 1e-10/)
  })

  it('blames build skew on the banner when the capture came from another build', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const payload = captureWithRewind(0xfeed)
    payload.meta.build = 'some-other-build'
    ;(payload.world.entities[0] as { pos: { x: number } }).pos.x += 0.25

    expect(runReplay(payload).banner).toContain('captured on build some-other-build')
  })

  it('does NOT blame build skew when the builds match', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const payload = captureWithRewind(0xbeef)
    delete payload.meta.build
    ;(payload.world.entities[0] as { pos: { x: number } }).pos.x += 0.25

    expect(runReplay(payload).banner).not.toContain('captured on build')
  })
})
