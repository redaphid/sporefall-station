// Pluggable NPC behaviors — adversarial TDD per the testing mandate. Every test
// sets exact world state (createWorld + carved arena + spawns), runs the REAL
// systems via tickWorld, and asserts on entity component state / events / the
// serialized world. Degenerate inputs (unknown behavior ids, despawned targets,
// walled-in patrollers, contested pickups, mid-decision snapshots) sit next to
// the happy paths.

import { describe, expect, it } from 'vitest'
import { makeEntity, type Entity } from '../entity'
import { Tile } from '../levelgen/level'
import { spawnPlayer } from '../player'
import { assignPatrol, spawnNpc } from '../populate'
import { deserializeWorld, serializeWorld } from '../serialize'
import { emptyInput, type SimEvent } from '../types'
import { addEntity, createWorld, tickWorld, type World } from '../world'
import { BEHAVIORS, DEFAULT_BEHAVIOR, behaviorFor, decide } from './behaviors'
import { applyDamage } from './combat'

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

const run = (w: World, n: number): void => {
  for (let i = 0; i < n; i++) tickWorld(w, new Map([[0, { ...emptyInput() }]]))
}

/** Run up to `n` ticks, collecting every event; stops early when `until` says so. */
const runCollecting = (w: World, n: number, until?: (w: World) => boolean): SimEvent[] => {
  const seen: SimEvent[] = []
  for (let i = 0; i < n; i++) {
    tickWorld(w, new Map([[0, { ...emptyInput() }]]))
    seen.push(...w.events)
    if (until?.(w)) break
  }
  return seen
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y)

/** A big open arena so LOS/movement are clean regardless of the seed's layout. */
const arena = (seed = 7, hostile = false): World => {
  const w = createWorld(seed, 1, 'normal', hostile)
  carve(w, 4, 4, 60, 40)
  return w
}

const pickupAt = (w: World, itemId: string, x: number, y: number): Entity => {
  const e = makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3)
  e.pickup = { itemId, qty: 1 }
  return addEntity(w, e)
}

describe('behavior registry', () => {
  it('ships the advertised brains, each a pure list of consideration ids', () => {
    for (const id of ['basic', 'patrol', 'hunter', 'skittish', 'scavenger']) {
      expect(BEHAVIORS[id], id).toBeDefined()
      expect(BEHAVIORS[id].considerations.length).toBeGreaterThan(0)
    }
  })

  it('an unknown behavior id falls back to basic instead of crashing', () => {
    const w = arena(7, true)
    spawnPlayer(w, 0, 10.5, 10.5)
    const npc = spawnNpc(w, 'thug', 14.5, 10.5)
    npc.ai!.behavior = 'does-not-exist'
    expect(behaviorFor(npc)).toBe(BEHAVIORS[DEFAULT_BEHAVIOR])
    run(w, 60)
    expect(npc.ai!.mode).toBe('aggro') // still fights like a basic thug
    expect(npc.ai!.behavior).toBe('does-not-exist') // the component is preserved, not "fixed"
  })

  it('zero valid candidates decides wander (the safe baseline)', () => {
    const w = arena()
    const npc = spawnNpc(w, 'bouncer', 20.5, 20.5)
    const { goal, scores } = decide(w, npc)
    expect(goal.code).toBe('wander')
    expect(scores.wander).toBe(1)
  })

  it('every think records a legible score trail on the entity', () => {
    const w = arena(7, true)
    spawnPlayer(w, 0, 10.5, 10.5)
    const npc = spawnNpc(w, 'thug', 13.5, 10.5)
    run(w, 12)
    expect(npc.ai!.lastScores).toBeDefined()
    expect(npc.ai!.lastScores!.threat).toBeGreaterThan(1) // why it aggroed, in numbers
    expect(npc.ai!.goal).toBe('battle')
    expect(npc.ai!.goalSince).toBeGreaterThanOrEqual(0)
  })
})

