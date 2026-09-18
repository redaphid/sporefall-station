// The group layer (systems/groups.ts) — adversarial, deterministic sims.
//
// Every test builds EXACT world state (a sealed, hand-carved arena and hand-
// placed bodies, or a real populated floor for the wiring/replay tests), runs the
// REAL systems through tickWorld, and asserts on what the group did over time:
// raids that stage then go as one, a siege gun that shells from range, sappers
// that blow a locked hatch, morale that breaks when the officer falls, wounded
// that fall back to a medic and return, packs that surround before closing and
// go manhunter when hurt, and hives that bud and spread — plus the degenerate
// cases (no target, lone survivors, nothing to breach) and byte-identical replay.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { populateWorld, spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type SimEvent } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { applyDamage } from './combat'
import { groupDamageMult, groupSpeedMult, RAGE_SPEED, RALLY_DAMAGE, RALLY_SPEED } from './groupFx'
import {
  FUSE_TICKS,
  groupSystem,
  HIVE_BROOD,
  HIVE_SPREAD_TICKS,
  hiveCap,
  HOWL_RADIUS,
  initTides,
  LOB_MAX,
  LOB_MIN,
  membersOf,
  RAGE_TICKS,
  raidRoster,
  raidSize,
  RING_MAX_TICKS,
  ROUT_DISSOLVE_TICKS,
  SIEGE_MAX_TICKS,
  spawnHive,
  spawnPack,
  spawnRaid,
  STAGE_MAX_TICKS,
  strategiesFor,
  tideCount,
  TIDE_FIRST_TICKS,
  type GroupState,
} from './groups'

// ── Arena helpers ──────────────────────────────────────────────────────────

const carve = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
}

const wall = (w: World, x: number, y: number): void => {
  w.level.tiles[y * w.level.w + x] = Tile.Wall
  w.level.solid[y * w.level.w + x] = 1
}

/** Whole level solid, then one carved box — walls genuinely seal. */
const arena = (seed = 11, floor = 3): World => {
  const w = createWorld(seed, floor, 'normal', true)
  w.level.tiles.fill(Tile.Wall)
  w.level.solid.fill(1)
  carve(w, 2, 2, 60, 40)
  return w
}

const idle = (): Map<number, ReturnType<typeof emptyInput>> => new Map([[0, emptyInput()]])

