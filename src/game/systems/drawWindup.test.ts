// The engage wind-up (NpcDef.drawTicks): a pistol carrier that ENGAGES a target
// (ai.mode turning 'aggro') may not attack for drawTicks — the time it takes to
// draw the weapon, which is exactly the window the render's `draw` one-shot
// plays over. Real worlds from authored rows, real NPCs (populate.spawnNpc), the
// real tickWorld via runTicks. Ticks below are SIM ticks: the `w.tick` a system
// ran at, read before the tick advances it.

import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../data/items'
import { DRAW_REARM_TICKS, NPCS } from '../data/npcs'
import type { Entity } from '../entity'
import { spawnPlayer } from '../player'
import { spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks, walledRoom, worldFromRows } from '../testkit'
import type { World } from '../world'
import { applyDamage } from './combat'

const WINDUP = 16
const RIVET_CARRIERS = ['drowner', 'bellwether', 'acolyte'] as const

interface Tick {
  /** The sim tick this row's systems ran at. */
  t: number
  mode: string | undefined
  /** The body fired this tick (fireWeapon set a fresh cooldown). */
  fired: boolean
  /** Projectiles in flight that this body fired. */
  shots: number
}

/** Run `n` ticks; `before(t)` may set state exactly ahead of sim tick t. */
const watch = (w: World, e: Entity, n: number, before: (t: number) => void = () => {}): Tick[] => {
  const out: Tick[] = []
  for (let i = 0; i < n; i++) {
    const t = w.tick
    before(t)
    const cd = e.combat?.cooldown ?? 0
    runTicks(w, new Map(), 1)
    out.push({
      t,
      mode: e.ai?.mode,
      fired: (e.combat?.cooldown ?? 0) > cd,
      shots: w.entities.filter((p) => p.projectile?.ownerId === e.id).length,
    })
  }
  return out
}

const teleport = (e: Entity, x: number, y: number): void => {
  e.pos = { x, y }
  e.prevPos = { x, y }
}

/** First sim tick the body was in aggro after not being in it. */
const engageTick = (rows: Tick[]): number => {
  const i = rows.findIndex((r, k) => k > 0 && r.mode === 'aggro' && rows[k - 1].mode !== 'aggro')
  expect(i, 'the NPC engaged').toBeGreaterThan(0)
  return rows[i].t
}
const firstShot = (rows: Tick[], from = 0): number | undefined => rows.find((r) => r.t >= from && r.fired)?.t

/** A long room: the player waits out of `archetype`'s sight, then steps in at
 * `gap` tiles at `stepIn` (a sim tick). Nothing else is in the room. */
const scene = (archetype: string, gap: number, stepIn = 40, seed = 7) => {
  const w = worldFromRows(walledRoom(40, 12), { seed })
  const p = spawnPlayer(w, 0, 3.5, 5.5)
  const npc = spawnNpc(w, archetype, 33.5, 5.5)
  const step = (t: number): void => {
    if (t === stepIn) teleport(p, npc.pos.x - gap, npc.pos.y)
  }
  return { w, p, npc, step }
}

describe('engage wind-up — the data', () => {
  it('every ranged-weapon archetype winds up 16 ticks; every other archetype has no wind-up at all', () => {
    for (const def of Object.values(NPCS)) {
      const ranged = WEAPONS[def.weapon]?.kind === 'ranged'
      expect(def.drawTicks, `${def.archetype} (${def.weapon})`).toBe(ranged ? WINDUP : undefined)
    }
    expect(RIVET_CARRIERS.every((a) => NPCS[a].weapon === 'rivetDriver')).toBe(true)
  })
})