describe('patrol', () => {
  it('walks its waypoint loop and cycles patrolIndex', () => {
    const w = arena()
    const cop = spawnNpc(w, 'cop', 10.5, 10.5)
    assignPatrol(cop, [
      { x: 10.5, y: 10.5 },
      { x: 16.5, y: 10.5 },
      { x: 16.5, y: 14.5 },
    ])
    const visited = new Set<number>()
    for (let i = 0; i < 600; i++) {
      run(w, 1)
      visited.add(cop.ai!.patrolIndex ?? 0)
    }
    expect(visited.size).toBe(3) // walked every leg of the beat
    expect(dist(cop.pos, { x: 10.5, y: 10.5 })).toBeLessThan(20) // stayed on the beat, no runaway
  })

  it('drops the beat to fight when a hostile shows up (tiers compose)', () => {
    const w = arena(7, true)
    const cop = spawnNpc(w, 'cop', 10.5, 10.5)
    assignPatrol(cop, [
      { x: 10.5, y: 10.5 },
      { x: 16.5, y: 10.5 },
    ])
    spawnPlayer(w, 0, 13.5, 10.5)
    run(w, 40)
    expect(cop.ai!.mode).toBe('aggro') // threat tier beat the ambient patrol tier
  })

  it('boxed in with an unreachable waypoint it neither crashes nor NaN-poisons the world', () => {
    const w = arena()
    // A 1×1 cell sealed on all sides.
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) wall(w, 30 + dx, 30 + dy)
    const cop = spawnNpc(w, 'cop', 30.5, 30.5)
    assignPatrol(cop, [
      { x: 30.5, y: 30.5 },
      { x: 40.5, y: 30.5 }, // unreachable: outside the sealed cell
    ])
    run(w, 300)
    expect(Number.isFinite(cop.pos.x)).toBe(true)
    expect(Number.isFinite(cop.pos.y)).toBe(true)
    expect(dist(cop.pos, { x: 30.5, y: 30.5 })).toBeLessThan(1.5) // still in its cell
    expect(() => serializeWorld(w)).not.toThrow()
  })

  it('assignPatrol refuses a degenerate beat (fewer than 2 points)', () => {
    const w = arena()
    const cop = spawnNpc(w, 'cop', 10.5, 10.5)
    assignPatrol(cop, [{ x: 10.5, y: 10.5 }])
    expect(cop.ai!.behavior).toBeUndefined()
    expect(cop.ai!.params).toBeUndefined()
  })
})

