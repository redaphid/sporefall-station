// Deterministic demo setups, selected by `?scenario=`. Kept out of the sim
// proper: a scenario just seeds entities into a fresh world before play starts.

import { WEAPONS } from './data/items'
import { makeEntity, type Entity } from './entity'
import { isSolidTile, Tile } from './levelgen/level'
import { assignPatrol, spawnNpc } from './populate'
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
    player.loadout!.inventory = [
      { itemId: 'bat', qty: WEAPONS.bat.durability! },
      { itemId: 'pistol', qty: 3 },
      { itemId: 'molotov', qty: 2 },
    ]
    player.loadout!.activeSlot = 0
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
    player.loadout!.inventory = [
      { itemId: 'shotgun', qty: 6 },
      { itemId: 'freezeGrenade', qty: 2 },
      { itemId: 'chloroform', qty: 2 },
      { itemId: 'molotov', qty: 2 },
      { itemId: 'sledgehammer', qty: WEAPONS.sledgehammer.durability! },
      { itemId: 'adrenaline', qty: 1 },
    ]
    player.loadout!.activeSlot = 0
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

/**
 * The id a wiped scripted stage renumbers its players from.
 *
 * This is CHOREOGRAPHY, not an arbitrary starting number. Several AI rhythms are
 * phased by entity id — the think stagger is `id % 5` (systems/ai.ts:107),
 * repaths are `id % REPATH_STAGGER`, strafe direction is `id % 2` — so the tick
 * on which each staged thug thinks, routes and sidesteps is a function of the
 * ids the stage hands out. The scripted demos were tuned with the player landing
 * on an id ≡ 2 (mod 5), so the stage starts there and every beat keeps the
 * timing it was recorded at. Change this and the demos re-phase:
 * src/input/scripted.test.ts is the guard that says so.
 */
const STAGE_ID_BASE = 2

