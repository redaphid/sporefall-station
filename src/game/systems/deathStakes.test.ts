// Ticket #31 — meaningful death stakes. This suite is the exhaustive/adversarial
// spec for the run economy and comeback penalty layered on top of the existing
// downed/revive machinery. It exercises the SIM primitives directly (kill,
// interactionSystem, missionSystem) so the rules are pinned independent of the
// net/session plumbing, plus a few end-to-end passes through tickWorld.
import { beforeEach, describe, expect, it } from 'vitest'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd } from '../types'
import { createWorld, REVIVES_PER_RUN, tickWorld, type RunMode, type World } from '../world'
import { kill } from './combat'
import { interactionSystem } from './interaction'
import { missionSystem } from './missions'

/** Down a player through the real kill() path so the life-gate is honoured. */
const down = (w: World, p: ReturnType<typeof spawnPlayer>): void => {
  p.health!.hp = 1
  kill(w, p)
}

const idle = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))

/** Keep an entity still so no channel/drift logic trips. */
const settle = (p: ReturnType<typeof spawnPlayer>): void => {
  p.prevPos.x = p.pos.x
  p.prevPos.y = p.pos.y
}

/** Run interactionSystem until the downed player resolves (recovers or dies),
 * or a tick budget is exhausted. Returns the ticks consumed. */
const runUntilResolved = (w: World, p: ReturnType<typeof spawnPlayer>, budget = 2000): number => {
  const ids = idle(...(w.entities.filter((e) => e.playerCtl).map((e) => e.playerCtl!.playerId)))
  let n = 0
  while (n < budget && p.playerCtl!.downed && !p.dead) {
    interactionSystem(w, ids)
    n++
  }
  return n
}

describe('kill() life-gate — normal mode', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(1, 1) // default 'normal'
  })

  it('a fresh run starts with REVIVES_PER_RUN comebacks in the shared pool', () => {
    expect(w.mode).toBe('normal')
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN)
  })

  it('while the pool has comebacks, a down is a survivable DOWNED state', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    down(w, p)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toEqual({ bleedTicks: 30 * 30, reviveProgress: 0 })
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN) // pool spent on RECOVERY, not on the down
  })

  it('with an empty pool, a down is a real permanent DEATH (no downed grace)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    w.revivesLeft = 0
    down(w, p)
    expect(p.dead).toBe(true)
    expect(p.playerCtl!.downed).toBeUndefined()
  })
})

describe('solo: down → bleed-out → self-revive with penalty', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(7, 1)
  })

  it('a lone downed player bleeds the timer down and self-revives at low hp, dropping cash + items', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.playerCtl!.cash = 120
    p.loadout!.inventory = [{ itemId: 'bat', qty: 8 }]
    p.loadout!.activeSlot = 0
    down(w, p)
    p.playerCtl!.downed!.bleedTicks = 4 // shorten the wait
    settle(p)
    runUntilResolved(w, p)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.health!.hp).toBe(Math.floor(p.health!.max * 0.3))
    expect(p.playerCtl!.cash).toBe(0)
    // The carried bat drops, but the comeback re-grants a real slotted starter
    // pistol (no phantom weapon) so mod pickups keep working post-revive.
    expect(p.loadout!.inventory).toEqual([{ itemId: 'pistol', qty: 1 }])
    expect(p.loadout!.activeSlot).toBe(0)
    expect(p.combat!.weapon).toBe('pistol')
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN - 1) // exactly one comeback spent
  })

  it('a KEY item survives the comeback penalty (only non-key items drop)', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.loadout!.inventory = [
      { itemId: 'briefcase', qty: 1 }, // key
      { itemId: 'pistol', qty: 6 }, // non-key
    ]
    down(w, p)
    p.playerCtl!.downed!.bleedTicks = 2
    settle(p)
    runUntilResolved(w, p)
    // Key item survives; the picked-up pistol drops and is replaced by the
    // re-granted starter pistol slotted ahead of the key.
    expect(p.loadout!.inventory).toEqual([
      { itemId: 'pistol', qty: 1 },
      { itemId: 'briefcase', qty: 1 },
    ])
  })

  it('the penalty lands EXACTLY ONCE — a further interaction tick after recovery does not re-charge', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    p.playerCtl!.cash = 50
    down(w, p)
    p.playerCtl!.downed!.bleedTicks = 1
    settle(p)
    const ids = idle(0)
    interactionSystem(w, ids) // recovers here
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN - 1)
    p.playerCtl!.cash = 999 // simulate earning cash again after standing up
    interactionSystem(w, ids)
    interactionSystem(w, ids)
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN - 1) // not double-charged
    expect(p.playerCtl!.cash).toBe(999) // not re-stripped
  })

  it('the run is LOSABLE: each down spends a comeback, and the down after the pool empties ends the run', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    // Burn through every comeback.
    for (let i = 0; i < REVIVES_PER_RUN; i++) {
      down(w, p)
      p.playerCtl!.downed!.bleedTicks = 1
      settle(p)
      runUntilResolved(w, p)
      expect(p.dead).toBeFalsy()
    }
    expect(w.revivesLeft).toBe(0)
    // The next down is fatal.
    down(w, p)
    expect(p.dead).toBe(true)
    missionSystem(w)
    expect(w.gameOver).toBe(true)
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(1)
  })

  it('missionSystem never lets a lone DOWNED player (still recovering) count as a run-over', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    down(w, p)
    missionSystem(w)
    expect(w.gameOver).toBe(false)
  })
})

