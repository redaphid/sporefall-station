// Deterministic demo setups, selected by `?scenario=`. Kept out of the sim
// proper: a scenario just seeds entities into a fresh world before play starts.

import { WEAPONS } from './data/items'
import { makeEntity, type Entity } from './entity'
import { isSolidTile, Tile } from './levelgen/level'
import { spawnNpc } from './populate'
import { igniteCell } from './systems/fire'
import { freeze, wet } from './systems/interactions'
import { spawnObject } from './systems/objects'
import { addEntity, type World } from './world'

const crate = (w: World, cx: number, cy: number): Entity => {
  const e = makeEntity('interactable', 'crate', cx + 0.5, cy + 0.5, 0.4)
  e.flammable = true
  e.health = { hp: 30, max: 30, iframes: 0 }
  return addEntity(w, e)
}

const openRow = (w: World, x: number, y: number, n: number): boolean => {
  for (let i = 0; i < n; i++) if (isSolidTile(w.level, x + i, y)) return false
  return true
}

/** A run of `n` open cells nearest the level centre — a stage the camera can
 * frame without clamping into a corner. */
const findStage = (w: World, n: number): { x: number; y: number } => {
  const midX = Math.floor(w.level.w / 2)
  const midY = Math.floor(w.level.h / 2)
  let best = { x: Math.floor(w.level.spawn.x), y: Math.floor(w.level.spawn.y) }
  let bestD = Infinity
  for (let y = 1; y < w.level.h - 1; y++) {
    for (let x = 1; x < w.level.w - n; x++) {
      if (!openRow(w, x, y, n)) continue
      const d = Math.abs(x + Math.floor(n / 2) - midX) + Math.abs(y - midY)
      if (d < bestD) {
        bestD = d
        best = { x, y }
      }
    }
  }
  return best
}

/** A row of flammable crates ending in a hapless bystander; the near crate is
 * lit so fire spreads down the row and burns the NPC down. The player watches
 * from just north so the camera centres the blaze. */
