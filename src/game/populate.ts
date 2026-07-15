import { NPCS } from './data/npcs'
import { makeEntity, type Entity } from './entity'
import { Tile, type Building } from './levelgen/level'
import type { Rng } from './rng'
import { addEntity, type World } from './world'

/** Host-only: fill a freshly generated level with NPCs and loot. */
export const populateWorld = (w: World): void => {
  const rng = w.rng.fork('populate')
  for (let i = 0; i < w.level.buildings.length; i++) {
    populateBuilding(w, rng, w.level.buildings[i])
  }
  spawnStreetLife(w, rng)
  sprinkleLoot(w, rng)
}

const ROLE_SPAWNS: Record<Building['role'], { archetype: string; count: [number, number] }[]> = {
  shop: [
    { archetype: 'shopkeeper', count: [1, 1] },
    { archetype: 'civilian', count: [0, 1] },
  ],
  apartment: [{ archetype: 'civilian', count: [1, 3] }],
  office: [
    { archetype: 'civilian', count: [1, 2] },
    { archetype: 'cop', count: [0, 1] },
  ],
  warehouse: [{ archetype: 'thug', count: [2, 3] }],
  clinic: [{ archetype: 'civilian', count: [1, 2] }],
}

const populateBuilding = (w: World, rng: Rng, building: Building): void => {
  const specs = [...ROLE_SPAWNS[building.role]]
  // Difficulty ramp: deeper floors gang up
  if (w.floor >= 2 && building.role === 'warehouse') specs.push({ archetype: 'gangster', count: [1, 2] })
  if (w.floor >= 3 && building.role === 'office') specs.push({ archetype: 'gangster', count: [0, 1] })
  if (w.floor >= 2 && building.role === 'shop') specs.push({ archetype: 'bouncer', count: [1, 1] })
  for (const spec of specs) {
    const n = rng.int(spec.count[0], spec.count[1])
    for (let i = 0; i < n; i++) {
      const spot = randomFloorInBuilding(w, rng, building)
      if (spot) spawnNpc(w, spec.archetype, spot.x, spot.y)
    }
  }
  if (building.role === 'shop') stockShop(w, rng, building)
}

// Loot is tiered by depth: floor 1 stays basic (bat/knife/bandages), then the
// element arsenal folds in so the frost/fire/shock/sleep/poison systems come
// online as you descend. Shops always stock element gear (see stockShop), so
// the interaction combos stay reachable regardless of how the dice fall.
const BASIC_LOOT = ['bat', 'knife', 'bandage', 'bandage', 'medkit', 'cash']
const ELEMENT_THROWABLES = ['molotov', 'grenade', 'freezeGrenade', 'chloroform', 'banana', 'gasGrenade']
const ELEMENT_WEAPONS = ['freezeRay', 'tranquilizer', 'sledgehammer', 'flamethrower', 'stunGun']
const GUNS = ['shotgun', 'machinegun']

/** The floor's random-loot table: basics everywhere, element throwables and a
 * couple of element weapons from floor 2, the full arsenal from floor 3 on. */
const lootTable = (floor: number): string[] => {
  const table = [...BASIC_LOOT]
  if (floor >= 2) table.push(...ELEMENT_THROWABLES, 'freezeRay', 'sledgehammer')
  if (floor >= 3) table.push(...ELEMENT_WEAPONS, ...GUNS, ...ELEMENT_THROWABLES)
  return table
}

/** Element gear a shop can carry — the reliable place to gear up on any floor,
 * so freeze-shatter / fire-spread combos are always within reach. */
const SHOP_STOCK = [
  'freezeRay', 'tranquilizer', 'sledgehammer', 'flamethrower', 'stunGun', 'shotgun',
  'molotov', 'freezeGrenade', 'chloroform', 'gasGrenade', 'banana', 'grenade', 'medkit',
]

const dropPickup = (w: World, itemId: string, x: number, y: number, qty: number): void => {
  const e = makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3)
  e.pickup = { itemId, qty }
  addEntity(w, e)
}

/** Lay out a shop's wares: a handful of element weapons/throwables on the floor
 * for the taking, so every run has somewhere to buy into the element systems. */
const stockShop = (w: World, rng: Rng, building: Building): void => {
  const n = rng.int(2, 4)
  for (let i = 0; i < n; i++) {
    const spot = randomFloorInBuilding(w, rng, building)
    if (spot) dropPickup(w, rng.pick(SHOP_STOCK), spot.x, spot.y, 1)
  }
}

const spawnStreetLife = (w: World, rng: Rng): void => {
  const wanderers = rng.int(4, 7)
  for (let i = 0; i < wanderers; i++) {
    const spot = randomTileOfType(w, rng, Tile.Sidewalk) ?? randomTileOfType(w, rng, Tile.Street)
    if (spot) spawnNpc(w, 'civilian', spot.x, spot.y)
  }
  const copPairs = 1 + Math.floor(w.floor / 3)
  for (let i = 0; i < copPairs; i++) {
    const spot = randomTileOfType(w, rng, Tile.Street)
    if (spot) {
      spawnNpc(w, 'cop', spot.x, spot.y)
      spawnNpc(w, 'cop', spot.x + 0.8, spot.y)
    }
  }
}

const sprinkleLoot = (w: World, rng: Rng): void => {
  const table = lootTable(w.floor)
  const n = rng.int(6, 10)
  for (let i = 0; i < n; i++) {
    const building = rng.pick(w.level.buildings)
    const spot = building ? randomFloorInBuilding(w, rng, building) : null
    if (!spot) continue
    const itemId = rng.pick(table)
    dropPickup(w, itemId, spot.x, spot.y, itemId === 'cash' ? rng.int(10, 40) : 1)
  }
}

export const spawnNpc = (w: World, archetype: string, x: number, y: number): Entity => {
  const def = NPCS[archetype]
  const e = makeEntity('npc', archetype, x, y)
  e.speed = def.speed
  // Difficulty ramp: +15% hp per floor past the first
  const hp = Math.round(def.hp * (1 + 0.15 * (w.floor - 1)))
  e.health = { hp, max: hp, iframes: 0 }
  e.combat = { weapon: def.weapon, cooldown: 0 }
  e.status = { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 }
  e.ai = {
    mode: 'idle',
    faction: def.faction,
    home: { x, y },
    thinkAt: 0,
    sightRange: def.sightRange,
  }
  return addEntity(w, e)
}

const randomFloorInBuilding = (
  w: World,
  rng: Rng,
  building: Building,
): { x: number; y: number } | null => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const tx = rng.int(building.rect.x + 1, building.rect.x + building.rect.w - 2)
    const ty = rng.int(building.rect.y + 1, building.rect.y + building.rect.h - 2)
    if (w.level.tiles[ty * w.level.w + tx] === Tile.Floor) return { x: tx + 0.5, y: ty + 0.5 }
  }
  return null
}

const randomTileOfType = (w: World, rng: Rng, tile: number): { x: number; y: number } | null => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tx = rng.int(1, w.level.w - 2)
    const ty = rng.int(1, w.level.h - 2)
    if (w.level.tiles[ty * w.level.w + tx] === tile) return { x: tx + 0.5, y: ty + 0.5 }
  }
  return null
}