/** Tick n times, collecting every event emitted along the way. */
const run = (w: World, n: number, log?: SimEvent[]): void => {
  for (let i = 0; i < n; i++) {
    tickWorld(w, idle())
    if (log) log.push(...w.events)
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

/** A player who cannot die (so a test measures the group, not a game over). */
const tank = (w: World, x: number, y: number): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.health!.max = 1_000_000
  p.health!.hp = 1_000_000
  p.health!.iframes = 0
  return p
}

const ofType = <T extends SimEvent['type']>(log: SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  log.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)

/** Two rooms split by a wall at x=`wx`, joined only by a door at (wx, dy). */
const twoRooms = (w: World, wx: number, dy: number, locked: boolean): Entity => {
  for (let y = 2; y <= 40; y++) if (y !== dy) wall(w, wx, y)
  const door = makeEntity('door', 'door', wx + 0.5, dy + 0.5, 0.5)
  door.door = { open: false, locked, lockLevel: locked ? 3 : 0 }
  door.interact = { verb: 'open', range: 1.3 }
  return addEntity(w, door)
}

// ── Raids: strategies ──────────────────────────────────────────────────────

describe('staging raid: gathers out of sight, then goes TOGETHER', () => {
  const scene = (): { w: World; p: Entity; g: GroupState; members: Entity[] } => {
    const w = arena()
    twoRooms(w, 30, 20, false)
    const p = tank(w, 10.5, 20.5)
    const g = spawnRaid(w, 'staging', { x: 45.5, y: 20.5 }, p)
    const members = membersOf(w, g.id)
    // Scatter the muster across the far room so it genuinely has to gather.
    const spots = [
      [34.5, 5.5],
      [56.5, 6.5],
      [36.5, 36.5],
      [57.5, 35.5],
      [50.5, 12.5],
    ]
    members.forEach((m, i) => {
      const [x, y] = spots[i % spots.length]
      m.pos.x = m.prevPos.x = x
      m.pos.y = m.prevPos.y = y
    })
    return { w, p, g, members }
  }

  it('holds in staging while scattered, with nobody breaking off to hunt', () => {
    const { w, g, members } = scene()
    expect(g.phase).toBe('staging')
    run(w, 20)
    expect(g.phase).toBe('staging')
    for (const m of members) expect(m.ai!.goal).toBe('stage')
  })

  it('once gathered, EVERY member switches to the assault on the same tick', () => {
    const { w, g, members } = scene()
    const log: SimEvent[] = []
    // The tick each member first stops mustering. Fighters switch to the assault;
    // the medic switches to tending / hanging back behind it — either way, off
    // the muster point on the same tick as everyone else.
    const firstPursue = new Map<number, number>()
    for (let i = 0; i < STAGE_MAX_TICKS + 60 && firstPursue.size < members.length; i++) {
      run(w, 1, log)
      for (const m of members) {
        if (!firstPursue.has(m.id) && m.ai!.goal !== 'stage' && g.phase === 'attack') firstPursue.set(m.id, w.tick)
      }
    }
    // Every fighter actually went for the target.
    for (const m of members) {
      if (m.ai!.group!.role !== 'medic') expect(['pursue', 'battle']).toContain(m.ai!.goal)
    }
    const phase = ofType(log, 'groupPhase').find((e) => e.groupId === g.id && e.phase === 'attack')
    expect(phase, 'the raid went to attack').toBeDefined()
    expect(firstPursue.size).toBe(members.length)
    const ticks = [...firstPursue.values()]
    // Went as one: every member committed within a single tick of the others.
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThanOrEqual(1)
    // And they really had gathered first (it did not simply time out).
    expect(w.tick).toBeLessThan(STAGE_MAX_TICKS)
  })

  it('a straggler cannot hold the raid forever: it goes anyway at the staging limit', () => {
    const { w, g, members } = scene()
    const straggler = members[members.length - 1]
    straggler.speed = 0 // stuck in the far corner
    run(w, STAGE_MAX_TICKS - 2)
    expect(g.phase).toBe('staging')
    run(w, 4)
    expect(g.phase).toBe('attack')
  })

  it('being SPOTTED mid-muster springs the attack at once', () => {
    const { w, p, g, members } = scene()
    run(w, 5)
    expect(g.phase).toBe('staging')
    // The player walks through the door into plain view of a staging member.
    p.pos.x = p.prevPos.x = members[0].pos.x - 3
    p.pos.y = p.prevPos.y = members[0].pos.y
    run(w, 2)
    expect(g.phase).toBe('attack')
  })
})

describe('assault raid: dropped in close, already hunting', () => {
  it('arrives in the attack phase with every member aggro on the target', () => {
    const w = arena()
    const p = tank(w, 20.5, 20.5)
    const g = spawnRaid(w, 'assault', { x: 27.5, y: 20.5 }, p)
    expect(g.phase).toBe('attack')
    const members = membersOf(w, g.id)
    expect(members.length).toBe(raidSize(w.floor))
    for (const m of members) {
      expect(m.ai!.mode).toBe('aggro')
      expect(m.ai!.targetId).toBe(p.id)
    }
    const hp0 = p.health!.hp
    run(w, 150)
    expect(p.health!.hp).toBeLessThan(hp0) // and they press it
  })
})

describe('siege raid: a mortar battery shells from range, escorts guard it', () => {
  const scene = (): { w: World; p: Entity; g: GroupState; gun: Entity; escorts: Entity[] } => {
    const w = arena(21, 4)
    const p = tank(w, 10.5, 20.5)
    const g = spawnRaid(w, 'siege', { x: 32.5, y: 20.5 }, p)
    const members = membersOf(w, g.id)
    const gun = members.find((m) => m.ai!.group!.role === 'artillery')!
    return { w, p, g, gun, escorts: members.filter((m) => m !== gun) }
  }

  it('the gun takes up a firing position in its band and lobs shells that land on the target', () => {
    const { w, p, g, gun } = scene()
    const log: SimEvent[] = []
    // Where the target stood at each shot (escort fire knocks it about a little).
    const aimedAt: { x: number; y: number; tx: number; ty: number }[] = []
    for (let i = 0; i < 300; i++) {
      run(w, 1, log)
      for (const l of ofType(w.events, 'lob')) aimedAt.push({ x: p.pos.x, y: p.pos.y, tx: l.tx, ty: l.ty })
    }
    expect(g.phase).toBe('siege')
    const d = dist(gun.pos, p.pos)
    expect(d).toBeGreaterThanOrEqual(LOB_MIN)
    expect(d).toBeLessThanOrEqual(LOB_MAX)
    const lobs = ofType(log, 'lob').filter((e) => e.entityId === gun.id)
    expect(lobs.length).toBeGreaterThanOrEqual(2)
    // Every shell was aimed within the scatter of where the target stood...
    for (const a of aimedAt) expect(dist({ x: a.tx, y: a.ty }, a)).toBeLessThan(2)
    // ...and actually came down as a blast there.
    const booms = ofType(log, 'explosion')
    expect(booms.some((b) => dist(b, p.pos) < 2)).toBe(true)
  })

  it('escorts hold round the battery instead of charging while the siege lasts', () => {
    const { w, p, g, gun, escorts } = scene()
    for (let i = 0; i < 300; i++) {
      run(w, 1)
      if (g.phase !== 'siege') break
      for (const m of escorts) {
        // They may trade shots from their post, but nobody rushes the target...
        expect(dist(m.pos, p.pos)).toBeGreaterThan(5)
        // ...and nobody wanders off from the gun they are guarding.
        if (i > 150) expect(dist(m.pos, gun.pos)).toBeLessThan(8)
      }
    }
    expect(g.phase).toBe('siege')
  })

  it('the siege turns into an assault after the siege limit', () => {
    const { w, g } = scene()
    run(w, SIEGE_MAX_TICKS + 5)
    expect(g.phase).toBe('attack')
  })

  it('rushing the battery breaks the siege at once — and the gun backs off', () => {
    const { w, p, g, gun } = scene()
    run(w, 200)
    p.pos.x = p.prevPos.x = gun.pos.x - 3
    p.pos.y = p.prevPos.y = gun.pos.y
    run(w, 2)
    expect(g.phase).toBe('attack')
    const before = dist(gun.pos, p.pos)
    run(w, 30)
    expect(dist(gun.pos, p.pos)).toBeGreaterThan(before) // it keeps its distance
  })

  it('a shell arcs OVER a wall and the bodies in its path and lands where aimed', () => {
    const w = arena()
    for (let y = 2; y <= 40; y++) wall(w, 20, y) // solid wall, no gap at all
    const owner = spawnNpc(w, 'lobber', 12.5, 20.5)
    const blocker = spawnNpc(w, 'drowner', 16.5, 20.5) // right in the line of fire
    blocker.ai!.thinkAt = 1e9
    const target = tank(w, 28.5, 20.5)
    const shell = makeEntity('projectile', 'grenade', 12.5, 20.5, 0.15)
    shell.vel = { x: 16 * (30 / 60), y: 0 }
    shell.projectile = { ownerId: owner.id, damage: 0, ttl: 60, onLand: { kind: 'explode', radius: 1.7, damage: 20 }, arc: true }
    addEntity(w, shell)
    const hp0 = blocker.health!.hp
    const log: SimEvent[] = []
    run(w, 61, log)
    const boom = ofType(log, 'explosion')
    expect(boom.length).toBe(1)
    expect(boom[0].x).toBeGreaterThan(21) // beyond the wall
    expect(dist(boom[0], target.pos)).toBeLessThan(1)
    expect(blocker.health!.hp).toBe(hp0) // flew over the body in the way
  })

  it('no spotter, no shell: a battery that nobody in the raid can see the target from stays silent', () => {
    const w = arena(21, 4)
    twoRooms(w, 25, 38, true) // a sealed partition: nobody on the east side can see west
    const p = tank(w, 10.5, 20.5)
    spawnRaid(w, 'siege', { x: 34.5, y: 20.5 }, p)
    const log: SimEvent[] = []
    run(w, 240, log)
    expect(ofType(log, 'lob').length).toBe(0)
  })
})

describe('sapper raid: a breacher blows the locked hatch so the raid comes THROUGH', () => {
  const scene = (): { w: World; p: Entity; door: Entity; g: GroupState } => {
    const w = arena(31, 4)
    const door = twoRooms(w, 30, 20, true)
    const p = tank(w, 12.5, 20.5)
    const g = spawnRaid(w, 'sappers', { x: 46.5, y: 20.5 }, p)
    return { w, p, door, g }
  }

  it('walks to the door, plants a charge, blows it open, then the raid pours through', () => {
    const { w, door, g } = scene()
    const log: SimEvent[] = []
    let crossed = false
    for (let i = 0; i < 900 && !crossed; i++) {
      run(w, 1, log)
      crossed = membersOf(w, g.id).some((m) => m.pos.x < 29)
    }
    const charge = ofType(log, 'sapperCharge')
    expect(charge.length).toBeGreaterThanOrEqual(1)
    expect(charge[0].doorId).toBe(door.id)
    const breach = ofType(log, 'doorBreach').find((e) => e.entityId === door.id)
    expect(breach, 'the charge breached the door').toBeDefined()
    expect(door.door!.open).toBe(true)
    expect(door.door!.locked).toBe(false)
    expect(g.phase).toBe('attack')
    expect(crossed, 'raiders came through the breach').toBe(true)
  })

  it('the sapper clears the blast — it is not standing on its own charge when it goes off', () => {
    const { w, door, g } = scene()
    const log: SimEvent[] = []
    let blewAt = -1
    for (let i = 0; i < 900 && blewAt < 0; i++) {
      run(w, 1, log)
      if (ofType(w.events, 'doorBreach').length) blewAt = w.tick
    }
    expect(blewAt).toBeGreaterThan(0)
    const sapper = membersOf(w, g.id).find((m) => m.ai!.group!.role === 'sapper')
    expect(sapper, 'the sapper survived its own charge').toBeDefined()
    expect(dist(sapper!.pos, door.pos)).toBeGreaterThan(1.5)
  })

  it('a sapper killed before planting does not wedge the raid: it goes in without it', () => {
    const { w, g } = scene()
    const sapper = membersOf(w, g.id).find((m) => m.ai!.group!.role === 'sapper')!
    sapper.dead = true
    run(w, 3)
    expect(g.phase).toBe('attack')
  })

  it('with nothing sealed in the way there is nothing to breach: straight to the attack', () => {
    const w = arena(31, 4)
    twoRooms(w, 30, 20, false) // unlocked
    const p = tank(w, 12.5, 20.5)
    const g = spawnRaid(w, 'sappers', { x: 46.5, y: 20.5 }, p)
    const log: SimEvent[] = []
    run(w, 3, log)
    expect(g.phase).toBe('attack')
    expect(ofType(log, 'sapperCharge').length).toBe(0)
  })

  it('a charge planted a moment before the sapper dies still goes off', () => {
    const { w, door, g } = scene()
    for (let i = 0; i < 900 && g.chargeAt === undefined; i++) run(w, 1)
    expect(g.chargeAt).toBeDefined()
    const sapper = membersOf(w, g.id).find((m) => m.ai!.group!.role === 'sapper')!
    sapper.dead = true
    run(w, FUSE_TICKS + 2)
    expect(door.door!.open).toBe(true)
  })
})

// ── Raids: command, morale, medics ─────────────────────────────────────────

describe('command & morale', () => {
  const scene = (): { w: World; p: Entity; g: GroupState; members: Entity[]; leader: Entity } => {
    const w = arena(41, 4)
    const p = tank(w, 10.5, 20.5)
    const g = spawnRaid(w, 'staging', { x: 22.5, y: 20.5 }, p)
    const members = membersOf(w, g.id)
    const leader = members.find((m) => m.ai!.group!.role === 'leader')!
    return { w, p, g, members, leader }
  }

  it('members within earshot of the leader are RALLIED: faster and harder to hurt', () => {
    const { w, members, leader } = scene()
    run(w, 1)
    const near = members.find((m) => m !== leader && dist(m.pos, leader.pos) <= 6)!
    expect(groupSpeedMult(near, w.tick)).toBeCloseTo(RALLY_SPEED)
    expect(groupDamageMult(near, w.tick)).toBeCloseTo(RALLY_DAMAGE)
    const hp0 = near.health!.hp
    near.health!.iframes = 0
    applyDamage(w, near, 20, 0, 0, 0, 0)
    expect(hp0 - near.health!.hp).toBe(Math.round(20 * RALLY_DAMAGE))
    // The leader itself is not rallied by its own bell.
    expect(groupSpeedMult(leader, w.tick)).toBe(1)
  })

  it('a member out of earshot is NOT rallied (and the rally lapses once it walks off)', () => {
    const { w, members, leader } = scene()
    const far = members.find((m) => m !== leader)!
    far.pos.x = far.prevPos.x = leader.pos.x + 20
    far.speed = 0
    run(w, 15)
    expect(groupSpeedMult(far, w.tick)).toBe(1)
    const hp0 = far.health!.hp
    far.health!.iframes = 0
    applyDamage(w, far, 20, 0, 0, 0, 0)
    expect(hp0 - far.health!.hp).toBe(20)
  })

  it('killing the LEADER breaks the raid: everyone routs, running from the player', () => {
    const { w, p, g, members, leader } = scene()
    run(w, 10)
    const log: SimEvent[] = []
    leader.dead = true
    run(w, 12, log)
    expect(g.phase).toBe('routed')
    const r = ofType(log, 'raidRouted')
    expect(r.length).toBe(1)
    expect(r[0].reason).toBe('leader')
    const alive = members.filter((m) => !m.dead)
    for (const m of alive) {
      expect(m.ai!.goal).toBe('flee')
      expect(m.ai!.targetId).toBe(p.id)
      expect(groupSpeedMult(m, w.tick)).toBe(1) // the bell fell silent with it
    }
  })

  it('heavy casualties break a LEADERLESS raid; light ones do not', () => {
    const w = arena(43, 2)
    const p = tank(w, 10.5, 20.5)
    const g = spawnRaid(w, 'assault', { x: 30.5, y: 20.5 }, p)
    const members = membersOf(w, g.id)
    expect(g.hadLeader).toBeFalsy()
    members[0].dead = true // 1 of 4
    run(w, 2)
    expect(g.phase).toBe('attack')
    members[1].dead = true // 2 of 4 = half
    const log: SimEvent[] = []
    run(w, 2, log)
    expect(g.phase).toBe('routed')
    expect(ofType(log, 'raidRouted')[0].reason).toBe('casualties')
  })

  it('routed raiders that slip out of sight dissolve; one still in view does not', () => {
    const w = arena(45, 2) // floor 2: a raid of 4, so two down is half
    const wallX = 30
    for (let y = 2; y <= 40; y++) if (y !== 5) wall(w, wallX, y)
    const p = tank(w, 20.5, 20.5)
    const g = spawnRaid(w, 'assault', { x: 25.5, y: 20.5 }, p)
    const members = membersOf(w, g.id)
    const seen = members[0]
    const hidden = members[1]
    seen.speed = 0 // stays right where the player can see it
    hidden.pos.x = hidden.prevPos.x = 45.5 // behind the wall
    hidden.speed = 0
    members[2].dead = true
    members[3].dead = true // half gone → routed
    const log: SimEvent[] = []
    run(w, 3, log)
    expect(g.phase).toBe('routed')
    run(w, ROUT_DISSOLVE_TICKS + 2, log)
    expect(hidden.dead).toBe(true)
    expect(ofType(log, 'dissolve').map((e) => e.entityId)).toEqual([hidden.id])
    expect(seen.dead).toBeFalsy()
  })
})

describe('retreat to heal', () => {
  const scene = (withMedic: boolean): { w: World; g: GroupState; hurt: Entity; medic?: Entity } => {
    const w = arena(51, 3)
    // No player at all: this isolates the medic loop from any fight.
    const g = spawnRaid(w, 'staging', { x: 20.5, y: 20.5 }, tank(w, 55.5, 38.5))
    const members = membersOf(w, g.id)
    const medic = members.find((m) => m.ai!.group!.role === 'medic')
    if (!withMedic && medic) medic.dead = true
    const hurt = members.find((m) => m.ai!.group!.role === 'grunt')!
    hurt.pos.x = hurt.prevPos.x = 32.5
    hurt.pos.y = hurt.prevPos.y = 30.5
    hurt.health!.hp = Math.round(hurt.health!.max * 0.3)
    return { w, g, hurt, medic }
  }

  it('a badly hurt raider falls back to the medic, is patched up, and returns to its orders', () => {
    const { w, hurt, medic } = scene(true)
    expect(medic).toBeDefined()
    const log: SimEvent[] = []
    run(w, 2, log)
    expect(hurt.ai!.healing).toBe(true)
    let sawFallback = false
    for (let i = 0; i < 900 && hurt.ai!.healing; i++) {
      run(w, 1, log)
      if (hurt.ai!.goal === 'fallback') sawFallback = true
    }
    expect(sawFallback).toBe(true)
    expect(ofType(log, 'heal').some((e) => e.entityId === hurt.id && e.byId === medic!.id)).toBe(true)
    expect(hurt.ai!.healing).toBeUndefined()
    expect(hurt.health!.hp / hurt.health!.max).toBeGreaterThanOrEqual(0.8)
    run(w, 10)
    expect(hurt.ai!.goal).not.toBe('fallback')
  })

  it('with no medic alive there is nowhere to fall back to — no retreat is latched', () => {
    const { w, hurt } = scene(false)
    run(w, 30)
    expect(hurt.ai!.healing).toBeUndefined()
    expect(hurt.ai!.goal).not.toBe('fallback')
  })

  it('a medic never heals past max, and never heals a body out of reach', () => {
    const { w, hurt, medic } = scene(true)
    medic!.speed = 0
    hurt.speed = 0 // pinned far away
    const log: SimEvent[] = []
    run(w, 120, log)
    expect(ofType(log, 'heal').some((e) => e.entityId === hurt.id)).toBe(false)
    for (const m of membersOf(w, hurt.ai!.group!.id)) expect(m.health!.hp).toBeLessThanOrEqual(m.health!.max)
  })
})

// ── Packs ──────────────────────────────────────────────────────────────────

/** Largest angular gap (radians) between bodies as seen from `c`. < π means
 * the bodies SURROUND the point; a pack arriving from one side leaves > π. */
const maxGap = (c: { x: number; y: number }, bodies: Entity[]): number => {
  const a = bodies.map((b) => Math.atan2(b.pos.y - c.y, b.pos.x - c.x)).sort((x, y) => x - y)
  let gap = a[0] + 2 * Math.PI - a[a.length - 1]
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1])
  return gap
}

