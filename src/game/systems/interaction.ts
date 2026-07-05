import { CONSUMABLES, WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import type { World } from '../world'

/** v1: pickups are collected by walking over them. Doors/NPC verbs arrive in M3. */
export const interactionSystem = (w: World): void => {
  for (const p of w.entities) {
    if (!p.playerCtl || p.dead || p.playerCtl.downed) continue
    for (const e of w.entities) {
      if (!e.pickup || e.dead) continue
      const dx = e.pos.x - p.pos.x
      const dy = e.pos.y - p.pos.y
      const rr = e.radius + p.radius
      if (dx * dx + dy * dy >= rr * rr) continue
      if (collect(p, e)) {
        e.dead = true
        w.events.push({ type: 'pickup', entityId: e.id, byId: p.id, itemId: e.pickup.itemId })
      }
    }
  }
}

const collect = (player: Entity, item: Entity): boolean => {
  const { itemId, qty } = item.pickup!
  const ctl = player.playerCtl!
  if (itemId === 'cash') {
    ctl.cash += qty
    return true
  }
  if (WEAPONS[itemId]) {
    // Swap held weapon; drop nothing for now (old weapon vanishes — M6 can drop it).
    if (player.combat) player.combat.weapon = itemId
    return true
  }
  if (CONSUMABLES[itemId]) {
    // Auto-heal if hurt, else stash (max 4 stacks).
    const heal = CONSUMABLES[itemId].heal ?? 0
    if (player.health && player.health.hp < player.health.max) {
      player.health.hp = Math.min(player.health.max, player.health.hp + heal)
      return true
    }
    const stack = ctl.inventory.find((s) => s.itemId === itemId)
    if (stack) {
      stack.qty += qty
      return true
    }
    if (ctl.inventory.length < 4) {
      ctl.inventory.push({ itemId, qty })
      return true
    }
    return false // inventory full and not hurt — leave it on the ground
  }
  return false
}