describe('engage wind-up — a pistol carrier spotting a player in range', () => {
  for (const archetype of RIVET_CARRIERS) {
    it(`${archetype}: holds fire for exactly ${WINDUP} ticks after it engages, then fires`, () => {
      const { w, npc, step } = scene(archetype, 6)
      const rows = watch(w, npc, 120, step)
      const e = engageTick(rows)
      // In range from the first engaged tick: before the wind-up it would have
      // fired on tick e itself.
      expect(rows.filter((r) => r.t >= e && r.t < e + WINDUP).every((r) => r.mode === 'aggro')).toBe(true)
      expect(rows.filter((r) => r.t < e + WINDUP).some((r) => r.fired || r.shots > 0)).toBe(false)
      expect(firstShot(rows)).toBe(e + WINDUP)
    })
  }

  it('the body still aims while it draws: facing tracks the target through the wind-up', () => {
    const { w, p, npc, step } = scene('drowner', 6)
    const rows = watch(w, npc, 60, step)
    const e = engageTick(rows)
    expect(w.tick).toBeGreaterThan(e + WINDUP)
    const toPlayer = Math.atan2(p.pos.y - npc.pos.y, p.pos.x - npc.pos.x)
    expect(Math.abs(npc.facing - toPlayer)).toBeLessThan(0.2)
  })

  it('an idle pistol carrier that never engaged carries no wind-up record (snapshot unchanged)', () => {
    const { w, npc } = scene('drowner', 6)
    runTicks(w, new Map(), 60)
    expect(npc.ai!.mode).not.toBe('aggro')
    expect(npc.ai!.draw).toBeUndefined()
  })
})

describe('engage wind-up — archetypes without one are unchanged', () => {
  it('a wrench mutant swings on the very tick it engages a player in reach', () => {
    const { w, npc, step } = scene('mutant', 0.9)
    const rows = watch(w, npc, 60, step)
    const e = engageTick(rows)
    expect(firstShot(rows)).toBe(e)
    expect(npc.ai!.draw, 'no record on an archetype without a wind-up').toBeUndefined()
  })

  it('the wind-up is data, not a weapon branch: a mutant given drawTicks holds its wrench swing too', () => {
    NPCS.mutant.drawTicks = WINDUP
    try {
      const { w, npc, step } = scene('mutant', 0.9)
      const rows = watch(w, npc, 60, step)
      expect(firstShot(rows)).toBe(engageTick(rows) + WINDUP)
    } finally {
      delete NPCS.mutant.drawTicks
    }
  })

  it('absent drawTicks is 0: a drowner with the field removed fires on its engage tick, record-free', () => {
    const saved = NPCS.drowner.drawTicks
    delete NPCS.drowner.drawTicks
    try {
      const { w, npc, step } = scene('drowner', 6)
      const rows = watch(w, npc, 60, step)
      expect(firstShot(rows)).toBe(engageTick(rows))
      expect(npc.ai!.draw).toBeUndefined()
    } finally {
      NPCS.drowner.drawTicks = saved
    }
  })
})

describe('engage wind-up — determinism', () => {
  it('the same seed and inputs give a byte-identical world', () => {
    const run = (): string => {
      const { w, npc, step } = scene('bellwether', 6)
      watch(w, npc, 150, step)
      return JSON.stringify(serializeWorld(w))
    }
    expect(run()).toBe(run())
  })

  it('a snapshot taken mid-wind-up resumes identically (the record rides the snapshot)', () => {
    const a = scene('drowner', 6)
    const rows = watch(a.w, a.npc, 48, a.step)
    const e = engageTick(rows)
    expect(a.w.tick).toBeLessThan(e + WINDUP) // mid-wind-up
    expect(a.npc.ai!.draw).toEqual({ readyAt: e + WINDUP })
    const b = deserializeWorld(serializeWorld(a.w))
    const bNpc = b.byId.get(a.npc.id)!
    const restRows = watch(b, bNpc, 40)
    runTicks(a.w, new Map(), 40)
    expectWorldEqual(a.w, b)
    expect(firstShot(restRows)).toBe(e + WINDUP)
  })
})