describe('hunter', () => {
  /** A hunter with a grudge and its prey, 5 tiles apart. */
  const hunterScene = (): { w: World; player: Entity; hunter: Entity } => {
    const w = arena()
    const player = spawnPlayer(w, 0, 10.5, 20.5)
    const hunter = spawnNpc(w, 'gangster', 15.5, 20.5)
    hunter.combat!.weapon = 'bat' // melee, so the demo is a chase not a shootout
    hunter.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
    return { w, player, hunter }
  }

  it('presses to last-known position and sweeps the area before giving up', () => {
    const { w, player, hunter } = hunterScene()
    run(w, 12)
    expect(hunter.ai!.mode).toBe('aggro')
    const lastSeen = { x: player.pos.x, y: player.pos.y }
    // The prey blinks 30 tiles away — far outside sightRange 8.
    player.pos.x = 45.5
    player.prevPos.x = 45.5
    let reachedColdTrail = false
    let searched = false
    for (let i = 0; i < 600 && hunter.ai!.targetId !== undefined; i++) {
      run(w, 1)
      if (dist(hunter.pos, lastSeen) < 2) reachedColdTrail = true
      if (hunter.ai!.goal === 'search' && hunter.ai!.search) searched = true
    }
    expect(reachedColdTrail).toBe(true) // walked to where the trail went cold
    expect(searched).toBe(true) // swept the area (visible search state)
    expect(hunter.ai!.targetId).toBeUndefined() // then gave up
    expect(hunter.ai!.search).toBeUndefined()
    expect(['wander', 'idle']).toContain(hunter.ai!.mode)
  })

  it('a basic brain abandons the same lost target at its leash (the behaviors genuinely differ)', () => {
    const { w, player, hunter } = hunterScene()
    hunter.ai!.behavior = 'basic'
    run(w, 12)
    const lastSeen = { x: player.pos.x, y: player.pos.y }
    player.pos.x = 45.5
    player.prevPos.x = 45.5
    let searched = false
    for (let i = 0; i < 600; i++) {
      run(w, 1)
      if (hunter.ai!.goal === 'search') searched = true
    }
    expect(searched).toBe(false) // no sweep — that is the hunter's own move
    void lastSeen
  })

  it('routes AROUND a concave wall corner to the remembered spot instead of wedging (the router)', () => {
    const { w, player, hunter } = hunterScene()
    player.health!.max = 100000 // survives the whole clip, so the found-fight holds
    player.health!.hp = 100000
    run(w, 12)
    expect(hunter.ai!.mode).toBe('aggro')
    // An L-wall between the hunter and the remembered spot: straight-line
    // steering used to wedge on the inside corner; the router walks around it.
    for (let y = 16; y <= 21; y++) wall(w, 12, y)
    for (let x = 8; x <= 12; x++) wall(w, x, 21)
    player.pos = { x: 10.5, y: 18.5 } // unseen, behind the L
    player.prevPos = { x: 10.5, y: 18.5 }
    hunter.ai!.lastKnownTargetPos = { x: 10.5, y: 18.5 }
    run(w, 400)
    // It went around the L, found the player hiding at the remembered spot and
    // engaged — deliberate pursuit, not a wall-grind, and never NaN. (Assert
    // against the LIVE player: bat knockback herds the fighting pair around.)
    expect(dist(hunter.pos, player.pos)).toBeLessThan(2.5)
    expect(['battle', 'pursue']).toContain(hunter.ai!.goal)
    expect(Number.isFinite(hunter.pos.x)).toBe(true)
    expect(Number.isFinite(hunter.pos.y)).toBe(true)
  })

  it('survives its quarry despawning mid-hunt', () => {
    const { w, player, hunter } = hunterScene()
    run(w, 12)
    expect(hunter.ai!.targetId).toBe(player.id)
    player.dead = true // hard despawn (swept next tick)
    run(w, 60)
    expect(hunter.ai!.targetId).toBeUndefined()
    expect(hunter.ai!.search).toBeUndefined()
    expect(Number.isFinite(hunter.pos.x)).toBe(true)
  })
})

describe('skittish', () => {
  /** A civilian, its attacker, and a cop 12 tiles off — beyond the crime-witness
   * radius (10) but inside alert range (14), so ONLY the alert can turn the cop. */
  const alertScene = (): { w: World; player: Entity; civ: Entity; cop: Entity } => {
    const w = arena()
    const player = spawnPlayer(w, 0, 10.5, 20.5)
    const civ = spawnNpc(w, 'civilian', 12.5, 20.5)
    const cop = spawnNpc(w, 'cop', 24.5, 20.5)
    cop.ai!.guard = true // holds post so the distances stay honest
    return { w, player, civ, cop }
  }

  it('a hurt civilian runs to the guard, reports the attacker, and the guard turns on them', () => {
    const { w, player, civ, cop } = alertScene()
    applyDamage(w, civ, 3, player.pos.x, player.pos.y, 0, player.id)
    expect(civ.ai!.mode).toBe('flee')
    const events = runCollecting(w, 400, () => civ.ai!.alerted !== undefined)
    const alerted = events.find((ev) => ev.type === 'alerted')
    expect(alerted).toEqual({ type: 'alerted', entityId: cop.id, byId: civ.id, targetId: player.id })
    expect(civ.ai!.alerted).toBe(player.id)
    expect(cop.ai!.mode).toBe('aggro')
    expect(cop.ai!.targetId).toBe(player.id)
    expect(cop.ai!.rel?.[player.id]?.code).toBe('Hostile')
    // Report filed → it never chases the cop; it keeps fleeing, or calms down
    // once well clear (it just ran 12 tiles) — but the fear record remains.
    run(w, 20)
    expect(civ.ai!.mode).not.toBe('seek')
    expect(civ.ai!.mode).not.toBe('aggro')
    expect(civ.ai!.fearId).toBe(player.id)
  })

  it('does not re-alert about the same attacker twice', () => {
    const { w, player, civ } = alertScene()
    applyDamage(w, civ, 3, player.pos.x, player.pos.y, 0, player.id)
    const first = runCollecting(w, 400, () => civ.ai!.alerted !== undefined)
    expect(first.filter((ev) => ev.type === 'alerted')).toHaveLength(1)
    const after = runCollecting(w, 200)
    expect(after.filter((ev) => ev.type === 'alerted')).toHaveLength(0)
  })

  it('falls back to plain flight when the guard dies mid-run', () => {
    const { w, player, civ, cop } = alertScene()
    applyDamage(w, civ, 3, player.pos.x, player.pos.y, 0, player.id)
    runCollecting(w, 60, () => civ.ai!.goal === 'alert')
    expect(civ.ai!.goal).toBe('alert')
    cop.dead = true // guard despawns while being run to
    run(w, 30)
    expect(civ.ai!.alerted).toBeUndefined() // never got to report
    expect(civ.ai!.targetId).toBe(player.id) // back to fleeing the scarer
    expect(civ.ai!.mode).toBe('flee')
  })

  it('with no guard in range it just flees (alert never fires)', () => {
    const w = arena()
    const player = spawnPlayer(w, 0, 10.5, 20.5)
    const civ = spawnNpc(w, 'civilian', 12.5, 20.5)
    applyDamage(w, civ, 3, player.pos.x, player.pos.y, 0, player.id)
    const events = runCollecting(w, 200)
    expect(events.filter((ev) => ev.type === 'alerted')).toHaveLength(0)
    expect(civ.ai!.alerted).toBeUndefined()
    expect(dist(civ.pos, player.pos)).toBeGreaterThan(4) // it ran
  })
})