describe('co-op: partial down keeps teammate-revive; full wipe ends the run', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(3, 1)
  })

  it('one down + one standing does NOT end the run; the standing ally can still revive', () => {
    const a = spawnPlayer(w, 0, 20, 20)
    const b = spawnPlayer(w, 1, 20.8, 20) // adjacent rescuer
    down(w, a)
    settle(a)
    settle(b)
    missionSystem(w)
    expect(w.gameOver).toBe(false)
    const ids = idle(0, 1)
    for (let i = 0; i < 120 && a.playerCtl!.downed; i++) interactionSystem(w, ids)
    expect(a.playerCtl!.downed).toBeUndefined() // teammate hauled them up
    expect(a.health!.hp).toBeGreaterThan(0)
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN - 1) // teammate revive also spends a comeback
  })

  it('a full party wipe (all down) is a run-over — checked before anyone bleeds out', () => {
    const a = spawnPlayer(w, 0, 20, 20)
    const b = spawnPlayer(w, 1, 40, 40)
    down(w, a)
    down(w, b)
    missionSystem(w)
    expect(w.gameOver).toBe(true)
    expect(w.events.filter((e) => e.type === 'runOver')).toHaveLength(1)
  })

  it('a downed player with NO possible rescuer (teammate also down, out of range) bleeds out to death', () => {
    const a = spawnPlayer(w, 0, 20, 20)
    const b = spawnPlayer(w, 1, 40, 40)
    down(w, a)
    down(w, b)
    a.playerCtl!.downed!.bleedTicks = 2
    settle(a)
    settle(b)
    const ids = idle(0, 1)
    interactionSystem(w, ids)
    interactionSystem(w, ids)
    expect(a.dead).toBe(true) // canSelfRecover is false when another player is down
  })

  it('the comeback pool is SHARED across the party (two revives drain the same pool)', () => {
    const a = spawnPlayer(w, 0, 20, 20)
    const b = spawnPlayer(w, 1, 21, 20)
    // a goes down and self-revives while b stands (canSelfRecover true).
    down(w, a)
    a.playerCtl!.downed!.bleedTicks = 1
    settle(a)
    settle(b)
    runUntilResolved(w, a)
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN - 1)
    // b then goes down and self-revives while a stands.
    down(w, b)
    b.playerCtl!.downed!.bleedTicks = 1
    settle(a)
    settle(b)
    runUntilResolved(w, b)
    expect(w.revivesLeft).toBe(REVIVES_PER_RUN - 2)
  })
})

describe('casual mode — forgiving (kid mode)', () => {
  let w: World
  beforeEach(() => {
    w = createWorld(5, 1, 'casual')
  })

  it('a down is always survivable (the pool is never consulted) and self-revive costs nothing', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    w.revivesLeft = 0 // even with an empty pool, casual downs (never a real death)
    p.playerCtl!.cash = 77
    p.loadout!.inventory = [{ itemId: 'bat', qty: 3 }]
    down(w, p)
    expect(p.dead).toBeFalsy()
    expect(p.playerCtl!.downed).toBeDefined()
    p.playerCtl!.downed!.bleedTicks = 2
    settle(p)
    runUntilResolved(w, p)
    expect(p.playerCtl!.downed).toBeUndefined()
    expect(p.playerCtl!.cash).toBe(77) // no penalty
    expect(p.loadout!.inventory).toHaveLength(1)
    expect(w.revivesLeft).toBe(0) // pool untouched (stays where it was)
  })

  it('a lone casual player can go down forever and never lose the run', () => {
    const p = spawnPlayer(w, 0, 20, 20)
    for (let i = 0; i < 5; i++) {
      down(w, p)
      p.playerCtl!.downed!.bleedTicks = 1
      settle(p)
      runUntilResolved(w, p)
      missionSystem(w)
      expect(w.gameOver).toBe(false)
      expect(p.dead).toBeFalsy()
    }
  })

  it('casual co-op STILL loses on a full simultaneous wipe (the game can end)', () => {
    const a = spawnPlayer(w, 0, 20, 20)
    const b = spawnPlayer(w, 1, 40, 40)
    down(w, a)
    down(w, b)
    missionSystem(w)
    expect(w.gameOver).toBe(true)
  })
})