describe('pack encirclement', () => {
  const scene = (behavior?: string): { w: World; p: Entity; g: GroupState; hounds: Entity[] } => {
    const w = arena(61, 3)
    const p = tank(w, 30.5, 20.5)
    p.speed = 0
    const g = spawnPack(w, { x: 38.5, y: 20.5 }, 4)!
    const hounds = membersOf(w, g.id)
    if (behavior) for (const h of hounds) h.ai!.behavior = behavior
    return { w, p, g, hounds }
  }

  it('spots the prey, fans out to a RING around it, and only then closes', () => {
    const { w, p, g, hounds } = scene()
    const log: SimEvent[] = []
    let closedAt = -1
    for (let i = 0; i < RING_MAX_TICKS + 30 && closedAt < 0; i++) {
      run(w, 1, log)
      if (ofType(w.events, 'packClose').length) closedAt = w.tick
    }
    expect(ofType(log, 'packHunt').length).toBe(1)
    expect(closedAt).toBeGreaterThan(0)
    expect(g.phase).toBe('attack')
    // At the moment the ring closed the pack surrounded the prey.
    expect(maxGap(p.pos, hounds)).toBeLessThan(Math.PI)
  })

  it('control: the same pack WITHOUT the encircle brain arrives from one side', () => {
    const { w, p, hounds } = scene('vermin')
    run(w, 45)
    expect(maxGap(p.pos, hounds)).toBeGreaterThan(Math.PI)
  })

  it('a ring that cannot close (a hound pinned) still goes in at the time limit', () => {
    const { w, g, hounds } = scene()
    hounds[3].speed = 0
    run(w, RING_MAX_TICKS + 20)
    expect(g.phase).toBe('attack')
  })
})

