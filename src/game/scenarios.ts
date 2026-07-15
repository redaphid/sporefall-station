// Deterministic demo setups, selected by `?scenario=`. Kept out of the sim
// proper: a scenario just seeds entities into a fresh world before play starts.

import { WEAPONS } from './data/items'
import { makeEntity, type Entity } from './entity'
import { isSolidTile } from './levelgen/level'
import { spawnNpc } from './populate'
import { igniteCell } from './systems/fire'
import { freeze, wet } from './systems/interactions'
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

export const applyScenario = (w: World, name: string): void => {
  if (name === 'fire') setupFire(w)
  if (name === 'frost') setupFrost(w)
  if (name === 'wet-electric') setupWetElectric(w)
  if (name === 'inventory') setupInventory(w)
  if (name === 'items') setupItems(w)
  if (name === 'relationships') setupRelationships(w)
}
