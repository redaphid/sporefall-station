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
  const LOOT = ['bat', 'knife', 'bandage', 'bandage', 'medkit', 'cash']
  const n = rng.int(6, 10)
  for (let i = 0; i < n; i++) {
    const building = rng.pick(w.level.buildings)
    const spot = building ? randomFloorInBuilding(w, rng, building) : null
    if (!spot) continue
    const itemId = rng.pick(LOOT)
    const e = makeEntity('pickup', `pickup.${itemId}`, spot.x, spot.y, 0.3)
    e.pickup = { itemId, qty: itemId === 'cash' ? rng.int(10, 40) : 1 }
    addEntity(w, e)
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
