// The aim loops `aim` and `aimwalk`, driven by the REAL sim: authored rooms,
// real NPCs from populate.spawnNpc, real players fed InputCmds, real tickWorld.
// Each tick the render-side tracker (animTracker.trackAnim) observes the entity
// exactly as EntityViews does. The expected verdicts are recomputed here from
// the sim's own fields, never from game/aiming.ts, so a wrong predicate fails.

import { describe, expect, it } from 'vitest'
import { isAiming } from '../game/aiming'
import type { Entity } from '../game/entity'
import { NPCS } from '../game/data/npcs'
import { spawnNpc } from '../game/populate'
import { deserializeWorld, serializeWorld } from '../game/serialize'
import { arm, runTicks, walledRoom, worldFromRows } from '../game/testkit'
import type { InputCmd } from '../game/types'
import type { World } from '../game/world'
import { applyWireEntity, decodeSnapshot, encodeSnapshot, toWireEntity } from '../net/protocol/messages'
import { facingDir } from './anim'
import { DEFAULT_TPF, type AnimStateName } from './animState'
import { trackAnim, type AnimMemory } from './animTracker'
import { tank, teleport } from './animTestkit'

/** A pack that draws the aim loops (a 2-frame breathing hold and an 8-frame
 * cycle) and the 8-frame draw; frames × tpf, as EntityViews measures them. */
const DRAW_TICKS = 8 * DEFAULT_TPF.draw
const AIM_PACK = { aim: 2 * DEFAULT_TPF.aim, aimwalk: 8 * DEFAULT_TPF.aimwalk, draw: DRAW_TICKS }
const AIM_ONLY = { aim: AIM_PACK.aim, aimwalk: AIM_PACK.aimwalk }

const AIM_STATES: readonly AnimStateName[] = ['aim', 'aimwalk']
const aimingState = (s: AnimStateName): boolean => AIM_STATES.includes(s)

interface Seen {
  i: number
  tick: number
  state: AnimStateName
  mode: string | undefined
  readyAt: number | undefined
  moving: boolean
  facing: number
  x: number
  y: number
}

const moved = (e: Entity): boolean => e.pos.x !== e.prevPos.x || e.pos.y !== e.prevPos.y

