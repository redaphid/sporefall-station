// Boss-door aggro: unlocking the door that DIRECTLY gates the mission objective
// (boss room / objective room) is a point of no return — the whole floor turns
// hostile. Adversarial coverage: it fires for every unlock method (pick + breach),
// NEVER for a normal door, latches once, spares co-op allies, and is fully
// deterministic + round-trips.

import { describe, expect, it } from 'vitest'
import type { Entity } from '../entity'
import { populateWorld } from '../populate'
import { spawnPlayer } from '../player'
import { emptyInput, type InputCmd, type SimEvent } from '../types'
import { createWorld, tickWorld, type World } from '../world'
import { deserializeWorld, serializeWorld } from '../serialize'
import { expectWorldEqual, runTicks } from '../testkit'
import { detonate } from './combat'
import { setupFloor } from './missions'
import { dispositionToward } from './relationships'

const idle = (...ids: number[]): Map<number, InputCmd> => new Map(ids.map((id) => [id, emptyInput()]))

const boot = (seed: number, floor: number, players = 1): World => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  for (let i = 0; i < players; i++) spawnPlayer(w, i, w.level.spawn.x, w.level.spawn.y)
  return w
}

/** First seed on any of `floors` whose mission tagged an objective door AND put
 * at least one live faction NPC on the floor (so the aggro flip is observable). */
const bootBreachable = (floors: number[]): { w: World; seed: number; floor: number } => {
  for (let seed = 1; seed <= 300; seed++) {
    for (const floor of floors) {
      const w = boot(seed, floor)
      if (w.mission.objectiveDoorId === undefined) continue
      if (!w.entities.some((e) => e.ai && !e.dead)) continue
      return { w, seed, floor }
    }
  }
  throw new Error('no breachable objective-door floor found')
}

const objectiveDoor = (w: World): Entity => {
  const d = w.byId.get(w.mission.objectiveDoorId!)
  if (!d?.door) throw new Error('objective door missing')
  return d
}

const npcs = (w: World): Entity[] => w.entities.filter((e) => e.ai && !e.playerCtl && !e.dead)
const firstPlayer = (w: World): Entity => w.entities.find((e) => e.playerCtl)!

describe('boss-door aggro — the objective gateway is tagged', () => {
  it('tags exactly one door (the objective gate) per mission with a target building', () => {
    let checked = 0
    for (let seed = 1; seed <= 40; seed++) {
      for (const floor of [1, 2, 3, 5, 6]) {
        const w = boot(seed, floor)
        const gates = w.entities.filter((e) => e.door?.objectiveGate)
        if (w.mission.targetBuilding === undefined) {
          // `reach` (no building) tags nothing → the escalation can't fire.
          expect(gates.length).toBe(0)
          continue
        }
        if (w.mission.objectiveDoorId === undefined) continue // building had no doors
        checked++
        expect(gates.length).toBe(1)
        expect(gates[0].id).toBe(w.mission.objectiveDoorId)
        // The tagged gate starts SEALED (locked) — every unlock is a real breach.
        expect(gates[0].door!.locked).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(5)
  })
})

describe('boss-door aggro — breaching turns the floor hostile', () => {
  it('a grenade breach of the objective gate maxes the alarm and aggros every NPC', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    const player = firstPlayer(w)
    const before = npcs(w)
    expect(before.length).toBeGreaterThan(0)
    // Pre-breach, a peaceful civ/cop is not yet Hostile toward the player.
    const someNonHostileBefore = before.some((n) => dispositionToward(n, player.id) !== 'Hostile')
    expect(someNonHostileBefore).toBe(true)

    detonate(w, door.pos.x, door.pos.y, 1.8, 40, player.id)
    runTicks(w, idle(0), 1)

    expect(w.mission.bossAggroTriggered).toBe(true)
    expect(w.alarm).toBe(3)
    for (const n of npcs(w)) {
      expect(dispositionToward(n, player.id)).toBe('Hostile')
      expect(n.ai!.mode).toBe('aggro')
      expect(n.ai!.targetId).toBe(player.id)
    }
  })

  it('emits a single bossDoorBreached event naming the gate', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, firstPlayer(w).id)
    tickWorld(w, idle(0))
    const events: SimEvent[] = [...w.events]
    const breached = events.filter((e) => e.type === 'bossDoorBreached')
    expect(breached.length).toBe(1)
    expect(breached[0]).toMatchObject({ type: 'bossDoorBreached', entityId: door.id })
  })
})