describe('manhunter pack rage', () => {
  const scene = (): { w: World; p: Entity; a: GroupState; b: GroupState; far: GroupState } => {
    const w = arena(71, 3)
    // A partition so no hound SEES the player — the rage alone must bring them.
    // (The gap is a short detour: route search is budgeted, as for every NPC.)
    for (let y = 2; y <= 40; y++) if (y !== 29) wall(w, 20, y)
    const p = tank(w, 10.5, 20.5)
    const a = spawnPack(w, { x: 30.5, y: 20.5 }, 3)!
    const b = spawnPack(w, { x: 30.5 + HOWL_RADIUS - 4, y: 22.5 }, 3)! // in earshot of a
    const far = spawnPack(w, { x: 56.5, y: 4.5 }, 3)! // out of earshot
    return { w, p, a, b, far }
  }

  it('hurting ONE hound turns its whole pack — and a pack in earshot — manhunter; a distant pack sleeps on', () => {
    const { w, p, a, b, far } = scene()
    run(w, 5)
    const victim = membersOf(w, a.id)[0]
    victim.health!.iframes = 0
    applyDamage(w, victim, 5, p.pos.x, p.pos.y, 0, p.id)
    const log: SimEvent[] = []
    run(w, 2, log)
    const raged = new Set(ofType(log, 'packRage').map((e) => e.groupId))
    expect(raged.has(a.id)).toBe(true)
    expect(raged.has(b.id)).toBe(true)
    expect(raged.has(far.id)).toBe(false)
    for (const h of [...membersOf(w, a.id), ...membersOf(w, b.id)]) {
      expect(h.ai!.rageUntil).toBeGreaterThan(w.tick)
      expect(groupSpeedMult(h, w.tick)).toBeCloseTo(RAGE_SPEED)
    }
    for (const h of membersOf(w, far.id)) expect(h.ai!.rageUntil).toBeUndefined()
  })

  it('a raging pack tracks its aggressor round the wall it cannot see through', () => {
    const { w, p, a } = scene()
    const victim = membersOf(w, a.id)[0]
    victim.health!.iframes = 0
    applyDamage(w, victim, 5, p.pos.x, p.pos.y, 0, p.id)
    const d0 = Math.min(...membersOf(w, a.id).map((h) => dist(h.pos, p.pos)))
    run(w, 300) // the only way round is the gap in the wall
    const d1 = Math.min(...membersOf(w, a.id).map((h) => dist(h.pos, p.pos)))
    expect(d1).toBeLessThan(d0 - 5)
  })

  it('the rage burns out after its window', () => {
    // A fully sealed wall this time: the pack can never reach the player, so it
    // is still all there (not torn up in the scrum) when the window closes.
    const w = arena(72, 3)
    for (let y = 2; y <= 40; y++) wall(w, 20, y)
    const p = tank(w, 10.5, 20.5)
    const a = spawnPack(w, { x: 30.5, y: 20.5 }, 3)!
    const victim = membersOf(w, a.id)[0]
    victim.health!.iframes = 0
    applyDamage(w, victim, 5, p.pos.x, p.pos.y, 0, p.id)
    run(w, RAGE_TICKS - 5)
    expect(a.rageUntil).toBeDefined()
    run(w, 10)
    expect(w.groups!.list).toContain(a)
    expect(membersOf(w, a.id).length).toBe(3)
    for (const h of membersOf(w, a.id)) {
      expect(h.ai!.rageUntil).toBeUndefined()
      expect(groupSpeedMult(h, w.tick)).toBe(1)
    }
    expect(a.rageUntil).toBeUndefined()
  })

  it('an NPC (not a player) hurting a hound does not trigger the rage', () => {
    const { w, a } = scene()
    const other = spawnNpc(w, 'drowner', 40.5, 30.5)
    const victim = membersOf(w, a.id)[0]
    victim.health!.iframes = 0
    applyDamage(w, victim, 5, other.pos.x, other.pos.y, 0, other.id)
    const log: SimEvent[] = []
    run(w, 2, log)
    expect(ofType(log, 'packRage').length).toBe(0)
  })
})

