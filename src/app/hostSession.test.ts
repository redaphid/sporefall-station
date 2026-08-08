import { describe, it, expect, beforeEach } from 'vitest'
import { HostSession } from './hostSession'
import { serializeWorld } from '../game/serialize'
import { emptyInput, type InputCmd } from '../game/types'
import type { CoopSample } from '../input/gamepadCoop'

const stubInput = { sample: () => emptyInput() }

const moving = (): InputCmd => ({ ...emptyInput(), moveX: 1, moveY: 0 })

const scripted = (samples: CoopSample[]) => {
  const q = [...samples]
  return { sample: () => q.shift() ?? { inputs: new Map(), joins: [], leaves: [], pauses: [] } }
}

const players = (s: HostSession) => s.world.entities.filter((e) => e.playerCtl)

describe('HostSession local co-op', () => {
  describe('the first pad shares player 0 (the camera target)', () => {
    let session: HostSession
    beforeEach(() => {
      const coop = scripted([
        { inputs: new Map([[0, moving()]]), joins: [0], leaves: [], pauses: [] },
        { inputs: new Map([[0, moving()]]), joins: [], leaves: [], pauses: [] },
      ])
      session = new HostSession(1, stubInput, coop)
    })
    it('does not spawn a second avatar for the first pad', () => {
      session.tick()
      expect(players(session)).toHaveLength(1)
    })
    it('drives the existing self entity', () => {
      const startX = session.self.pos.x
      session.tick()
      session.tick()
      expect(session.self.pos.x).toBeGreaterThan(startX)
    })
  })

  describe('a second pad joins as its own player', () => {
    let session: HostSession
    beforeEach(() => {
      const coop = scripted([{ inputs: new Map(), joins: [1], leaves: [], pauses: [] }])
      session = new HostSession(1, stubInput, coop)
      session.tick()
    })
    it('spawns a second player entity', () => {
      expect(players(session)).toHaveLength(2)
    })
    it('gives it player id 1', () => {
      const ids = players(session).map((e) => e.playerCtl!.playerId)
      expect(ids).toContain(1)
    })
  })

  describe('routing a joined pad to its player', () => {
    it('moves player 1 from that pad input', () => {
      const coop = scripted([
        { inputs: new Map([[1, moving()]]), joins: [1], leaves: [], pauses: [] },
        { inputs: new Map([[1, moving()]]), joins: [], leaves: [], pauses: [] },
      ])
      const session = new HostSession(1, stubInput, coop)
      session.tick()
      const p1 = players(session).find((e) => e.playerCtl!.playerId === 1)!
      const startX = p1.pos.x
      session.tick()
      expect(p1.pos.x).toBeGreaterThan(startX)
    })
  })

  describe('pause', () => {
    it('freezes the sim while paused', () => {
      const coop = scripted([
        { inputs: new Map([[0, moving()]]), joins: [0], leaves: [], pauses: [0] },
        { inputs: new Map([[0, moving()]]), joins: [], leaves: [], pauses: [] },
      ])
      const session = new HostSession(1, stubInput, coop)
      session.tick()
      const x = session.self.pos.x
      session.tick()
      expect(session.self.pos.x).toBe(x)
      expect(session.isPaused).toBe(true)
    })
    it('resumes when Start is pressed again', () => {
      const coop = scripted([
        { inputs: new Map(), joins: [0], leaves: [], pauses: [0] },
        { inputs: new Map([[0, moving()]]), joins: [], leaves: [], pauses: [0] },
        { inputs: new Map([[0, moving()]]), joins: [], leaves: [], pauses: [] },
      ])
      const session = new HostSession(1, stubInput, coop)
      session.tick()
      session.tick()
      const x = session.self.pos.x
      session.tick()
      expect(session.isPaused).toBe(false)
      expect(session.self.pos.x).toBeGreaterThan(x)
    })

    // Determinism: pause must not touch the world at all. A paused tick is a
    // session-level skip — no systems run, no RNG draws, no tick advance — so
    // the serialized world is byte-identical however long the pause lasts.
    it('leaves the world byte-identical across any number of paused ticks', () => {
      const coop = scripted([{ inputs: new Map(), joins: [0], leaves: [], pauses: [0] }])
      const session = new HostSession(1, stubInput, coop)
      session.tick() // pause lands
      const frozen = JSON.stringify(serializeWorld(session.world))
      for (let i = 0; i < 25; i++) session.tick()
      expect(JSON.stringify(serializeWorld(session.world))).toBe(frozen)
      expect(session.isPaused).toBe(true)
    })

    // And a paused-then-resumed run replays to the same world as an unbroken
    // run: same seed + same per-tick inputs => byte-identical, pause or not.
    it('a run interrupted by a pause converges with an uninterrupted run', () => {
      const plain = new HostSession(9, stubInput)
      for (let i = 0; i < 10; i++) plain.tick()

      const coop = scripted([
        ...Array.from({ length: 5 }, () => ({ inputs: new Map<number, InputCmd>(), joins: [] as number[], leaves: [] as number[], pauses: [] as number[] })),
        { inputs: new Map<number, InputCmd>(), joins: [], leaves: [], pauses: [0] }, // pause after 5 sim ticks
        ...Array.from({ length: 3 }, () => ({ inputs: new Map<number, InputCmd>(), joins: [] as number[], leaves: [] as number[], pauses: [] as number[] })),
        { inputs: new Map<number, InputCmd>(), joins: [], leaves: [], pauses: [0] }, // resume
      ])
      const paused = new HostSession(9, stubInput, coop)
      while (paused.world.tick < 10) paused.tick()
      expect(JSON.stringify(serializeWorld(paused.world))).toBe(JSON.stringify(serializeWorld(plain.world)))
    })
  })

  describe('backward compatibility', () => {
    it('still runs solo with no coop provider', () => {
      const session = new HostSession(1, stubInput)
      expect(() => session.tick()).not.toThrow()
      expect(players(session)).toHaveLength(1)
    })
  })
})

describe('sessions spawn a ready-to-play avatar with no selection step', () => {
  it('a fresh session spawns the local player with the standard loadout immediately', () => {
    const session = new HostSession(7, stubInput)
    // The avatar exists BEFORE any tick — nothing waits on a selection screen.
    expect(session.self.combat!.weapon).toBe('pistol')
    expect(session.self.loadout!.activeSlot).toBe(-1) // nothing HELD; the pistol is permanent
    expect(session.self.playerCtl!.abilityCooldown).toBe(0) // grenade special ready
    for (let i = 0; i < 10; i++) session.tick() // and the real systems run on it
    expect(session.world.tick).toBe(10)
    expect(players(session)[0].combat!.weapon).toBe('pistol')
  })

  it('pad joiners get the same standard loadout as the host', () => {
    const coop = scripted([{ inputs: new Map(), joins: [1], leaves: [], pauses: [] }])
    const session = new HostSession(7, stubInput, coop)
    session.tick()
    const all = players(session)
    expect(all).toHaveLength(2)
    for (const p of all) expect(p.combat!.weapon).toBe('pistol')
  })
})
