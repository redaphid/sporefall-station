import { describe, expect, it } from 'vitest'
import { HostSession } from './hostSession'
import { nextFloor } from '../game/systems/missions'
import { emptyInput, type InputCmd } from '../game/types'
import type { CoopSample } from '../input/gamepadCoop'

const stubInput = { sample: () => emptyInput() }
const players = (s: HostSession) => s.world.entities.filter((e) => e.playerCtl)

const scripted = (samples: CoopSample[]) => {
  const q = [...samples]
  return { sample: () => q.shift() ?? { inputs: new Map<number, InputCmd>(), joins: [], leaves: [], pauses: [] } }
}

/** Down the lone self and tick once so missionSystem flips the run over. */
const forceGameOver = (s: HostSession): void => {
  s.self.health!.hp = 0
  s.self.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
  s.tick()
}

describe('HostSession.restart — solo play-again is a connection-preserving rebuild', () => {
  it('a solo party wipe really ends the run (gameOver), no auto-revive', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    forceGameOver(s)
    expect(s.world.gameOver).toBe(true)
    expect(s.self.playerCtl!.downed).toBeDefined() // still down, not auto-revived
  })

  it('restart() clears gameOver and respawns a single, upright player on floor 1', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    forceGameOver(s)
    const oldWorld = s.world
    s.restart()
    expect(s.world).not.toBe(oldWorld) // rebuilt in place
    expect(s.world.gameOver).toBe(false)
    expect(s.world.floor).toBe(1)
    expect(players(s)).toHaveLength(1)
    const p = players(s)[0]
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.health!.hp).toBe(p.health!.max) // fresh, full health
    expect(p.dead).toBeFalsy()
  })

  it('restart() re-points self at the new avatar (not the stale downed one)', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    const stale = s.self
    forceGameOver(s)
    s.restart()
    expect(s.self).not.toBe(stale)
    expect(players(s)).toContain(s.self)
    expect(s.self.playerCtl!.downed).toBeUndefined()
  })

  it('restart() regenerates floor 1 even from deep in a run (mid-run restart)', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    nextFloor(s.world)
    nextFloor(s.world)
    expect(s.world.floor).toBe(3)
    s.restart()
    expect(s.world.floor).toBe(1)
    expect(players(s)).toHaveLength(1)
  })

  it('restart() is deterministic from the seed — the same floor 1 is rebuilt', () => {
    const s = new HostSession(7, 'soldier', stubInput)
    const spawnBefore = { ...s.world.level.spawn }
    forceGameOver(s)
    s.restart()
    expect(s.world.level.spawn).toEqual(spawnBefore)
  })

  it('restart() clears the joined set so co-op pads can re-press to rejoin', () => {
    const coop = scripted([
      { inputs: new Map(), joins: [1], leaves: [], pauses: [] }, // pad 1 joins
      { inputs: new Map(), joins: [1], leaves: [], pauses: [] }, // re-join after restart
    ])
    const s = new HostSession(1, 'soldier', stubInput, coop)
    s.tick()
    expect(players(s)).toHaveLength(2) // self + pad 1
    s.restart()
    expect(players(s)).toHaveLength(1) // fresh world, pad not yet re-joined
    s.tick() // pad 1 re-presses join
    expect(players(s)).toHaveLength(2)
  })

  it('restart() unpauses a paused run', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    s.isPaused = true
    s.restart()
    expect(s.isPaused).toBe(false)
  })

  it('the session ticks cleanly and stays playable after a restart', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    forceGameOver(s)
    s.restart()
    expect(() => {
      for (let i = 0; i < 30; i++) s.tick()
    }).not.toThrow()
    expect(s.world.gameOver).toBe(false)
    expect(s.world.tick).toBeGreaterThan(0)
  })

  it('restart() twice in a row leaves a single consistent player (idempotent-ish)', () => {
    const s = new HostSession(1, 'soldier', stubInput)
    forceGameOver(s)
    s.restart()
    s.restart()
    expect(players(s)).toHaveLength(1)
    expect(s.world.gameOver).toBe(false)
    expect(players(s)[0]).toBe(s.self)
  })
})

describe('HostSession — run-over semantics (no respawn, real game-over)', () => {
  it('co-op wipe (both down) is a real run-over — no auto-revive on the next tick', () => {
    const coop = scripted([{ inputs: new Map(), joins: [1], leaves: [], pauses: [] }])
    const s = new HostSession(1, 'soldier', stubInput, coop)
    s.tick()
    for (const p of players(s)) {
      p.health!.hp = 0
      p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    }
    s.tick()
    expect(s.world.gameOver).toBe(true)
    // Still down after another tick — the run is over, nothing revives them.
    s.tick()
    expect(players(s).every((p) => p.playerCtl!.downed)).toBe(true)
  })

  it('a co-op run with one player still standing is NOT over', () => {
    const coop = scripted([{ inputs: new Map(), joins: [1], leaves: [], pauses: [] }])
    const s = new HostSession(1, 'soldier', stubInput, coop)
    s.tick()
    const [a] = players(s)
    a.health!.hp = 0
    a.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
    s.tick()
    expect(s.world.gameOver).toBe(false)
  })
})
