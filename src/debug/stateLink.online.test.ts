import { describe, expect, it } from 'vitest'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { spawnPlayer } from '../game/player'
import { walledRoom, worldFromRows } from '../game/testkit'
import { emptyInput, type InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'
import { captureReproducible, replayRewindChecked, StateRing, verifyStateLink } from './stateLink'

/**
 * An online host's share. The host runs ONE world with every player in it and
 * feeds tickWorld a slot → command map that includes the remote guest, so the
 * ring records the guest's commands like a local pad's. These tests run that
 * shape on an authored room: host in slot 0, guest in slot 1.
 */

const room = (): { w: World; guestId: number } => {
  const w = worldFromRows(walledRoom(24, 14), { seed: 31, hostile: false })
  spawnPlayer(w, 0, 3.5, 3.5)
  const guest = spawnPlayer(w, 1, 6.5, 6.5)
  return { w, guestId: guest.id }
}

const cmd = (over: Partial<InputCmd>): InputCmd => ({ ...emptyInput(), ...over })

/** Tick like NetHostSession.tick does: the full map in, the ring fed after. */
const play = (w: World, ring: StateRing, ticks: number, onTick?: (t: number) => void): void => {
  for (let t = 0; t < ticks; t++) {
    const inputs = new Map<number, InputCmd>([
      [0, cmd({ seq: t + 1, aimX: 1, aimY: 0 })],
      [1, cmd({ seq: t + 1, moveX: t % 40 < 20 ? 1 : -1, moveY: 0.5 })],
    ])
    tickWorld(w, inputs)
    onTick?.(t)
    ring.observe(w, inputs)
  }
}

describe('online host state share', () => {
  it("replays the guest's recorded commands and reproduces the captured world", () => {
    const { w, guestId } = room()
    const ring = new StateRing(w)
    play(w, ring, 75)
    const out = captureReproducible(w, { note: 'two players' }, ring.rewind())
    expect(out.runUpDropped).toBeUndefined()
    expect(out.check).toMatchObject({ ok: true })
    expect(out.check.rewindTicks).toBeGreaterThanOrEqual(30)

    // The guest really moved during the run-up, so a replay that ignored slot 1
    // could not have matched.
    const start = deserializeWorld(out.payload.rewind!.world)
    const before = start.byId.get(guestId)!.pos
    const after = w.byId.get(guestId)!.pos
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.5)
    const replayed = replayRewindChecked(out.payload.rewind!).world
    expect(replayed.byId.get(guestId)!.pos).toEqual(after)
  })

  it('a world edited between ticks (a dropped guest expiring) goes up as a still, and says why', () => {
    const { w, guestId } = room()
    const ring = new StateRing(w)
    // NetHostSession.expireGhosts runs outside tickWorld; the replay has no way
    // to know it happened.
    play(w, ring, 75, (t) => {
      if (t === 60) w.byId.get(guestId)!.dead = true
    })
    const out = captureReproducible(w, {}, ring.rewind())
    expect(out.runUpDropped).toMatch(/did not reproduce/)
    expect(out.payload.rewind).toBeUndefined()
    expect(out.check).toEqual({ ok: true, rewindTicks: 0 })
    expect(verifyStateLink(out.payload).ok).toBe(true)
    expect(out.payload.world).toEqual(serializeWorld(w))
  })

  it('without a ring there is nothing to drop', () => {
    const { w } = room()
    const out = captureReproducible(w, {})
    expect(out.runUpDropped).toBeUndefined()
    expect(out.check.ok).toBe(true)
  })
})
