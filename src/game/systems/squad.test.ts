// Squad tactics ('squad' behavior) — adversarial TDD. Exact world state via
// createWorld + carved geometry (or populate for the wiring tests), the REAL
// systems via tickWorld, assertions on the choreography over time: formation
// on the lead, door stack-up before entry, breaching together, flanking the
// lead's target, deterministic promotion when the lead dies, and byte-identical
// evolution per seed.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { generateLevel } from '../levelgen/generate'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { populateWorld, spawnNpc } from '../populate'
import { serializeWorld } from '../serialize'
import { emptyInput } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'

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

/** Whole level solid, then a carved box — walls genuinely seal. */
const sealedArena = (seed = 7): World => {
  const w = createWorld(seed, 1, 'normal', true)
  w.level.tiles.fill(Tile.Wall)
  w.level.solid.fill(1)
  carve(w, 4, 4, 40, 30)
  return w
}

const run = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, { ...emptyInput() }]]))
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

const squaddie = (w: World, x: number, y: number, role: 'lead' | 'flank' | 'rear', id = 1): Entity => {
  const e = spawnNpc(w, 'thug', x, y)
  e.combat!.weapon = 'bat'
  e.ai!.behavior = 'squad'
  e.ai!.squad = { id, role }
  e.ai!.sightRange = 12 // a trained pack watches further than street rabble
  return e
}

describe('formation', () => {
  it('followers converge on and track the lead as it moves', () => {
    const w = sealedArena()
    const lead = squaddie(w, 10.5, 20.5, 'lead')
    const flank = squaddie(w, 30.5, 8.5, 'flank')
    const rear = squaddie(w, 30.5, 26.5, 'rear')
    // The lead walks a private errand; the others start scattered across the arena.
    lead.ai!.mode = 'wander'
    lead.ai!.waypoint = { x: 20.5, y: 20.5 }
    run(w, 300)
    // Formed up: slots sit ~1-2.5 tiles off the lead; the lead's scan sweeps
    // rotate the slots around it, so allow the orbit's reach.
    expect(dist(flank.pos, lead.pos)).toBeLessThan(5.5)
    expect(dist(rear.pos, lead.pos)).toBeLessThan(5.5)
    // The lead keeps walking — the slots track it, not its old position.
    lead.ai!.mode = 'wander'
    lead.ai!.waypoint = { x: 34.5, y: 22.5 }
    run(w, 300)
    expect(dist(flank.pos, lead.pos)).toBeLessThan(5.5)
    expect(dist(rear.pos, lead.pos)).toBeLessThan(5.5)
  })

  it('a lone squad member (mates all dead) degrades to ordinary behavior — no crash, no freeze', () => {
    const w = sealedArena()
    const lead = squaddie(w, 10.5, 20.5, 'lead')
    const rear = squaddie(w, 12.5, 20.5, 'rear')
    lead.dead = true
    run(w, 200)
    expect(Number.isFinite(rear.pos.x)).toBe(true)
    expect(rear.ai!.mode).not.toBe('aggro') // nothing to fight; it just lives on
  })

  it('the lead dying mid-march promotes the lowest-id survivor deterministically', () => {
    const w = sealedArena()
    const lead = squaddie(w, 10.5, 20.5, 'lead')
    const flank = squaddie(w, 12.5, 20.5, 'flank')
    const rear = squaddie(w, 14.5, 20.5, 'rear')
    run(w, 60)
    lead.dead = true
    run(w, 240)
    // The flank (lowest surviving id) is now acting lead: the rear forms on IT.
    expect(dist(rear.pos, flank.pos)).toBeLessThan(4)
    expect(Number.isFinite(flank.pos.x)).toBe(true)
  })
})

describe('door stack-up and breach', () => {
  /** Two rooms split at x=16 with one doorway at (16,17): squad east, prey west. */
  const breachScene = (): { w: World; player: Entity; door: Entity; squad: Entity[] } => {
    const w = sealedArena()
    for (let y = 4; y <= 30; y++) if (y !== 17) wall(w, 16, y)
    const door = makeEntity('door', 'door', 16.5, 17.5, 0.5)
    door.door = { open: false, locked: false, lockLevel: 0 }
    door.interact = { verb: 'open', range: 1.3 }
    addEntity(w, door)
    const player = spawnPlayer(w, 0, 8.5, 17.5)
    player.health!.max = 100000
    player.health!.hp = 100000
    const lead = squaddie(w, 26.5, 17.5, 'lead')
    const flank = squaddie(w, 30.5, 12.5, 'flank')
    const rear = squaddie(w, 30.5, 22.5, 'rear')
    // The lead knows where the prey was; the squad has never seen it.
    lead.ai!.mode = 'aggro'
    lead.ai!.targetId = player.id
    lead.ai!.lastKnownTargetPos = { x: player.pos.x, y: player.pos.y }
    lead.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
    return { w, player, door, squad: [lead, flank, rear] }
  }

  it('the lead HOLDS at the door until the squad stacks, then all breach within a tight window', () => {
    const { w, player, door, squad } = breachScene()
    let sawHold = false
    let holdWhileOpen = false
    const crossTick = new Map<number, number>()
    for (let i = 0; i < 900; i++) {
      run(w, 1)
      const lead = squad[0]
      if (lead.ai!.goal === 'stack') {
        sawHold = true
        if (door.door!.open) holdWhileOpen = true // must only hold at a CLOSED door
      }
      for (const m of squad) {
        if (!crossTick.has(m.id) && m.pos.x < 16) crossTick.set(m.id, w.tick)
      }
      if (crossTick.size === 3) break
    }
    expect(sawHold).toBe(true) // the stack beat actually happened
    expect(holdWhileOpen).toBe(false)
    expect(door.door!.open).toBe(true) // breached by hand, not phased
    expect(crossTick.size).toBe(3) // every member made entry
    const ticks = [...crossTick.values()]
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThanOrEqual(90) // together, ~3s window
    void player
  })

  it('the squad ends up ON the prey side and engages the found target', () => {
    const { w, player, squad } = breachScene()
    run(w, 900)
    for (const m of squad) expect(m.pos.x).toBeLessThan(16.5)
    // Somebody is pressing the attack on the rediscovered player.
    expect(squad.some((m) => m.ai!.mode === 'aggro' && m.ai!.targetId === player.id)).toBe(true)
  })

  it('a LOCKED door never triggers a stack (nothing to breach) and nobody phases', () => {
    const { w, door, squad } = breachScene()
    door.door!.locked = true
    let sawHold = false
    for (let i = 0; i < 400; i++) {
      run(w, 1)
      if (squad[0].ai!.goal === 'stack') sawHold = true
    }
    expect(sawHold).toBe(false)
    expect(door.door!.open).toBe(false)
    for (const m of squad) expect(m.pos.x).toBeGreaterThan(16.5)
  })
})