/** Observe `e` after every tick; `before(i)` may set world state exactly. */
const watch = (
  w: World,
  e: Entity,
  n: number,
  clips: Partial<Record<AnimStateName, number>>,
  before: (i: number) => void = () => {},
  input: (i: number) => Partial<InputCmd> | undefined = () => undefined,
): Seen[] => {
  const mem: AnimMemory = {}
  const out: Seen[] = []
  for (let i = 0; i < n; i++) {
    before(i)
    const cmd = input(i)
    runTicks(w, cmd ? new Map([[0, cmd]]) : new Map(), 1)
    out.push({
      i,
      tick: w.tick,
      state: trackAnim(mem, e, w.tick, clips).state,
      mode: e.ai?.mode,
      readyAt: e.ai?.draw?.readyAt,
      moving: moved(e),
      facing: e.facing,
      x: e.pos.x,
      y: e.pos.y,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// NPC: the drowner engages, winds up, aims, fires, and disengages.

/** The player (who cannot die) stays out of the drowner's sight, steps into it
 * at 60, leaves at 160 and comes back at 260. */
const drowner = () => {
  const w = worldFromRows(walledRoom(40, 12), { seed: 7 })
  const p = tank(w, 3.5, 5.5)
  const d = spawnNpc(w, 'drowner', 33.5, 5.5)
  const before = (i: number): void => {
    if (i === 60) teleport(p, d.pos.x - 6, d.pos.y)
    if (i === 160) teleport(p, 1.5, 1.5)
    if (i === 260) teleport(p, d.pos.x - 6, d.pos.y)
  }
  return { w, p, d, before }
}

const drownerSeen = (clips: Partial<Record<AnimStateName, number>>, n = 330): Seen[] => {
  const { w, d, before } = drowner()
  return watch(w, d, n, clips, before)
}

const engageTicks = (seen: Seen[]): number[] =>
  seen.filter((s, k) => k > 0 && s.mode === 'aggro' && seen[k - 1].mode !== 'aggro').map((s) => s.tick)

describe('NPC aim: an armed body raises its gun once its engage wind-up has run', () => {
  it('the scene engages twice, and the drowner has a wind-up', () => {
    expect(NPCS.drowner.drawTicks).toBeGreaterThan(0)
    expect(engageTicks(drownerSeen(AIM_PACK)).length).toBe(2)
  })

  it('with draw frames: draw plays first, then aim takes over the tick the clip ends, never before readyAt', () => {
    const seen = drownerSeen(AIM_PACK)
    for (const e of engageTicks(seen)) {
      const at = seen.findIndex((s) => s.tick === e)
      const readyAt = seen[at].readyAt!
      expect(seen.slice(at, at + DRAW_TICKS).map((s) => s.state)).toEqual(Array(DRAW_TICKS).fill('draw'))
      const first = seen.findIndex((s, k) => k >= at && aimingState(s.state))
      expect(seen[first].tick).toBe(Math.max(readyAt, e + DRAW_TICKS))
      for (const s of seen.slice(at, first)) expect(s.tick < readyAt || s.state === 'draw', `tick ${s.tick}`).toBe(true)
    }
  })

  it('without draw frames: the body walks or stands through the wind-up and aims exactly at readyAt', () => {
    const seen = drownerSeen(AIM_ONLY)
    for (const e of engageTicks(seen)) {
      const at = seen.findIndex((s) => s.tick === e)
      const readyAt = seen[at].readyAt!
      expect(readyAt).toBeGreaterThan(e)
      const wind = seen.filter((s) => s.tick >= e && s.tick < readyAt)
      expect(wind.length).toBe(readyAt - e)
      for (const s of wind) expect(['walk', 'idle', 'hurt'], `tick ${s.tick}`).toContain(s.state)
      expect(seen.find((s) => s.tick === readyAt)!.state).toMatch(/^aim/)
    }
  })

  it('on every tick: an aim state exactly when engaged past the wind-up (and no one-shot over it), aimwalk exactly while moving', () => {
    const seen = drownerSeen(AIM_PACK)
    let aimed = 0
    for (const s of seen) {
      const engaged = s.mode === 'aggro' && s.readyAt !== undefined && s.tick >= s.readyAt
      const oneShot = s.state === 'draw' || s.state === 'hurt' || s.state === 'attack'
      if (!oneShot) expect(aimingState(s.state), `tick ${s.tick}`).toBe(engaged)
      if (aimingState(s.state)) {
        aimed++
        expect(s.state, `tick ${s.tick}`).toBe(s.moving ? 'aimwalk' : 'aim')
      }
    }
    expect(aimed).toBeGreaterThan(100)
    expect(seen.some((s) => s.state === 'aimwalk')).toBe(true)
    expect(seen.some((s) => s.state === 'aim')).toBe(true)
  })

  it('leaves aim when it disengages: no aim state once the target is gone and the mode drops', () => {
    const seen = drownerSeen(AIM_PACK)
    const left = seen.findIndex((s, k) => k > 0 && seen[k - 1].mode === 'aggro' && s.mode !== 'aggro')
    expect(left).toBeGreaterThan(0)
    const holstered = seen.slice(left).filter((s) => s.mode !== 'aggro')
    expect(holstered.length).toBeGreaterThan(20)
    for (const s of holstered) expect(aimingState(s.state), `tick ${s.tick}`).toBe(false)
  })

  it('faces its target, not its feet: while strafing or backing off the drawn facing is the aim', () => {
    const { w, p, d, before } = drowner()
    const mem: AnimMemory = {}
    const turn = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
    let crossed = 0
    for (let i = 0; i < 160; i++) {
      before(i)
      const from = { ...d.pos }
      runTicks(w, new Map(), 1)
      const state = trackAnim(mem, d, w.tick, AIM_PACK).state
      if (state !== 'aimwalk') continue
      // The sim aims from where the body stood when it thought (± its 0.075 rad
      // imperfect aim), then steps; the drawn facing is that aim.
      const aim = Math.atan2(p.pos.y - from.y, p.pos.x - from.x)
      expect(turn(d.facing, aim), `tick ${w.tick}`).toBeLessThan(0.1)
      const travel = Math.atan2(d.pos.y - d.prevPos.y, d.pos.x - d.prevPos.x)
      if (turn(travel, d.facing) > Math.PI / 4) crossed++
    }
    expect(crossed, 'the drowner must step off its aim line: strafe or back off').toBeGreaterThan(5)
  })

  it('missing aim frames: the drowner never enters aim or aimwalk', () => {
    expect(drownerSeen({ draw: DRAW_TICKS }).some((s) => aimingState(s.state))).toBe(false)
    expect(drownerSeen({}).some((s) => aimingState(s.state))).toBe(false)
  })

  it('only the drawn half plays: aim frames alone never cover a moving body, aimwalk alone never a still one', () => {
    for (const s of drownerSeen({ aim: AIM_PACK.aim })) if (s.moving) expect(s.state).not.toBe('aim')
    for (const s of drownerSeen({ aimwalk: AIM_PACK.aimwalk })) if (!s.moving) expect(s.state).not.toBe('aimwalk')
  })

  it('is deterministic: the same seed and inputs give the same states', () => {
    expect(drownerSeen(AIM_PACK)).toEqual(drownerSeen(AIM_PACK))
  })
})

// ---------------------------------------------------------------------------
// Player: twin-stick aim held east while the legs go anywhere.

const AIM_EAST = { aimX: 1, aimY: 0 }
/** Stand (0..29), strafe north (30..59), backpedal west (60..89), strafe south
 * (90..119), fire standing (120..149), then aim along the walk west (150..179). */
const playerInput = (i: number): Partial<InputCmd> => {
  if (i < 30) return AIM_EAST
  if (i < 60) return { ...AIM_EAST, moveY: -1 }
  if (i < 90) return { ...AIM_EAST, moveX: -1 }
  if (i < 120) return { ...AIM_EAST, moveY: 1 }
  if (i < 150) return { ...AIM_EAST, attack: true }
  return { aimX: -1, aimY: 0, moveX: -1 }
}
const shooter = (weapon = 'pistol') => {
  const w = worldFromRows(walledRoom(30, 20), { seed: 3 })
  const p = tank(w, 20.5, 10.5)
  arm(p, weapon)
  return { w, p }
}
const playerSeen = (clips: Partial<Record<AnimStateName, number>>, weapon = 'pistol', before?: (i: number, p: Entity) => void) => {
  const { w, p } = shooter(weapon)
  return watch(w, p, 180, clips, (i) => before?.(i, p), playerInput)
}

describe('player aim: the gun stays up and on the aim line whichever way the legs go', () => {
  it('stands in aim, strafes and backpedals in aimwalk, facing east the whole time', () => {
    const seen = playerSeen(AIM_PACK)
    const phase = (from: number, to: number): Seen[] => seen.slice(from + 2, to) // a tick or two to get going
    // First seen standing with the gun up: the player draws (playerDraw.test.ts), then aims.
    expect(seen.slice(0, DRAW_TICKS).map((s) => s.state)).toEqual(Array(DRAW_TICKS).fill('draw'))
    for (const s of seen.slice(DRAW_TICKS, 30)) expect(s.state).toBe('aim')
    for (const [from, to, dx, dy] of [
      [30, 60, 0, -1],
      [60, 90, -1, 0],
      [90, 120, 0, 1],
    ] as const) {
      for (const s of phase(from, to)) {
        expect(s.state, `tick ${s.tick}`).toBe('aimwalk')
        expect(facingDir(s.facing), `tick ${s.tick}`).toEqual({ dir: 'e', flip: false })
      }
      const a = seen[from + 2]
      const b = seen[to - 1]
      expect(Math.sign(b.x - a.x)).toBe(dx)
      expect(Math.sign(b.y - a.y)).toBe(dy)
    }
  })

  it('firing without attack frames holds the aim pose: an undrawn attack never cuts into it', () => {
    const seen = playerSeen(AIM_PACK).slice(120, 150)
    expect(seen.every((s) => s.state === 'aim')).toBe(true)
  })

  it('firing WITH attack frames plays the drawn attack over aim, then returns to aim', () => {
    const seen = playerSeen({ ...AIM_PACK, attack: 8 * DEFAULT_TPF.attack }).slice(120, 150)
    expect(seen.some((s) => s.state === 'attack')).toBe(true)
    expect(seen.some((s) => s.state === 'aim')).toBe(true)
    expect(seen.every((s) => s.state === 'attack' || s.state === 'aim')).toBe(true)
  })

  it('aim along the walk is still aimwalk, now facing west', () => {
    for (const s of playerSeen(AIM_PACK).slice(152)) {
      expect(s.state).toBe('aimwalk')
      expect(facingDir(s.facing)).toEqual({ dir: 'e', flip: true })
    }
  })

  it('a melee weapon never aims: the same inputs walk and idle', () => {
    for (const s of playerSeen(AIM_PACK, 'wrench')) expect(aimingState(s.state)).toBe(false)
  })

  it('missing aim frames: the same inputs never aim (walk, idle, attack exactly as before)', () => {
    const seen = playerSeen({})
    expect(seen.some((s) => aimingState(s.state))).toBe(false)
    expect(seen.slice(32, 60).every((s) => s.state === 'walk')).toBe(true)
  })

  it('leaves aim while stunned, downed or picking a lock, and takes it up again after', () => {
    const seen = playerSeen(AIM_PACK, 'pistol', (i, p) => {
      if (i === 10) p.status = { stun: 8, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
      if (i === 40) p.playerCtl!.downed = { bleedTicks: 900, reviveProgress: 0 }
      if (i === 50) p.playerCtl!.downed = undefined
    })
    expect(seen[11].state).not.toMatch(/^aim/)
    expect(seen[25].state).toBe('aim')
    for (const s of seen.slice(40, 50)) expect(aimingState(s.state), `tick ${s.tick}`).toBe(false)
    expect(seen[55].state).toBe('aimwalk')
  })
})

// ---------------------------------------------------------------------------
// The predicate, entity state set exactly.

describe('isAiming — adversarial entity states', () => {
  const npc = (patch: Partial<Entity['ai']> & object = {}, extra: Partial<Entity> = {}): Entity =>
    ({
      id: 4,
      pos: { x: 5, y: 5 },
      prevPos: { x: 5, y: 5 },
      combat: { weapon: 'pistol', cooldown: 0 },
      ai: { mode: 'aggro', draw: { readyAt: 100 }, ...patch },
      ...extra,
    }) as unknown as Entity

  it('engaged and past the wind-up: aiming; one tick before readyAt: not', () => {
    expect(isAiming(npc(), 100)).toBe(true)
    expect(isAiming(npc(), 99)).toBe(false)
  })

  it.each(['flee', 'seek', 'idle', 'wander'])('mode %s: not aiming', (mode) => {
    expect(isAiming(npc({ mode } as never), 500)).toBe(false)
  })

  it('stunned, asleep, frozen, dormant, dead, melee or unarmed: not aiming', () => {
    expect(isAiming(npc({}, { status: { stun: 1, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 } }), 500)).toBe(false)
    expect(isAiming(npc({}, { status: { stun: 0, sleep: 1, hitFlashUntil: 0, cloakUntil: 0 } }), 500)).toBe(false)
    expect(isAiming(npc({}, { fx: { frozen: { until: 900 } } } as never), 500)).toBe(false)
    expect(isAiming(npc({ dormant: true }), 500)).toBe(false)
    expect(isAiming(npc({}, { dead: true }), 500)).toBe(false)
    expect(isAiming(npc({}, { combat: { weapon: 'wrench', cooldown: 0 } }), 500)).toBe(false)
    expect(isAiming(npc({}, { combat: undefined }), 500)).toBe(false)
  })

  it('a body without a wind-up aims from the engage tick', () => {
    expect(isAiming(npc({ draw: undefined }), 0)).toBe(true)
  })

  it('a client mirror wins both ways over whatever the entity carries', () => {
    expect(isAiming(npc({}, { aimShown: false }), 500)).toBe(false)
    expect(isAiming(npc({ mode: 'flee' }, { aimShown: true }), 500)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Replay and co-op client: the same states from the same sim.

describe('replay and client see the same aim states', () => {
  it('a world serialized mid-engagement and restored resolves the same states, tick for tick', () => {
    const { w, d, before } = drowner()
    for (let i = 0; i < 100; i++) {
      before(i)
      runTicks(w, new Map(), 1)
    }
    const copy = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(w))))
    const dc = copy.byId.get(d.id)!
    const memA: AnimMemory = {}
    const memB: AnimMemory = {}
    const a: AnimStateName[] = []
    const b: AnimStateName[] = []
    for (let i = 100; i < 300; i++) {
      before(i) // teleports the original's player; mirror it on the copy
      if (i === 160 || i === 260) {
        const p = w.entities.find((e) => e.playerCtl)!
        teleport(copy.entities.find((e) => e.playerCtl)!, p.pos.x, p.pos.y)
      }
      runTicks(w, new Map(), 1)
      runTicks(copy, new Map(), 1)
      a.push(trackAnim(memA, d, w.tick, AIM_PACK).state)
      b.push(trackAnim(memB, dc, copy.tick, AIM_PACK).state)
    }
    expect(b).toEqual(a)
    expect(a.filter(aimingState).length).toBeGreaterThan(30)
  })

  it('a co-op client fed the host snapshots resolves the host state on every tick (draw aside: a client holds no AI)', () => {
    const { w, d, before } = drowner()
    const hostMem: AnimMemory = {}
    const clientMem: AnimMemory = {}
    let client: Entity | undefined
    let compared = 0
    let aimed = 0
    for (let i = 0; i < 330; i++) {
      before(i)
      runTicks(w, new Map(), 1)
      const snap = decodeSnapshot(
        encodeSnapshot({ tick: w.tick, epoch: 1, floor: 1, alarm: 0, lastInputSeq: 0, entities: [toWireEntity(d, w.tick)] }),
      )
      client = applyWireEntity(client, snap.entities[0], w.tick)
      client.pos = { ...d.pos }
      client.prevPos = { ...d.prevPos }
      expect(isAiming(client, w.tick), `tick ${w.tick}`).toBe(isAiming(d, w.tick))
      const host = trackAnim(hostMem, d, w.tick, AIM_PACK).state
      const seen = trackAnim(clientMem, client, w.tick, AIM_PACK).state
      if (host === 'draw') continue
      expect(seen, `tick ${w.tick}`).toBe(host)
      compared++
      if (aimingState(host)) aimed++
    }
    expect(compared).toBeGreaterThan(280)
    expect(aimed).toBeGreaterThan(100)
  })
})
