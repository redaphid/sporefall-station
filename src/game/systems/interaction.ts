import { CONSUMABLES, WEAPONS } from '../data/items'
import type { Entity } from '../entity'
import type { InputCmd } from '../types'
import { type World } from '../world'

const INTERACT_RANGE = 1.3
const LOCKPICK_TICKS = 45 // 1.5s channel
const REVIVE_TICKS = 90 // 3s of teammate proximity
const CRIME_TICKS = 15 * 30

export const interactionSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  for (const p of w.entities) {
    if (!p.playerCtl || p.dead) continue
    if (p.playerCtl.downed) {
      bleedAndRevive(w, p)
      continue
    }
    autoPickup(w, p)
    runChannel(w, p)
    const cmd = inputs.get(p.playerCtl.playerId)
    if (cmd?.interact) handleInteract(w, p)
  }
}

const autoPickup = (w: World, p: Entity): void => {
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

const handleInteract = (w: World, p: Entity): void => {
  const target = nearestInteractable(w, p)
  if (!target) return
  if (target.door) {
    const door = target.door
    if (!door.locked) {
      door.open = !door.open
      w.events.push({ type: 'doorToggle', entityId: target.id, open: door.open })
    } else if (!p.playerCtl!.channel) {
      p.playerCtl!.channel = { kind: 'lockpick', targetId: target.id, ticksLeft: LOCKPICK_TICKS }
    }
  }
}

const runChannel = (w: World, p: Entity): void => {
  const ctl = p.playerCtl!
  const channel = ctl.channel
  if (!channel) return
  // Moving (or drifting from knockback) cancels the channel
  if (Math.hypot(p.pos.x - p.prevPos.x, p.pos.y - p.prevPos.y) > 0.02) {
    ctl.channel = undefined
    return
  }
  const door = w.byId.get(channel.targetId)
  if (!door?.door || !door.door.locked) {
    ctl.channel = undefined
    return
  }
  if (--channel.ticksLeft > 0) return
  ctl.channel = undefined
  if (w.rng.chance(0.7)) {
    door.door.locked = false
    door.door.open = true
    w.events.push({ type: 'doorToggle', entityId: door.id, open: true })
  } else {
    // Botched pick: noise draws attention, counts as a witnessed-able crime
    w.events.push({ type: 'noise', x: door.pos.x, y: door.pos.y })
    ctl.crimeUntilTick = w.tick + CRIME_TICKS
    for (const npc of w.entities) {
      if (!npc.ai || npc.dead) continue
      const dist = Math.hypot(npc.pos.x - door.pos.x, npc.pos.y - door.pos.y)
      if (dist <= npc.ai.sightRange + 2) npc.ai.thinkAt = w.tick
    }
  }
}

const bleedAndRevive = (w: World, p: Entity): void => {
  const downed = p.playerCtl!.downed!
  const helper = w.entities.find(
    (e) =>
      e !== p &&
      e.playerCtl &&
      !e.playerCtl.downed &&
      !e.dead &&
      Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) < INTERACT_RANGE,
  )
  if (helper) {
    if (++downed.reviveProgress >= REVIVE_TICKS) {
      p.playerCtl!.downed = undefined
      p.health!.hp = Math.floor(p.health!.max * 0.3)
    }
  } else {
    downed.reviveProgress = 0
    if (--downed.bleedTicks <= 0) p.dead = true
  }
}

const nearestInteractable = (w: World, p: Entity): Entity | null => {
  let best: Entity | null = null
  let bestDist = Infinity
  for (const e of w.entities) {
    if (!e.interact || e.dead) continue
    const dist = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y)
    if (dist <= (e.interact.range ?? INTERACT_RANGE) && dist < bestDist) {
      best = e
      bestDist = dist
    }
  }
  return best
}

const collect = (player: Entity, item: Entity): boolean => {
  const { itemId, qty } = item.pickup!
  const ctl = player.playerCtl!
  if (itemId === 'cash') {
    ctl.cash += qty
    return true
  }
  if (itemId === 'briefcase') {
    ctl.inventory.push({ itemId, qty: 1 }) // key item, ignores slot limit
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