// ── Hives ──────────────────────────────────────────────────────────────────

describe('hive infestation', () => {
  it('buds sporelings at a nearby player, capped at its brood limit', () => {
    const w = arena(81, 3)
    const p = tank(w, 20.5, 20.5)
    p.speed = 0
    const spire = spawnHive(w, 30.5, 20.5)
    const log: SimEvent[] = []
    run(w, 30 * 40, log)
    const buds = ofType(log, 'hiveSpawn').filter((e) => e.byId === spire.id)
    expect(buds.length).toBeGreaterThanOrEqual(1)
    const live = spire.hive!.children.filter((id) => !w.byId.get(id)?.dead)
    expect(live.length).toBeLessThanOrEqual(HIVE_BROOD)
  })

  it('stays quiet while nobody is near', () => {
    const w = arena(82, 3)
    tank(w, 3.5, 3.5)
    spawnHive(w, 55.5, 38.5)
    const log: SimEvent[] = []
    run(w, 30 * 20, log)
    expect(ofType(log, 'hiveSpawn').length).toBe(0)
  })

  it('left alone it SPREADS: a new spire roots nearby — and the spread is capped per floor', () => {
    const w = arena(83, 3)
    const p = tank(w, 30.5, 30.5)
    p.speed = 0
    const spire = spawnHive(w, 30.5, 14.5)
    const log: SimEvent[] = []
    run(w, HIVE_SPREAD_TICKS + 5, log)
    const spread = ofType(log, 'hiveSpread')
    expect(spread.length).toBe(1)
    expect(spread[0].byId).toBe(spire.id)
    const d = dist(spread[0], spire.pos)
    expect(d).toBeGreaterThanOrEqual(3.5)
    expect(d).toBeLessThanOrEqual(8)
    run(w, HIVE_SPREAD_TICKS * 6, log)
    const spires = w.entities.filter((e) => e.hive && !e.dead)
    expect(spires.length).toBeLessThanOrEqual(hiveCap(w.floor))
  })

  it('burning it out ends it: a dead spire neither buds nor spreads', () => {
    const w = arena(84, 3)
    const p = tank(w, 22.5, 20.5)
    p.speed = 0
    const spire = spawnHive(w, 30.5, 20.5)
    spire.dead = true
    const log: SimEvent[] = []
    run(w, HIVE_SPREAD_TICKS + 60, log)
    expect(ofType(log, 'hiveSpawn').length + ofType(log, 'hiveSpread').length).toBe(0)
  })

  it('the spire is rooted: it never moves', () => {
    const w = arena(85, 3)
    tank(w, 29.5, 20.5)
    const spire = spawnHive(w, 30.5, 20.5)
    run(w, 200)
    expect(spire.pos).toEqual({ x: 30.5, y: 20.5 })
  })
})