describe('scavenger', () => {
  const scavenger = (w: World, x: number, y: number): Entity => {
    const s = spawnNpc(w, 'civilian', x, y)
    s.ai!.behavior = 'scavenger'
    return s
  }

  it('walks to a visible pickup, collects it into its stash, and emits the pickup event', () => {
    const w = arena()
    const s = scavenger(w, 20.5, 20.5)
    const loot = pickupAt(w, 'medkit', 24.5, 20.5)
    const events = runCollecting(w, 300, () => !w.byId.has(loot.id))
    expect(w.byId.has(loot.id)).toBe(false) // taken off the floor
    expect(s.ai!.stash).toEqual(['medkit'])
    expect(events).toContainEqual({ type: 'pickup', entityId: loot.id, byId: s.id, itemId: 'medkit' })
  })

  it('two scavengers contesting one pickup: exactly one wins, the loser re-decides cleanly', () => {
    const w = arena()
    const a = scavenger(w, 20.5, 20.5)
    const b = scavenger(w, 26.5, 20.5)
    pickupAt(w, 'cash', 23.5, 20.5)
    run(w, 300)
    const stashes = [a.ai!.stash ?? [], b.ai!.stash ?? []]
    expect(stashes.flat()).toEqual(['cash']) // one copy, one winner
    for (const e of [a, b]) {
      expect(e.ai!.mode).not.toBe('seek') // nobody is stuck seeking a ghost
      expect(Number.isFinite(e.pos.x)).toBe(true)
    }
  })

  it('never loots the mission objective', () => {
    const w = arena()
    const s = scavenger(w, 20.5, 20.5)
    const brief = pickupAt(w, 'briefcase', 22.5, 20.5)
    w.mission.targetEntityId = brief.id
    run(w, 300)
    expect(w.byId.has(brief.id)).toBe(true) // still on the floor for the players
    expect(s.ai!.stash ?? []).toHaveLength(0)
  })

  it('never loots weapon-mod gems', () => {
    const w = arena()
    scavenger(w, 20.5, 20.5)
    const gem = makeEntity('pickup', 'mod.pierce', 22.5, 20.5, 0.3)
    gem.pickup = { itemId: 'pierce', qty: 1 }
    addEntity(w, gem)
    run(w, 300)
    expect(w.byId.has(gem.id)).toBe(true)
  })
})