describe('boss-door aggro — a completed lockpick also triggers it', () => {
  it('picking the plain floor-1 objective lock turns the floor hostile', () => {
    // Floor 1 keeps plain locks (no access gate), so the objective gate is a
    // mundane pickable door — exercise the real runChannel completion path.
    let boot1: World | undefined
    for (let seed = 1; seed <= 300 && !boot1; seed++) {
      const w = boot(seed, 1)
      if (w.mission.objectiveDoorId !== undefined && w.entities.some((e) => e.ai && !e.dead)) boot1 = w
    }
    const w = boot1!
    const door = objectiveDoor(w)
    const player = firstPlayer(w)
    // Stand the picker on the gate and hand it a channel one tick from done —
    // the exact tail of interaction.runChannel, driven by the real system.
    player.pos.x = door.pos.x
    player.pos.y = door.pos.y
    player.prevPos.x = door.pos.x
    player.prevPos.y = door.pos.y
    player.playerCtl!.channel = { kind: 'lockpick', targetId: door.id, ticksLeft: 1, total: 60 }

    runTicks(w, idle(0), 1)

    expect(door.door!.locked).toBe(false)
    expect(door.door!.open).toBe(true)
    expect(w.mission.bossAggroTriggered).toBe(true)
    expect(w.alarm).toBe(3)
    for (const n of npcs(w)) expect(dispositionToward(n, player.id)).toBe('Hostile')
  })
})

describe('boss-door aggro — a NORMAL door never triggers it', () => {
  it('breaching a non-objective door leaves the floor calm', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    // Any door that is NOT the tagged gate, in a spot away from NPCs so the blast
    // itself commits no crime that could raise the alarm on its own.
    const normal = w.entities.find(
      (e) => e.door && !e.door.objectiveGate && !w.entities.some((n) => n.ai && !n.dead && Math.hypot(n.pos.x - e.pos.x, n.pos.y - e.pos.y) < 2.5),
    )
    expect(normal, 'need a non-objective door clear of NPCs').toBeTruthy()

    detonate(w, normal!.pos.x, normal!.pos.y, 1.8, 40, firstPlayer(w).id)
    tickWorld(w, idle(0))
    const events = [...w.events]
    runTicks(w, idle(0), 10)

    expect(w.mission.bossAggroTriggered).toBeFalsy()
    expect(events.some((e) => e.type === 'bossDoorBreached')).toBe(false)
  })
})

describe('boss-door aggro — latched to fire exactly once', () => {
  it('re-opening / re-toggling the gate never re-triggers the escalation', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, firstPlayer(w).id)
    tickWorld(w, idle(0))
    expect(w.mission.bossAggroTriggered).toBe(true)

    // Wind everything back and toggle the door again: the latch must hold.
    w.alarm = 0
    for (const n of npcs(w)) {
      n.ai!.mode = 'idle'
      n.ai!.targetId = undefined
    }
    door.door!.open = false
    door.door!.locked = false
    const events: SimEvent[] = []
    for (let i = 0; i < 5; i++) {
      tickWorld(w, idle(0))
      events.push(...w.events)
    }
    expect(events.some((e) => e.type === 'bossDoorBreached')).toBe(false)
    expect(w.alarm).toBe(0) // never re-maxed
  })
})

describe('boss-door aggro — co-op allies are spared', () => {
  it('a second player is not turned hostile by the escalation', () => {
    const { seed, floor } = bootBreachable([2, 3, 5, 6])
    const w = boot(seed, floor, 2)
    const door = objectiveDoor(w)
    const players = w.entities.filter((e) => e.playerCtl)
    expect(players.length).toBe(2)

    detonate(w, door.pos.x, door.pos.y, 1.8, 40, players[0].id)
    runTicks(w, idle(0, 1), 1)

    // Allies gain no brain and are never targeted by their own party's NPCs.
    for (const p of players) {
      expect(p.ai).toBeUndefined()
      expect(p.dead).toBeFalsy()
    }
    const focus = players.map((p) => p.id)
    for (const n of npcs(w)) expect(focus).toContain(n.ai!.targetId)
  })
})

describe('boss-door aggro — deterministic & round-trips', () => {
  it('same snapshot + inputs → byte-identical aggro outcome', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, firstPlayer(w).id)
    const snap = serializeWorld(w)
    const a = deserializeWorld(snap)
    const b = deserializeWorld(snap)
    runTicks(a, idle(0), 12)
    runTicks(b, idle(0), 12)
    expectWorldEqual(a, b)
  })

  it('objectiveDoorId, the latch, and door.objectiveGate survive a round-trip', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, firstPlayer(w).id)
    runTicks(w, idle(0), 1)
    expect(w.mission.bossAggroTriggered).toBe(true)

    const round = deserializeWorld(serializeWorld(w))
    expect(round.mission.objectiveDoorId).toBe(w.mission.objectiveDoorId)
    expect(round.mission.bossAggroTriggered).toBe(true)
    expect(round.byId.get(round.mission.objectiveDoorId!)!.door!.objectiveGate).toBe(true)
    expectWorldEqual(w, round)
  })

  it('pre-feature snapshots (no boss-door fields) still round-trip byte-for-byte', () => {
    // A plain `reach` floor tags nothing → mission carries none of the new fields,
    // so the snapshot is unchanged from before the feature.
    const w = createWorld(7, 1)
    spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
    const json = serializeWorld(w)
    expect('objectiveDoorId' in json.mission).toBe(false)
    expect('bossAggroTriggered' in json.mission).toBe(false)
    expectWorldEqual(w, deserializeWorld(json))
  })
})
