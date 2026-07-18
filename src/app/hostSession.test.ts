import { describe, it, expect, beforeEach } from 'vitest'
import { HostSession } from './hostSession'
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
      session = new HostSession(1, 'soldier', stubInput, coop)
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
      session = new HostSession(1, 'soldier', stubInput, coop)
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
      const session = new HostSession(1, 'soldier', stubInput, coop)
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
      const session = new HostSession(1, 'soldier', stubInput, coop)
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
      const session = new HostSession(1, 'soldier', stubInput, coop)
      session.tick()
      session.tick()
      const x = session.self.pos.x
      session.tick()
      expect(session.isPaused).toBe(false)
      expect(session.self.pos.x).toBeGreaterThan(x)
    })
  })

  describe('backward compatibility', () => {
    it('still runs solo with no coop provider', () => {
      const session = new HostSession(1, 'soldier', stubInput)
      expect(() => session.tick()).not.toThrow()
      expect(players(session)).toHaveLength(1)
    })
  })
})

describe('soldier is the only class — sessions start as soldier with no selection step', () => {
  it('a fresh session spawns the local player as a soldier immediately', () => {
    const session = new HostSession(7, 'soldier', stubInput)
    // The avatar exists BEFORE any tick — nothing waits on a class-select screen.
    expect(session.self.playerCtl!.classId).toBe('soldier')
    expect(session.self.combat!.weapon).toBe('pistol')
    for (let i = 0; i < 10; i++) session.tick() // and the real systems run on it
    expect(session.world.tick).toBe(10)
    expect(players(session)[0].playerCtl!.classId).toBe('soldier')
  })

  it('a legacy classId from an old caller degrades to soldier (self AND pad joiners)', () => {
    const coop = scripted([{ inputs: new Map(), joins: [1], leaves: [], pauses: [] }])
    const session = new HostSession(7, 'thief', stubInput, coop)
    session.tick()
    const all = players(session)
    expect(all).toHaveLength(2)
    for (const p of all) expect(p.playerCtl!.classId).toBe('soldier')
  })
})