// ── Scheduling, scaling, wiring, determinism ───────────────────────────────

describe('tides: scheduled raids scaled by depth', () => {
  it('floor 1 fields no groups at all; deeper floors field more, bigger raids', () => {
    expect(tideCount(1)).toBe(0)
    expect(tideCount(2)).toBeGreaterThanOrEqual(1)
    expect(tideCount(6)).toBeGreaterThanOrEqual(tideCount(2))
    for (let f = 2; f < 9; f++) expect(raidSize(f + 1)).toBeGreaterThanOrEqual(raidSize(f))
    expect(strategiesFor(2)).not.toContain('siege')
    expect(strategiesFor(4)).toContain('siege')
    expect(strategiesFor(3)).toContain('sappers')
    // Specialists always muster, even at the smallest size.
    expect(raidRoster('siege', 4)).toContain('artillery')
    expect(raidRoster('sappers', 3)).toContain('sapper')
    expect(raidRoster('staging', 2)).toContain('leader')
    expect(raidRoster('staging', 3)).toContain('medic')
  })

  it('a populated floor 1 has no groups; floor 2 arms a tide that arrives on schedule', () => {
    const w1 = createWorld(5, 1)
    populateWorld(w1)
    expect(w1.groups).toBeUndefined()

    const w = createWorld(5, 2)
    populateWorld(w)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    p.health!.max = p.health!.hp = 1_000_000
    expect(w.groups?.tide?.max).toBe(tideCount(2))
    const log: SimEvent[] = []
    run(w, TIDE_FIRST_TICKS + 12 * 30, log)
    const arrive = ofType(log, 'raidArrive')
    expect(arrive.length).toBe(1)
    expect(arrive[0].count).toBeGreaterThan(0)
  })

  it('a tide with no living player to hunt waits instead of spawning blind', () => {
    const w = arena(91, 3)
    initTides(w)
    const log: SimEvent[] = []
    run(w, TIDE_FIRST_TICKS + 20 * 30, log)
    expect(ofType(log, 'raidArrive').length).toBe(0)
  })

  it('the group layer never draws from the sim stream (w.rng)', () => {
    const w = arena(92, 5)
    const p = tank(w, 20.5, 20.5)
    spawnRaid(w, 'siege', { x: 35.5, y: 20.5 }, p)
    spawnPack(w, { x: 40.5, y: 30.5 }, 3)
    spawnHive(w, 12.5, 30.5)
    initTides(w)
    for (let i = 0; i < 400; i++) {
      const before = w.rng.state()
      groupSystem(w)
      expect(w.rng.state()).toBe(before)
      w.tick++
    }
  })
})

describe('determinism: a floor full of groups replays byte-identically', () => {
  const build = (): World => {
    const w = createWorld(1234, 4)
    populateWorld(w)
    const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    p.health!.max = p.health!.hp = 1_000_000
    return w
  }

  /** Run until the first tide lands (bounded), then `extra` ticks more. */
  const untilRaid = (w: World, extra: number, log?: SimEvent[]): void => {
    for (let i = 0; i < TIDE_FIRST_TICKS + 30 * 30; i++) {
      run(w, 1, log)
      if (ofType(w.events, 'raidArrive').length) break
    }
    run(w, extra, log)
  }

  it('same seed + inputs → identical worlds, through a tide', () => {
    const a = build()
    const b = build()
    const log: SimEvent[] = []
    untilRaid(a, 300, log)
    untilRaid(b, 300)
    expect(ofType(log, 'raidArrive').length).toBe(1)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })

  it('serialize mid-raid → deserialize → both continue byte-identically', () => {
    const a = build()
    untilRaid(a, 20)
    expect(a.groups?.list.some((g) => g.kind === 'raid')).toBe(true)
    const b = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(a))))
    run(a, 300)
    run(b, 300)
    expect(serializeWorld(b)).toEqual(serializeWorld(a))
  })
})
