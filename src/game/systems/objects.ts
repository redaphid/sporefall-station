// Interactive & destructible objects. A world object is an `interactable` entity
// whose behavior comes from the OBJECTS data table: it takes damage like anything
// with hp, and when destroyed it spills loot, blasts, and/or ignites per its data
// — so an explosive barrel chains through the shared explosion/fire systems. No
// system special-cases an object id. Re-expressed from ObjectReal, not ported.

import { OBJECTS } from '../data/objects'
import { makeEntity, type Entity } from '../entity'
import { addEntity, type World } from '../world'
import { igniteCell } from './fire'
import { applyAreaEffect } from './itemEffects'

const INTERACT_RANGE = 1.3

export const isObject = (e: Entity): boolean => OBJECTS[e.archetype] !== undefined

/** Damage below an object's threshold bounces off (barrels need a solid hit). */
export const resistsDamage = (e: Entity, amount: number): boolean => {
  const t = OBJECTS[e.archetype]?.damageThreshold
  return t !== undefined && amount < t
}

/** Spawn a world object with hp and (if usable) an interact verb from its data. */
export const spawnObject = (w: World, archetype: string, x: number, y: number): Entity => {
  const def = OBJECTS[archetype]
  const e = makeEntity('interactable', archetype, x + 0.5, y + 0.5, 0.4)
  if (def) {
    e.health = { hp: def.hp, max: def.hp, iframes: 0 }
    if (def.flammable) e.flammable = true
    if (def.use || def.hackable) e.interact = { verb: 'use', range: INTERACT_RANGE }
  }
  return addEntity(w, e)
}

const spawnPickup = (w: World, itemId: string, x: number, y: number, qty: number): void => {
  const e = makeEntity('pickup', `pickup.${itemId}`, x, y, 0.3)
  e.pickup = { itemId, qty }
  addEntity(w, e)
}

/** Destroy an object: mark it dead FIRST (so its own blast can't re-hit it),
 * then spill loot, ignite, and blast per its data. The blast damages nearby
 * entities through applyDamage, so adjacent barrels chain-detonate. */
export const destroyObject = (w: World, e: Entity, byId: number): void => {
  const def = OBJECTS[e.archetype]
  e.dead = true
  w.events.push({ type: 'death', x: e.pos.x, y: e.pos.y, entityId: e.id })
  if (!def) return
  if (def.loot) {
    const itemId = w.rng.pick(def.loot)
    spawnPickup(w, itemId, e.pos.x, e.pos.y, itemId === 'cash' ? w.rng.int(10, 40) : 1)
  }
  if (def.ignite) igniteCell(w, Math.floor(e.pos.x), Math.floor(e.pos.y))
  if (def.explode) applyAreaEffect(w, e.pos.x, e.pos.y, { kind: 'explode', radius: def.explode.radius, damage: def.explode.damage }, byId)
}

/** E-interact use: dispense cash or an item once. Returns whether it fired. */
export const useObject = (w: World, agent: Entity, e: Entity): boolean => {
  const def = OBJECTS[e.archetype]
  if (!def?.use || e.used) return false
  e.used = true
  if (def.use.gives === 'cash') {
    if (agent.playerCtl) agent.playerCtl.cash += def.use.amount ?? 25
  } else {
    spawnPickup(w, def.use.gives, e.pos.x, e.pos.y, def.use.amount ?? 1)
  }
  w.events.push({ type: 'use', entityId: e.id, byId: agent.id })
  return true
}