describe('flanking', () => {
  it('the flank member swings to the far side of the lead’s target', () => {
    const w = sealedArena()
    const player = spawnPlayer(w, 0, 20.5, 17.5)
    player.health!.max = 100000
    player.health!.hp = 100000
    // Lead and flank approach from the SAME side (east), well inside sight.
    const lead = squaddie(w, 28.5, 17.5, 'lead')
    const flank = squaddie(w, 30.5, 15.5, 'flank')
    lead.ai!.sightRange = 20
    flank.ai!.sightRange = 20
    let sawFlankGoal = false
    let oppositeSide = false
    for (let i = 0; i < 600; i++) {
      run(w, 1)
      if (flank.ai!.goal === 'flank') sawFlankGoal = true
      const dot =
        (flank.pos.x - player.pos.x) * (lead.pos.x - player.pos.x) +
        (flank.pos.y - player.pos.y) * (lead.pos.y - player.pos.y)
      if (dot < 0 && dist(flank.pos, player.pos) < 6) oppositeSide = true
    }
    expect(sawFlankGoal).toBe(true) // it chose the flank route, not the straight charge
    expect(oppositeSide).toBe(true) // and genuinely reached the far side
  })
})

describe('populate wiring', () => {
  const findFloorWith = (role: 'warehouse' | 'bunker'): { seed: number; floor: number } => {
    for (let seed = 1; seed <= 60; seed++) {
      for (let floor = 2; floor <= 4; floor++) {
        if (generateLevel(seed, floor).buildings.some((b) => b.role === role)) return { seed, floor }
      }
    }
    throw new Error(`no ${role} in search bound`)
  }

  const populated = (seed: number, floor: number): World => {
    const w = createWorld(seed, floor)
    populateWorld(w)
    return w
  }

  it('a gang pack in a warehouse/bunker links into a squad with legal roles and size 2-4', () => {
    // Scan a few seeds: squads form (SQUAD_CHANCE < 1, so not necessarily the
    // first candidate), always well-formed when they do.
    let sawSquad = false
    for (let seed = 1; seed <= 20 && !sawSquad; seed++) {
      const w = populated(seed, 3)
      const byId = new Map<number, Entity[]>()
      for (const e of w.entities) {
        if (!e.ai?.squad) continue
        expect(e.ai.behavior).toBe('squad')
        const list = byId.get(e.ai.squad.id) ?? []
        list.push(e)
        byId.set(e.ai.squad.id, list)
      }
      for (const members of byId.values()) {
        sawSquad = true
        expect(members.length).toBeGreaterThanOrEqual(2)
        expect(members.length).toBeLessThanOrEqual(4)
        expect(members.filter((m) => m.ai!.squad!.role === 'lead')).toHaveLength(1)
        expect(members.filter((m) => m.ai!.squad!.role === 'flank').length).toBeLessThanOrEqual(1)
      }
    }
    expect(sawSquad).toBe(true)
  })

  it('patrol beats keep their brains: no patroller is ever conscripted into a squad', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const w = populated(seed, 3)
      for (const e of w.entities) {
        if (e.ai?.behavior === 'patrol') expect(e.ai.squad).toBeUndefined()
      }
    }
  })

  it('squad assignment is deterministic: same seed+floor → identical squads', () => {
    const { seed, floor } = findFloorWith('warehouse')
    const pick = (w: World): unknown =>
      w.entities.filter((e) => e.ai?.squad).map((e) => ({ id: e.id, squad: e.ai!.squad, behavior: e.ai!.behavior }))
    expect(pick(populated(seed, floor))).toEqual(pick(populated(seed, floor)))
  })

  it('two populated worlds with squads evolve byte-identically', () => {
    const { seed, floor } = findFloorWith('warehouse')
    const a = populated(seed, floor)
    const b = populated(seed, floor)
    run(a, 120)
    run(b, 120)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})