const setupFire = (w: World): void => {
  const { x, y } = findStage(w, 7)
  for (let i = 1; i <= 4; i++) crate(w, x + i, y)
  const victim = spawnNpc(w, 'civilian', x + 5 + 0.5, y + 0.5)
  victim.flammable = true
  victim.ai = undefined
  victim.intent = { x: 0, y: 0 }

  const player = w.entities.find((e) => e.playerCtl)
  if (player) {
    const py = isSolidTile(w.level, x + 3, y - 1) ? y : y - 1
    player.pos = { x: x + 3 + 0.5, y: py + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
  }

  igniteCell(w, x + 1, y)
}

/** A still bystander at a cell centre — AI stripped so it stays put on stage. */
const bystander = (w: World, cx: number, cy: number): Entity => {
  const e = spawnNpc(w, 'civilian', cx + 0.5, cy + 0.5)
  e.ai = undefined
  e.intent = { x: 0, y: 0 }
  return e
}

/** Drop the player just north of the stage row so the camera frames it. */
const placePlayer = (w: World, x: number, y: number): void => {
  const player = w.entities.find((e) => e.playerCtl)
  if (!player) return
  const py = isSolidTile(w.level, x, y - 1) ? y : y - 1
  player.pos = { x: x + 0.5, y: py + 0.5 }
  player.prevPos = { x: player.pos.x, y: player.pos.y }
}

/** Two bystanders: one pre-frozen (ice-blue), one untouched twin. Hitting the
 * frozen one shatters it; the twin shrugs off the same blow. */
const setupFrost = (w: World): void => {
  const { x, y } = findStage(w, 5)
  const frozen = bystander(w, x + 1, y)
  freeze(w, frozen)
  bystander(w, x + 3, y)
  placePlayer(w, x + 2, y)
}

/** A puddle of wet bystanders in a row; zapping the near one arcs down the
 * whole connected cluster. */
const setupWetElectric = (w: World): void => {
  const { x, y } = findStage(w, 6)
  for (let i = 1; i <= 4; i++) wet(w, bystander(w, x + i, y))
  placePlayer(w, x + 2, y)
}

/** A loaded loadout (bat / pistol / molotovs) and flammable targets downrange:
 * equip the gun and fire it dry, then throw a molotov to set the crates ablaze. */
const setupInventory = (w: World): void => {
  const { x, y } = findStage(w, 8)
  const player = w.entities.find((e) => e.playerCtl)
  if (player?.playerCtl) {
    player.pos = { x: x + 1 + 0.5, y: y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0 // aim east, down the row into view
    player.playerCtl.inventory = [
      { itemId: 'bat', qty: WEAPONS.bat.durability! },
      { itemId: 'pistol', qty: 3 },
      { itemId: 'molotov', qty: 2 },
    ]
    player.playerCtl.activeSlot = 0
    if (player.combat) player.combat.weapon = 'bat'
  }
  crate(w, x + 4, y)
  crate(w, x + 5, y)
}

/** A broad loadout of the new item breadth (shotgun / freeze grenade /
 * chloroform / molotov / sledgehammer / adrenaline) with a bystander and crate
 * downrange to use them on. */
const setupItems = (w: World): void => {
  const { x, y } = findStage(w, 10)
  const player = w.entities.find((e) => e.playerCtl)
  if (player?.playerCtl) {
    player.pos = { x: x + 1 + 0.5, y: y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0 // aim east, down the row into view
    player.playerCtl.inventory = [
      { itemId: 'shotgun', qty: 6 },
      { itemId: 'freezeGrenade', qty: 2 },
      { itemId: 'chloroform', qty: 2 },
      { itemId: 'molotov', qty: 2 },
      { itemId: 'sledgehammer', qty: WEAPONS.sledgehammer.durability! },
      { itemId: 'adrenaline', qty: 1 },
    ]
    player.playerCtl.activeSlot = 0
    if (player.combat) player.combat.weapon = 'shotgun'
  }
  bystander(w, x + 4, y)
  crate(w, x + 7, y)
}

/** A civilian in front of two cops and a bouncer: shoot the civilian and the
 * cops (law) turn hostile and charge, while the unrelated bouncer stays calm. */
const setupRelationships = (w: World): void => {
  const { x, y } = findStage(w, 10)
  const player = w.entities.find((e) => e.playerCtl)
  if (player?.playerCtl) {
    player.pos = { x: x + 1 + 0.5, y: y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0 // aim east down the row
  }
  const victim = spawnNpc(w, 'civilian', x + 2 + 0.5, y + 0.5)
  victim.speed = 0 // stays put so the shot lands cleanly
  spawnNpc(w, 'cop', x + 4 + 0.5, y + 0.5)
  spawnNpc(w, 'cop', x + 5 + 0.5, y + 0.5)
  const bouncer = spawnNpc(w, 'bouncer', x + 7 + 0.5, y + 0.5)
  bouncer.speed = 0 // an unrelated bystander that should stay calm
}

/** The animation showcase: a stage that shows every moving part at once —
 * animated fire spreading through crates, a burning bystander throwing hit
 * sparks, a walking cast (thug / scientist / robot / civilian ambling across),
 * a pickup in the player's path for the sparkle, and staggered grenades that
 * boom on their own fuses so an explosion plays without any input. */
const setupShowcase = (w: World): void => {
  const { x, y } = findStage(w, 9)

  // Fire: a crate row lit at one end spreads down the row (animated flames).
  for (let i = 0; i < 3; i++) crate(w, x + i, y)
  igniteCell(w, x, y)

  // A flammable bystander in the fire's path — catches, burns, sparks.
  const victim = spawnNpc(w, 'civilian', x + 3 + 0.5, y + 0.5)
  victim.flammable = true
  victim.ai = undefined
  victim.intent = { x: 0, y: 0 }

  // Walking cast: peaceful (civ faction so they don't mob the player) with a
  // cross-stage waypoint so each ambles back and forth showing its walk cycle
  // and facings. A mix of the directional-sprite archetypes.
  const walker = (arch: string, ox: number, oy: number, wx: number): void => {
    const e = spawnNpc(w, arch, x + ox + 0.5, y + oy + 0.5)
    if (e.ai) {
      e.ai.mode = 'wander'
      e.ai.faction = 'civ'
      e.ai.home = { x: x + ox + 0.5, y: y + oy + 0.5 }
      e.ai.waypoint = { x: x + wx + 0.5, y: y + oy + 0.5 }
    }
  }
  walker('cop', 6, -2, 1)
  walker('thug', 7, 2, 1)
  walker('scientist', 6, 2, 2)
  walker('robot', 7, -1, 2)
  walker('civilian', 8, -2, 3)
  walker('gangster', 8, 2, 3)

  // World props (real sprites, not shapes): a barrel by the fire that catches,
  // plus an ATM and a vending machine as set dressing.
  const prop = (arch: string, ox: number, oy: number, flammable = false): void => {
    const e = makeEntity('interactable', arch, x + ox + 0.5, y + oy + 0.5, 0.4)
    if (flammable) {
      e.flammable = true
      e.health = { hp: 30, max: 30, iframes: 0 }
    }
    addEntity(w, e)
  }
  prop('barrel', 3, -1, true)
  prop('atm', 1, -2)
  prop('vending', 2, -2)

  // Player and pickup both sit on the guaranteed-open stage row so a short walk
  // left always reaches the gun (→ pickup sparkle) with the fire in frame.
  const player = w.entities.find((e) => e.playerCtl)
  if (player) {
    player.pos = { x: x + 6 + 0.5, y: y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    // Showcase only: tanky so the demo can wander through fire/booms and survive.
    if (player.health) player.health = { hp: 500, max: 500, iframes: 0 }
  }
  const gun = makeEntity('pickup', 'pickup.pistol', x + 4 + 0.5, y + 0.5, 0.3)
  gun.pickup = { itemId: 'pistol', qty: 1 }
  addEntity(w, gun)

  // Grenades on OPEN ground at the east end (not on a crate — a grenade spawned
  // touching a health entity detonates instantly). Staggered fuses boom at
  // ~2.5s / ~5s, well clear of the player so they dazzle without hurting.
  for (const ttl of [70, 140, 210]) {
    const g = makeEntity('projectile', 'grenade', x + 8 + 0.5, y + 0.5, 0.15)
    g.projectile = { ownerId: player?.id ?? 0, damage: 0, ttl, explode: { radius: 1.0, damage: 8 } }
    addEntity(w, g)
  }
}

// ── Scripted-run stages ────────────────────────────────────────────────────
// These back the deterministic e2e videos (see e2e/ + src/input/scripted.ts).
// applyScenario runs after populateWorld, so each first clears the random crowd
// to a blank plaza, then hand-places exactly the beats its script drives.

const LANE_Y = 11 // open plaza lane below spawn — the camera frames it without clamping

const clearStage = (w: World): void => {
  // Mod-pickups (populate.ts) are the LAST entities stocked before the player is
  // spawned, so they shift the player id + `nextId` up by their count. A scripted
  // plaza wipes all populate entities anyway, but the AI think-stagger keys off
  // `id % 5`, so that leftover shift would desync the tuned demo choreography.
  // Roll the id space back by the mod-pickups we're removing → the scenario's ids
  // are exactly what they'd be without the feature (a no-op when none spawned).
  const modShift = w.entities.filter((e) => e.archetype.startsWith('mod.')).length
  const players = w.entities.filter((e) => !!e.playerCtl)
  w.entities = players
  w.byId.clear()
  w.nextId -= modShift
  for (const e of players) {
    e.id -= modShift
    w.byId.set(e.id, e)
  }
}

const stageThug = (w: World, x: number, y: number): Entity => {
  const t = spawnNpc(w, 'thug', x, y)
  t.health = { hp: 24, max: 24, iframes: 0 }
  t.ai!.guard = true
  return t
}

const stageWanderer = (w: World, x: number, y: number): void => {
  const npc = spawnNpc(w, 'civilian', x, y)
  npc.ai!.mode = 'wander'
  npc.ai!.waypoint = { x: x + 1.5, y: y + 1 }
}

const stageDoor = (w: World, x: number, y: number, locked: boolean): void => {
  const e = makeEntity('door', 'door', x, y, 0.5)
  e.door = { open: false, locked, lockLevel: locked ? 1 : 0 }
  e.interact = { verb: locked ? 'use' : 'open', range: 1.3 }
  addEntity(w, e)
}

// move -> meet NPCs + grab a pickup -> open a door -> win a grenade+pistol battle
const stageDemo = (w: World): void => {
  clearStage(w)
  const medkit = makeEntity('pickup', 'pickup.medkit', 5.5, LANE_Y, 0.3)
  medkit.pickup = { itemId: 'medkit', qty: 1 }
  addEntity(w, medkit)
  stageWanderer(w, 8, LANE_Y - 0.6)
  stageWanderer(w, 9, LANE_Y + 1)
  const door = makeEntity('door', 'door', 12, LANE_Y, 0.5)
  door.door = { open: false, locked: false, lockLevel: 0 }
  door.interact = { verb: 'open', range: 1.3 }
  addEntity(w, door)
  stageThug(w, 19, LANE_Y)
  stageThug(w, 20, LANE_Y)
}

// an unlocked door to swing open, then a locked one to pick and walk through
const stageDoors = (w: World): void => {
  clearStage(w)
  stageDoor(w, 6, LANE_Y, false)
  stageDoor(w, 11, LANE_Y, true)
}

// a firing lane: three frozen targets for a clean pistol gallery
const stageShooting = (w: World): void => {
  clearStage(w)
  for (const x of [12, 15, 18]) stageThug(w, x, LANE_Y).speed = 0
}

// a real steal mission: grab the briefcase (objective done) then reach the exit
const stageMission = (w: World): void => {
  clearStage(w)
  const brief = makeEntity('pickup', 'pickup.briefcase', 10, LANE_Y, 0.3)
  brief.pickup = { itemId: 'briefcase', qty: 1 }
  addEntity(w, brief)
  w.level.exit = { x: 15, y: LANE_Y }
  w.level.tiles[LANE_Y * w.level.w + 15] = Tile.Exit
  w.mission = {
    template: 'steal',
    targetEntityId: brief.id,
    targetBuilding: -1,
    complete: false,
    exitUnlocked: false,
    description: 'Steal the briefcase, then reach the exit',
  }
}

/** Two hostile gangsters — one at full health that charges, one badly wounded
 * that flees — plus a calm cop downrange that will investigate a noise. */
const setupAiGoals = (w: World): void => {
  const { x, y } = findStage(w, 14)
  const player = w.entities.find((e) => e.playerCtl)
  if (player?.playerCtl) {
    player.pos = { x: x + 1 + 0.5, y: y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0
  }
  spawnNpc(w, 'gangster', x + 3 + 0.5, y + 0.5) // full health -> charges
  const wounded = spawnNpc(w, 'gangster', x + 4 + 0.5, y + 0.5)
  wounded.health!.hp = 5 // < a third of max -> should flee, not fight
  spawnNpc(w, 'cop', x + 10 + 0.5, y + 0.5) // neutral bystander for the noise test
}

/** A vending machine to use, a crate to break for loot, and a row of explosive
 * barrels with a bystander to chain-detonate by gunfire. */
const setupObjects = (w: World): void => {
  const { x, y } = findStage(w, 14)
  const player = w.entities.find((e) => e.playerCtl)
  if (player?.playerCtl) {
    player.pos = { x: x + 1 + 0.5, y: y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0 // aim east down the row
  }
  spawnObject(w, 'vending', x, y) // adjacent west — E-interact to dispense
  spawnObject(w, 'crate', x + 3, y) // shoot to break for loot
  spawnObject(w, 'barrel', x + 6, y)
  spawnObject(w, 'barrel', x + 7, y)
  spawnObject(w, 'barrel', x + 8, y)
  const bystander = spawnNpc(w, 'civilian', x + 9 + 0.5, y + 0.5)
  bystander.speed = 0
}

export const applyScenario = (w: World, name: string): void => {
  if (name === 'objects') setupObjects(w)
  if (name === 'fire') setupFire(w)
  if (name === 'frost') setupFrost(w)
  if (name === 'wet-electric') setupWetElectric(w)
  if (name === 'inventory') setupInventory(w)
  if (name === 'items') setupItems(w)
  if (name === 'relationships') setupRelationships(w)
  if (name === 'showcase') setupShowcase(w)
  if (name === 'demo') stageDemo(w)
  if (name === 'doors') stageDoors(w)
  if (name === 'shooting') stageShooting(w)
  if (name === 'mission') stageMission(w)
  if (name === 'ai-goals') setupAiGoals(w)
}
