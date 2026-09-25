// The one place a declarative item effect turns into sim changes. Throwables,
// grenades and AoE items all describe WHAT happens (an AreaEffect) and let this
// resolve it against the world — so the item table stays pure data and no system
// special-cases an item id.

import type { AreaEffect } from '../data/items'
import type { EntityId } from '../types'
import type { World } from '../world'
import { applyDamage } from './combat'
import { igniteCell } from './fire'
import { applyStatus } from './statusFx'
import { vlen } from '../simMath'

const within = (ax: number, ay: number, bx: number, by: number, r: number): boolean =>
  vlen(ax - bx, ay - by) <= r

/** Resolve an area effect at a landing point: ignite the tile, blast a radius,
 * or wash a status over the actors standing in it. */
export const applyAreaEffect = (w: World, x: number, y: number, effect: AreaEffect, ownerId: EntityId): void => {
  if (effect.kind === 'fire') {
    igniteCell(w, Math.floor(x), Math.floor(y))
    return
  }
  if (effect.kind === 'explode') {
    w.events.push({ type: 'explosion', x, y, radius: effect.radius })
    for (const e of w.entities) {
      if (e.dead || !e.health) continue
      if (within(e.pos.x, e.pos.y, x, y, effect.radius + e.radius)) applyDamage(w, e, effect.damage, x, y, 10, ownerId)
    }
    return
  }
  for (const e of w.entities) {
    if (e.dead || !e.health) continue
    if (within(e.pos.x, e.pos.y, x, y, effect.radius + e.radius)) applyStatus(w, e, effect.status, effect.ticks)
  }
}