describe('edge cases & guards', () => {
  it('revivesLeft never goes negative even if recovery is forced past an empty pool', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    w.revivesLeft = 0
    // Force a downed record directly (bypassing the kill gate) then resolve it.
    p.health!.hp = 0
    p.playerCtl!.downed = { bleedTicks: 1, reviveProgress: 0 }
    settle(p)
    interactionSystem(w, idle(0))
    expect(w.revivesLeft).toBe(0) // clamped, not -1
    expect(p.playerCtl!.downed).toBeUndefined()
  })

  it('recovery hp is at least 1 even for a 1-hp-max glass cannon (never revives to 0)', () => {
    const w = createWorld(1, 1)
    const p = spawnPlayer(w, 0, 20, 20)
    p.health!.max = 1
    p.health!.hp = 0
    p.playerCtl!.downed = { bleedTicks: 1, reviveProgress: 0 }
    settle(p)
    interactionSystem(w, idle(0))
    expect(p.health!.hp).toBeGreaterThanOrEqual(1)
  })

  it('no players in the world is never a run-over', () => {
    const w = createWorld(1, 1)
    missionSystem(w)
    expect(w.gameOver).toBe(false)
  })
})

describe('determinism — same seed + inputs + scripted downs ⇒ identical outcome', () => {
  const runScenario = (mode: RunMode): { revivesLeft: number; hp: number; cash: number; dead: boolean; gameOver: boolean } => {
    const w = createWorld(99, 1, mode)
    const p = spawnPlayer(w, 0, 20, 20)
    p.playerCtl!.cash = 200
    // Scripted: down, shorten bleed, resolve — twice.
    for (let i = 0; i < 2; i++) {
      p.playerCtl!.cash += 40
      down(w, p)
      if (p.playerCtl!.downed) p.playerCtl!.downed.bleedTicks = 3
      settle(p)
      runUntilResolved(w, p)
    }
    return {
      revivesLeft: w.revivesLeft,
      hp: p.health!.hp,
      cash: p.playerCtl!.cash,
      dead: !!p.dead,
      gameOver: w.gameOver,
    }
  }

  it('two normal-mode runs from the same seed + script produce byte-identical stakes state', () => {
    expect(runScenario('normal')).toEqual(runScenario('normal'))
  })

  it('normal and casual diverge exactly where the rules say they should (pool + penalty)', () => {
    const normal = runScenario('normal')
    const casual = runScenario('casual')
    expect(normal.revivesLeft).toBe(REVIVES_PER_RUN - 2) // two comebacks spent
    expect(casual.revivesLeft).toBe(REVIVES_PER_RUN) // pool never touched
    expect(normal.cash).toBe(0) // stripped on each recovery
    expect(casual.cash).toBeGreaterThan(0) // kept
  })

  it('end-to-end via tickWorld: a scripted solo down self-resolves and stays deterministic', () => {
    const build = (): World => {
      const w = createWorld(21, 1)
      const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
      down(w, p)
      p.playerCtl!.downed!.bleedTicks = 5
      return w
    }
    const a = build()
    const b = build()
    for (let i = 0; i < 20; i++) {
      tickWorld(a, idle(0))
      tickWorld(b, idle(0))
    }
    const pa = a.entities.find((e) => e.playerCtl)!
    const pb = b.entities.find((e) => e.playerCtl)!
    expect(pa.playerCtl!.downed).toBeUndefined() // recovered
    expect(a.revivesLeft).toBe(b.revivesLeft)
    expect(pa.health!.hp).toBe(pb.health!.hp)
    expect(a.gameOver).toBe(b.gameOver)
  })
})