const clearStage = (w: World): void => {
  // Scripted stages are hand-choreographed around faction stances (ambient
  // civilians amble, only the gang thugs charge), so opt out of the global
  // "everyone's an enemy" default — hostility here comes from disposition alone.
  w.hostile = false
  // The player is spawned AFTER populateWorld, so its id — and every stage id
  // after it — is offset by however many entities populate happened to make.
  // That matters because the AI think-stagger keys off `id % 5`, so a change in
  // the population (a new mod-pickup feature, a different furniture count) would
  // silently re-phase a hand-tuned demo's choreography.
  //
  // This used to be patched one feature at a time, by subtracting exactly the
  // mod-pickups. Renumbering the survivors from the bottom of the id space
  // instead makes a scripted stage INDEPENDENT of populate altogether: the
  // plaza is wiped to the players anyway, so they may as well be entity 1..n,
  // and every stage entity placed after them gets the same id on every run
  // regardless of what levelgen and populate did upstream.
  const players = w.entities.filter((e) => !!e.playerCtl)
  w.entities = players
  w.byId.clear()
  w.nextId = STAGE_ID_BASE
  for (const e of players) {
    e.id = w.nextId++
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
    description: 'Extract the specimen canister, then reach the Launch Bay',
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

/** A ring of ARMED, HOSTILE NPCs closing on the player, each with a visibly
 * different weapon (bat / knife / pistol / shotgun / machinegun / sledgehammer /
 * freeze ray / flamethrower). Leaves the world's `hostile` default ON so every
 * ring member engages regardless of faction — the "make them all enemies" demo.
 * The player is made tanky so the swarm converges and fires without ending the
 * clip early. A blank clearing is carved so LOS/movement are unobstructed. */
const setupNpcCombat = (w: World): void => {
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  const R = 8 // half-size of the carved clearing
  for (let y = cy - R; y <= cy + R; y++) {
    for (let x = cx - R; x <= cx + R; x++) {
      if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) w.level.tiles[y * w.level.w + x] = Tile.Floor
    }
  }
  // Blank the randomly-populated crowd/loot so only the staged fight is on screen.
  const players = w.entities.filter((e) => !!e.playerCtl)
  w.entities = players
  w.byId.clear()
  for (const e of players) w.byId.set(e.id, e)

  const player = players[0]
  if (player) {
    player.pos = { x: cx + 0.5, y: cy + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    if (player.health) player.health = { hp: 100000, max: 100000, iframes: 0 } // survive the swarm for the whole clip
  }

  const ring: [string, string][] = [
    ['thug', 'bat'],
    ['thug', 'knife'],
    ['gangster', 'pistol'],
    ['gangster', 'shotgun'],
    ['gangster', 'machinegun'],
    ['thug', 'sledgehammer'],
    ['gangster', 'tranquilizer'],
    ['gangster', 'flamethrower'],
  ]
  const radius = 6
  for (let i = 0; i < ring.length; i++) {
    const [arch, weapon] = ring[i]
    const a = (i / ring.length) * Math.PI * 2
    const nx = cx + 0.5 + Math.cos(a) * radius
    const ny = cy + 0.5 + Math.sin(a) * radius
    const npc = spawnNpc(w, arch, nx, ny)
    npc.combat!.weapon = weapon
    npc.ai!.sightRange = 14 // see across the clearing so they all commit at once
  }
}

/** The pluggable-behavior showcase (feat/npc-ai-ecs): four brains on one stage.
 * A skittish civilian (attacked by the scripted player) flees and runs to the
 * patrolling cop to report the crime; a hunter gangster chases the player, loses
 * them behind an L-wall, walks to last-known and sweeps; a scavenger works a
 * corner of pickups; the cop walks its beat until the alert pulls it off.
 * Peaceful world — every hostility on stage comes from behaviors + disposition. */
const setupNpcAi = (w: World): void => {
  const cx = 32
  const cy = 32
  // Blank clearing: open floor, no random crowd/loot on stage. Wider to the
  // west so the whole cast stays inside the player-following camera at zoom 1.
  for (let y = cy - 13; y <= cy + 13; y++) {
    for (let x = cx - 16; x <= cx + 13; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
  const players = w.entities.filter((e) => !!e.playerCtl)
  w.entities = players
  w.byId.clear()
  for (const e of players) w.byId.set(e.id, e)
  w.hostile = false

  // The L-wall hide pocket: vertical x=23 rows 26..31, horizontal row 26 x 20..23.
  const solidify = (x: number, y: number): void => {
    w.level.tiles[y * w.level.w + x] = Tile.Wall
    w.level.solid[y * w.level.w + x] = 1
  }
  for (let y = 26; y <= 31; y++) solidify(23, y)
  for (let x = 20; x <= 23; x++) solidify(x, 26)

  const player = players[0]
  if (player) {
    player.pos = { x: cx - 3.5, y: cy + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0 // the skittish civilian stands just east
    if (player.health) player.health = { hp: 500, max: 500, iframes: 0 } // survive the whole clip
  }

  // Skittish: the victim-to-be, in fists' reach east of the player. Holds its
  // spot (guard) so the scripted punch lands regardless of wander dice.
  spawnNpc(w, 'civilian', cx - 2.3, cy + 0.5).ai!.guard = true

  // Hunter: sees far, holds a grudge, carries a bat (a chase, not a shootout).
  const hunter = spawnNpc(w, 'gangster', cx + 8.5, cy + 0.5)
  hunter.combat!.weapon = 'bat'
  hunter.ai!.sightRange = 14
  if (player) hunter.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }

  // Patrol: the only cop on stage — also the guard the civilian will run to.
  // The beat stays >10 tiles from the victim (never a crime witness) yet inside
  // the fleeing civilian's 14-tile alert range, north where the camera ends up.
  const cop = spawnNpc(w, 'cop', cx - 5.5, cy - 10.5)
  assignPatrol(cop, [
    { x: cx - 5.5, y: cy - 10.5 },
    { x: cx - 1.5, y: cy - 10.5 },
    { x: cx - 5.5, y: cy - 12.5 },
  ])

  // Scavenger: a gleaner and its corner of loose loot, west of the hide pocket
  // so its whole fetch-and-stash routine plays on camera.
  const scav = spawnNpc(w, 'civilian', cx - 14.5, cy - 2.5)
  scav.ai!.behavior = 'scavenger'
  const drop = (itemId: string, x: number, y: number): void => {
    const e = makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3)
    e.pickup = { itemId, qty: 1 }
    addEntity(w, e)
  }
  drop('bandage', cx - 15.5, cy - 3.5)
  drop('cash', cx - 14.5, cy - 0.5)
  drop('medkit', cx - 15.5, cy - 6.5)
}

/** The deliberate-AI showcase (feat/npc-ai-deliberate): three tactical moments
 * on one stage, all driven by the shipped brains + router, none scripted.
 *  - A hunter sealed in a U-pocket ROUTES out and around to its remembered
 *    prey (no wall-grinding).
 *  - A 3-man squad east of a closed door: the lead holds, the pack stacks the
 *    frame, they breach together and sweep through at the player.
 *  - A dormant lurker in a side pocket the player later strolls past — the
 *    proximity trip and the pounce.
 * Player is tanky and (per the script) passive; every beat is the AI's own. */
const setupNpcDeliberate = (w: World): void => {
  const cx = 32
  const cy = 32
  // Blank clearing, sealed from the natural map so the walls genuinely wall.
  for (let y = cy - 14; y <= cy + 14; y++) {
    for (let x = cx - 14; x <= cx + 16; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Floor
      w.level.solid[y * w.level.w + x] = 0
    }
  }
  const players = w.entities.filter((e) => !!e.playerCtl)
  w.entities = players
  w.byId.clear()
  for (const e of players) w.byId.set(e.id, e)
  w.hostile = true // gang cast — everyone on stage engages the player on sight

  const solidify = (x: number, y: number): void => {
    w.level.tiles[y * w.level.w + x] = Tile.Wall
    w.level.solid[y * w.level.w + x] = 1
  }
  // Perimeter ring: the stage's walls must genuinely wall — no routing out
  // through whatever the natural map happens to offer beyond the clearing.
  for (let x = cx - 14; x <= cx + 16; x++) {
    solidify(x, cy - 14)
    solidify(x, cy + 14)
  }
  for (let y = cy - 14; y <= cy + 14; y++) {
    solidify(cx - 14, y)
    solidify(cx + 16, y)
  }

  const player = players[0]
  if (player) {
    player.pos = { x: cx - 6 + 0.5, y: cy + 0.5 } // (26.5, 32.5)
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = 0
    // Five melee attackers work the passive player over for the whole clip —
    // tank it (as npc-combat does) so the showcase never ends on a down screen.
    if (player.health) player.health = { hp: 100000, max: 100000, iframes: 0 }
  }

  // ── Moment 1: the U-pocket hunter (routes around, never grinds) ──────────
  // U open to the NORTH at (21..27, 25..29); hunter parked inside.
  for (let x = cx - 11; x <= cx - 5; x++) solidify(x, cy - 3) // south face y=29
  for (let y = cy - 7; y <= cy - 3; y++) {
    solidify(cx - 11, y) // west face x=21
    solidify(cx - 5, y) // east face x=27
  }
  const hunter = spawnNpc(w, 'gangster', cx - 8 + 0.5, cy - 5 + 0.5) // (24.5, 27.5)
  hunter.combat!.weapon = 'bat'
  hunter.ai!.sightRange = 14
  if (player) {
    hunter.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
    hunter.ai!.mode = 'aggro'
    hunter.ai!.targetId = player.id
    hunter.ai!.lastKnownTargetPos = { x: player.pos.x, y: player.pos.y }
  }

  // ── Moment 2: the squad door-stack east of the player ────────────────────
  // Vertical wall at x=38 with one doorway at (38,32) holding a closed door.
  for (let y = cy - 14; y <= cy + 14; y++) if (y !== cy) solidify(cx + 6, y)
  const door = makeEntity('door', 'door', cx + 6 + 0.5, cy + 0.5, 0.5)
  door.door = { open: false, locked: false, lockLevel: 0 }
  door.interact = { verb: 'open', range: 1.3 }
  addEntity(w, door)
  const squaddie = (x: number, y: number, role: 'lead' | 'flank' | 'rear'): Entity => {
    const e = spawnNpc(w, 'thug', x, y)
    e.combat!.weapon = 'bat'
    e.ai!.behavior = 'squad'
    e.ai!.squad = { id: 1, role }
    e.ai!.sightRange = 12
    return e
  }
  const lead = squaddie(cx + 11 + 0.5, cy + 0.5, 'lead')
  squaddie(cx + 13 + 0.5, cy - 3 + 0.5, 'flank')
  squaddie(cx + 13 + 0.5, cy + 3 + 0.5, 'rear')
  if (player) {
    lead.ai!.rel = { [player.id]: { hate: 40, code: 'Hostile' } }
    lead.ai!.mode = 'aggro'
    lead.ai!.targetId = player.id
    lead.ai!.lastKnownTargetPos = { x: player.pos.x, y: player.pos.y }
  }

  // ── Moment 3: the lurker pocket south of the player's stroll ─────────────
  // 3-wide pocket at (25..27, 37..39), mouth open at (26,36); lurker parked
  // against its back wall. The script walks the player past the mouth late in
  // the clip — the proximity trip springs it.
  for (let x = cx - 8; x <= cx - 4; x++) {
    solidify(x, cy + 4) // top face y=36…
    solidify(x, cy + 8) // bottom face y=40
  }
  w.level.tiles[(cy + 4) * w.level.w + (cx - 6)] = Tile.Floor // …with its mouth at (26,36)
  w.level.solid[(cy + 4) * w.level.w + (cx - 6)] = 0
  for (let y = cy + 4; y <= cy + 8; y++) {
    solidify(cx - 8, y)
    solidify(cx - 4, y)
  }
  const lurker = spawnNpc(w, 'lurker', cx - 6 + 0.5, cy + 7 + 0.5) // (26.5, 39.5)
  lurker.ai!.guard = true
}

// Hero-art showcase (art-cn1 review): a blank plaza with the player on the lane
// and a small thug pair far east. The `artcompare` script walks a full compass
// circle in place (showing every drawn facing), then marches east and swings —
// so a recording captures idle + all directions + combat in one deterministic
// run, directly comparable across art/engine-resolution builds.
const stageArtCompare = (w: World): void => {
  clearStage(w)
  const player = w.entities.find((e) => e.playerCtl)
  if (player?.playerCtl) {
    player.pos = { x: 8 + 0.5, y: LANE_Y + 0.5 }
    player.prevPos = { x: player.pos.x, y: player.pos.y }
    player.facing = Math.PI / 2 // idle facing south (toward camera)
    player.loadout!.inventory = [{ itemId: 'bat', qty: 1 }]
    player.loadout!.activeSlot = 0
    if (player.combat) player.combat.weapon = 'bat'
  }
  stageThug(w, 18, LANE_Y)
  stageThug(w, 19, LANE_Y)
}

export const applyScenario = (w: World, name: string): void => {
  if (name === 'artcompare') stageArtCompare(w)
  if (name === 'npc-combat') setupNpcCombat(w)
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
  if (name === 'npc-ai') setupNpcAi(w)
  if (name === 'npc-deliberate') setupNpcDeliberate(w)
}
