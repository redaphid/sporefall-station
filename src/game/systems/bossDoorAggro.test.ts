// The two-stage heist finale.
// Stage 1 — gateway breach: unlocking the door that DIRECTLY gates the mission
// objective is a point of no return — the alarm maxes and every OTHER door on
// the floor pops open (locks, biolocks, overgrowth), but the floor does NOT
// yet mob the party. Stage 2 — taking the prize (completeMission): every unit
// in town aggros the prize-taker for the escape run. Adversarial coverage:
// stage 1 fires for every unlock method (pick + breach) and NEVER for a normal
// door, both stages latch once, allies are spared, posthumous completion
// doesn't crash, and everything is deterministic + round-trips.

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

describe('gateway breach (stage 1) — the station unseals', () => {
  it('a grenade breach maxes the alarm and pops every other door open', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    const player = firstPlayer(w)
    expect(npcs(w).length).toBeGreaterThan(0)
    // A floor has closed (and often sealed) doors before the breach.
    const closedBefore = w.entities.filter((e) => e.door && e.id !== door.id && (!e.door.open || e.door.locked))
    expect(closedBefore.length).toBeGreaterThan(0)

    detonate(w, door.pos.x, door.pos.y, 1.8, 40, player.id)
    runTicks(w, idle(0), 1)

    expect(w.mission.bossAggroTriggered).toBe(true)
    expect(w.alarm).toBe(3)
    for (const e of w.entities) {
      if (!e.door || e.id === door.id) continue
      expect(e.door.open, `door ${e.id} still closed after the release`).toBe(true)
      expect(e.door.locked, `door ${e.id} still locked after the release`).toBe(false)
      expect(e.door.overgrown ?? false, `door ${e.id} still overgrown after the release`).toBe(false)
    }
  })

  it('the breach alone does NOT aggro the floor — the manhunt waits for the prize', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    const player = firstPlayer(w)
    // Blast the gate from a player standing far away so the explosion itself
    // wounds no bystander (a hit would legitimately anger its victim).
    const before = npcs(w).filter((n) => Math.hypot(n.pos.x - door.pos.x, n.pos.y - door.pos.y) > 3)
    const nonHostileBefore = before.filter((n) => dispositionToward(n, player.id) !== 'Hostile')
    expect(nonHostileBefore.length).toBeGreaterThan(0)

    detonate(w, door.pos.x, door.pos.y, 1.8, 40, player.id)
    runTicks(w, idle(0), 1)

    expect(w.mission.bossAggroTriggered).toBe(true)
    for (const n of nonHostileBefore) {
      if (n.dead) continue
      expect(dispositionToward(n, player.id), `npc ${n.archetype} aggroed by breach alone`).not.toBe('Hostile')
    }
  })

  it('emits one doorsReleased event counting the doors it popped', () => {
    const { w } = bootBreachable([2, 3, 5, 6])
    const door = objectiveDoor(w)
    const closedBefore = w.entities.filter((e) => e.door && e.id !== door.id && (!e.door.open || e.door.locked)).length
    detonate(w, door.pos.x, door.pos.y, 1.8, 40, firstPlayer(w).id)
    tickWorld(w, idle(0))
    const released = w.events.filter((e) => e.type === 'doorsReleased')
    expect(released.length).toBe(1)
    expect(released[0]).toMatchObject({ type: 'doorsReleased', count: closedBefore })
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

describe('gateway breach — a completed lockpick also triggers it', () => {
  it('picking the plain floor-1 objective lock unseals the floor', () => {
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
    for (const e of w.entities) {
      if (!e.door || e.id === door.id) continue
      expect(e.door.open && !e.door.locked, `door ${e.id} not released`).toBe(true)
    }
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

/** First seed on `floors` whose mission is `template`, with live faction NPCs. */
const bootTemplate = (template: string, floors: number[], players = 1): World => {
  for (let seed = 1; seed <= 300; seed++) {
    for (const floor of floors) {
      const w = boot(seed, floor, players)
      if (w.mission.template !== template) continue
      if (!w.entities.some((e) => e.ai && !e.dead && !e.playerCtl)) continue
      return w
    }
  }
  throw new Error(`no ${template} floor found`)
}

describe('taking the prize (stage 2) — every unit in town aggros the taker', () => {
  it('grabbing the specimen canister turns the whole floor on the holder', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    const player = firstPlayer(w)
    const before = npcs(w)
    expect(before.some((n) => dispositionToward(n, player.id) !== 'Hostile')).toBe(true)

    // The canister lands in the holder's loadout — exactly what auto-pickup does.
    player.loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
    runTicks(w, idle(0), 1)

    expect(w.mission.complete).toBe(true)
    expect(w.mission.exitUnlocked).toBe(true)
    expect(w.alarm).toBe(3)
    for (const n of npcs(w)) {
      expect(dispositionToward(n, player.id)).toBe('Hostile')
      expect(n.ai!.mode).toBe('aggro')
      expect(n.ai!.targetId).toBe(player.id)
    }
  })

  it('an assassination completing the mission calls the manhunt too', () => {
    const w = bootTemplate('assassinate', [1, 2, 3])
    const player = firstPlayer(w)
    const boss = w.byId.get(w.mission.targetEntityId!)!
    boss.dead = true
    runTicks(w, idle(0), 1)

    expect(w.mission.complete).toBe(true)
    expect(w.alarm).toBe(3)
    for (const n of npcs(w)) expect(dispositionToward(n, player.id)).toBe('Hostile')
  })

  it('co-op allies are spared by the manhunt', () => {
    const w = bootTemplate('steal', [1, 2, 3], 2)
    const players = w.entities.filter((e) => e.playerCtl)
    expect(players.length).toBe(2)
    players[0].loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
    runTicks(w, idle(0, 1), 1)

    // Allies gain no brain and are never targeted by their own party's NPCs.
    for (const p of players) {
      expect(p.ai).toBeUndefined()
      expect(p.dead).toBeFalsy()
    }
    for (const n of npcs(w)) expect(n.ai!.targetId).toBe(players[0].id)
  })

  it('fires exactly once — the completion latch holds', () => {
    const w = bootTemplate('steal', [1, 2, 3])
    firstPlayer(w).loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
    runTicks(w, idle(0), 1)
    expect(w.mission.complete).toBe(true)
    // Wind the alarm back down; completion must not re-raise it. (Individual
    // NPCs may legitimately re-aggro on SIGHT — their hate is permanent — but
    // the floor-wide escalation itself (alarm 3 + everyone flipped at once,
    // sight or no sight) must never fire again.)
    w.alarm = 0
    const eventsAfter: string[] = []
    for (let i = 0; i < 5; i++) {
      tickWorld(w, idle(0))
      eventsAfter.push(...w.events.map((e) => e.type))
    }
    expect(w.alarm).toBe(0)
    expect(eventsAfter).not.toContain('missionComplete')
  })

  it('posthumous completion (no live player) neither crashes nor hunts anyone', () => {
    const w = bootTemplate('assassinate', [1, 2, 3])
    const player = firstPlayer(w)
    const boss = w.byId.get(w.mission.targetEntityId!)!
    // The party wiped, then the boss died anyway (fire tick, chain blast, …).
    player.dead = true
    boss.dead = true
    tickWorld(w, new Map())
    expect(w.mission.complete).toBe(true)
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