// State set exactly: aggro on/off by hand, the think step pinned off so goal
// arbitration cannot touch the mode. Steering + combat are the real systems.
describe('engage wind-up — adversarial engage edges', () => {
  const pinned = () => {
    const { w, p, npc } = scene('drowner', 6, -1)
    teleport(p, npc.pos.x - 6, npc.pos.y)
    npc.ai!.thinkAt = Number.MAX_SAFE_INTEGER
    const set = (aggro: boolean): void => {
      npc.ai!.mode = aggro ? 'aggro' : 'idle'
      npc.ai!.targetId = aggro ? p.id : undefined
    }
    return { w, p, npc, set }
  }
  /** Drive `plan(t)` → engaged? for every sim tick. */
  const drive = (n: number, plan: (t: number) => boolean) => {
    const s = pinned()
    const rows = watch(s.w, s.npc, n, (t) => s.set(plan(t)))
    return { ...s, rows }
  }
  const E = 10

  it('aggro dropped inside the window and never re-entered: no shot, ever', () => {
    const { rows } = drive(120, (t) => t >= E && t < E + 8)
    expect(rows.some((r) => r.fired || r.shots > 0)).toBe(false)
  })

  it('dropped and re-entered inside the re-arm window: the ORIGINAL draw finishes, no second wait', () => {
    const { rows } = drive(80, (t) => t >= E && (t < E + 5 || t >= E + 10))
    expect(firstShot(rows)).toBe(E + WINDUP)
  })

  it(`out for ${DRAW_REARM_TICKS - 1} ticks after the draw finished: fires the tick it re-engages`, () => {
    const back = E + 5 + DRAW_REARM_TICKS - 1
    const { rows } = drive(80, (t) => t >= E && (t < E + 5 || t >= back))
    expect(back).toBeGreaterThan(E + WINDUP)
    expect(firstShot(rows)).toBe(back)
  })

  it(`out for exactly ${DRAW_REARM_TICKS} ticks: re-engaging draws again and waits the full wind-up`, () => {
    const back = E + 5 + DRAW_REARM_TICKS
    const { rows } = drive(100, (t) => t >= E && (t < E + 5 || t >= back))
    expect(firstShot(rows)).toBe(back + WINDUP)
  })

  it('a real re-engage after shooting: a long break waits again, a flicker does not', () => {
    // Engage, trade shots for a while, break off, come back.
    const breakAt = E + 60
    const longBack = breakAt + DRAW_REARM_TICKS + 5
    const long = drive(160, (t) => t >= E && (t < breakAt || t >= longBack))
    expect(long.rows.filter((r) => r.t < breakAt && r.fired).length, 'shot during the first engagement').toBeGreaterThan(1)
    expect(firstShot(long.rows, breakAt)).toBe(longBack + WINDUP)

    const shortBack = breakAt + DRAW_REARM_TICKS - 1
    const short = drive(160, (t) => t >= E && (t < breakAt || t >= shortBack))
    const cdAtReturn = (() => {
      const s = pinned()
      watch(s.w, s.npc, shortBack, (t) => s.set(t >= E && t < breakAt))
      return s.npc.combat!.cooldown
    })()
    expect(cdAtReturn, 'the gun had recharged by the time it came back').toBe(0)
    expect(firstShot(short.rows, breakAt)).toBe(shortBack)
  })

  it('a body loaded already engaged with no record winds up from its first tick (absent = holstered)', () => {
    const s = pinned()
    s.set(true)
    const t0 = s.w.tick
    const rows = watch(s.w, s.npc, 40, () => s.set(true))
    expect(firstShot(rows)).toBe(t0 + WINDUP)
  })

  it('killed mid-wind-up: never fires, and nothing throws', () => {
    const { w, p, npc, step } = scene('drowner', 6)
    let e = -1
    const rows = watch(w, npc, 100, (t) => {
      step(t)
      if (e < 0 && npc.ai?.mode === 'aggro') e = t
      if (e >= 0 && t === e + 8) applyDamage(w, npc, 10_000, p.pos.x, p.pos.y, 0, p.id)
    })
    expect(e, 'engaged').toBeGreaterThan(0)
    expect(npc.dead).toBe(true)
    expect(rows.some((r) => r.fired || r.shots > 0)).toBe(false)
  })

  it('stunned through the whole wind-up: the draw still completes on schedule', () => {
    const s = pinned()
    const rows = watch(s.w, s.npc, 60, (t) => {
      s.set(t >= E)
      if (t === E) s.npc.status = { ...s.npc.status!, stun: WINDUP + 4 }
    })
    const shot = firstShot(rows)!
    expect(shot).toBeGreaterThanOrEqual(E + WINDUP)
    // The wind-up ran while stunned: it fires as soon as the stun lifts, not a
    // full draw later.
    expect(shot).toBeLessThan(E + WINDUP + 4 + WINDUP)
  })
})