describe('AI world events', () => {
  it('adopting aggro emits an aiGoal event with the target', () => {
    const w = arena(7, true)
    const player = spawnPlayer(w, 0, 10.5, 10.5)
    const thug = spawnNpc(w, 'thug', 14.5, 10.5)
    const events = runCollecting(w, 30, () => thug.ai!.mode === 'aggro')
    const ev = events.find((e) => e.type === 'aiGoal' && e.entityId === thug.id)
    expect(ev).toMatchObject({ type: 'aiGoal', goal: 'battle', targetId: player.id })
  })

  it('breaking off (aggro → wander) also emits, so disengagement is observable', () => {
    const w = arena(7, true)
    const player = spawnPlayer(w, 0, 10.5, 10.5)
    const thug = spawnNpc(w, 'thug', 14.5, 10.5)
    runCollecting(w, 30, () => thug.ai!.mode === 'aggro')
    player.pos.x = 55.5 // vanish far beyond sight and leash
    player.prevPos.x = 55.5
    const events = runCollecting(w, 400, () => thug.ai!.goal === 'wander')
    const brokeOff = events.find(
      (e) => e.type === 'aiGoal' && e.entityId === thug.id && e.goal === 'wander',
    )
    expect(brokeOff).toBeDefined()
  })
})

describe('determinism (the sacred invariant)', () => {
  it('a mid-chase, mid-alert, mid-scavenge snapshot restores and continues byte-identically', () => {
    // No level mutation here: deserializeWorld regenerates the level from
    // seed+floor and checksums it, so the scene stages around the natural spawn.
    const w = createWorld(99, 1, 'normal', false)
    const sp = w.level.spawn
    const player = spawnPlayer(w, 0, sp.x, sp.y)
    const hunter = spawnNpc(w, 'gangster', sp.x + 4, sp.y)
    hunter.combat!.weapon = 'bat'
    hunter.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
    const civ = spawnNpc(w, 'civilian', sp.x + 2, sp.y + 2)
    const cop = spawnNpc(w, 'cop', sp.x + 12, sp.y)
    cop.ai!.guard = true
    const scav = spawnNpc(w, 'civilian', sp.x - 3, sp.y)
    scav.ai!.behavior = 'scavenger'
    pickupAt(w, 'cash', sp.x - 6, sp.y)
    assignPatrol(spawnNpc(w, 'cop', sp.x, sp.y + 6), [
      { x: sp.x, y: sp.y + 6 },
      { x: sp.x + 5, y: sp.y + 6 },
    ])
    applyDamage(w, civ, 3, player.pos.x, player.pos.y, 0, player.id) // scare the civ
    run(w, 45) // land mid-chase / mid-alert-run / mid-fetch / mid-beat
    expect(civ.ai!.fearId).toBe(player.id) // genuinely mid-decision, not idle

    const snap = serializeWorld(w)
    const restored = deserializeWorld(JSON.parse(JSON.stringify(snap)))
    expect(serializeWorld(restored)).toEqual(snap) // lossless round-trip mid-decision

    run(w, 90)
    run(restored, 90)
    expect(serializeWorld(restored)).toEqual(serializeWorld(w)) // identical continuation
  })

  it('same seed + same inputs → identical NPC decisions across all new behaviors', () => {
    const build = (): World => {
      const w = arena(4242, true)
      spawnPlayer(w, 0, 12.5, 20.5)
      spawnNpc(w, 'gangster', 20.5, 20.5)
      spawnNpc(w, 'civilian', 15.5, 24.5)
      const s = spawnNpc(w, 'civilian', 30.5, 20.5)
      s.ai!.behavior = 'scavenger'
      pickupAt(w, 'bandage', 33.5, 20.5)
      assignPatrol(spawnNpc(w, 'cop', 40.5, 20.5), [
        { x: 40.5, y: 20.5 },
        { x: 45.5, y: 20.5 },
      ])
      return w
    }
    const a = build()
    const b = build()
    run(a, 150)
    run(b, 150)
    expect(serializeWorld(a)).toEqual(serializeWorld(b))
  })
})
