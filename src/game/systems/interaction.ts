import { SPECIAL_COOLDOWN_TICKS } from '../player'
import { CONSUMABLES, itemClass, WEAPONS } from '../data/items'
import { isModId } from '../data/mods'
import { OBJECTS } from '../data/objects'
import type { Entity } from '../entity'
import type { InputCmd } from '../types'
import { type World } from '../world'
import { addItem, applyModPickup, equipSlot } from './inventory'
import { useObject } from './objects'

const INTERACT_RANGE = 1.3
/** How far a channeling picker may drift from the door before the pick drops. */
const PICK_BREAK_RANGE = 1.6
/** Deliberate stick input past this magnitude cancels a pick channel. */
const PICK_MOVE_DEADZONE = 0.25
/** Per-tick displacement past this cancels a pick — real knockback/teleport,
 * NOT the sub-0.05 nudges pushApart deals when an NPC brushes past. */
const PICK_DRIFT_CANCEL = 0.15

/**
 * Pick-channel length per lock level, in ticks (30 = 1s). EVERY lock is
 * pickable by the default player — there are no class perks anymore, so the
 * lock level buys TIME EXPOSED, never a dead end. Tuned so a bunker's three
 * serial doors (floor 3+, L2) cost ~10.5s of channeling total.
 *   L1 (floor 1-2 mission doors)  2.0s
 *   L2 (floor 3+ mission doors)   3.5s
 *   L3 (reserved for set-pieces)  5.0s
 * Out-of-range levels clamp into the table: a mis-set lockLevel can never
 * produce an unpickable door.
 */
export const PICK_TICKS_BY_LEVEL: readonly number[] = [60, 60, 105, 150]
export const pickTicks = (lockLevel: number): number =>
  PICK_TICKS_BY_LEVEL[Math.max(1, Math.min(PICK_TICKS_BY_LEVEL.length - 1, Math.floor(lockLevel)))]

const REVIVE_TICKS = 90 // 3s of teammate proximity
/** Fraction of max HP a revived player comes back with — a low, exposed start. */
const REVIVE_HP_FRACTION = 0.3

export const interactionSystem = (w: World, inputs: Map<number, InputCmd>): void => {
  for (const p of w.entities) {
    if (!p.playerCtl || p.dead) continue
    if (p.playerCtl.downed) {
      bleedAndRevive(w, p)
      continue
    }
    autoPickup(w, p)
    const cmd = inputs.get(p.playerCtl.playerId)
    runChannel(w, p, cmd)
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
    // A weapon-mod pickup mods the grabber's own equipped gun (per-player, so co-op
    // stays consistent with every other pickup). No moddable weapon in hand → leave
    // it on the ground to grab after finding a gun, rather than wasting the mod.
    if (isModId(e.pickup.itemId)) {
      const res = applyModPickup(p, e.pickup.itemId)
      if (res) {
        e.dead = true
        w.events.push({ type: 'modPickup', entityId: e.id, byId: p.id, modId: res.modId, weapon: res.weapon, maxed: res.maxed })
      }
      continue
    }
    if (collect(p, e)) {
      e.dead = true
      w.events.push({ type: 'pickup', entityId: e.id, byId: p.id, itemId: e.pickup.itemId })
    }
  }
}

const handleInteract = (w: World, p: Entity): void => {
  const target = nearestInteractable(w.entities, p)
  if (!target) return
  if (OBJECTS[target.archetype]?.use) {
    useObject(w, p, target)
    return
  }
  if (target.door) {
    const door = target.door
    if (!door.locked) {
      door.open = !door.open
      w.events.push({ type: 'doorToggle', entityId: target.id, open: door.open })
    } else if (!p.playerCtl!.channel) {
      const total = pickTicks(door.lockLevel)
      p.playerCtl!.channel = { kind: 'lockpick', targetId: target.id, ticksLeft: total, total }
      w.events.push({ type: 'pickStart', entityId: target.id, byId: p.id, ticks: total })
    }
  }
}

/**
 * Advance a lockpick channel. Picking is DETERMINISTIC: hold your ground for
 * the full channel and the lock opens, every time — no botch roll. The cost is
 * exposure (you stand still, in the open, for the lock level's worth of
 * seconds). The channel drops only for legible reasons, each one evented so
 * the UI can say WHY: deliberate movement / real knockback (`moved`), taking a
 * hit (`hurt`, via applyDamage), or the door no longer being locked (`gone`).
 * A brushing NPC's pushApart nudge does NOT cancel — see PICK_DRIFT_CANCEL.
 */
const runChannel = (w: World, p: Entity, cmd: InputCmd | undefined): void => {
  const ctl = p.playerCtl!
  const channel = ctl.channel
  if (!channel) return
  const cancel = (reason: 'moved' | 'hurt' | 'gone'): void => {
    ctl.channel = undefined
    w.events.push({ type: 'pickCancel', entityId: channel.targetId, byId: p.id, reason })
  }
  const door = w.byId.get(channel.targetId)
  if (!door?.door || !door.door.locked) return cancel('gone')
  // Walking off (stick input), being blasted away, or ending up out of reach.
  if (cmd && Math.hypot(cmd.moveX, cmd.moveY) > PICK_MOVE_DEADZONE) return cancel('moved')
  if (Math.hypot(p.pos.x - p.prevPos.x, p.pos.y - p.prevPos.y) > PICK_DRIFT_CANCEL) return cancel('moved')
  if (Math.hypot(p.pos.x - door.pos.x, p.pos.y - door.pos.y) > PICK_BREAK_RANGE) return cancel('moved')
  if (--channel.ticksLeft > 0) return
  ctl.channel = undefined
  door.door.locked = false
  door.door.open = true
  w.events.push({ type: 'doorToggle', entityId: door.id, open: true })
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
    // Teammate revive: a standing ally hauls them up — the co-op window is kept.
    downed.reviveProgress += 1
    if (downed.reviveProgress >= REVIVE_TICKS) recover(w, p)
  } else {
    downed.reviveProgress = 0
    // Bleed-out: the downed timer is a real recovery delay, not instant death.
    if (--downed.bleedTicks <= 0) {
      // Self-revive only if nobody else could have rescued you (solo, or the last
      // one still in trouble while teammates stand). If another player is also
      // down/dead the party is failing — you bleed out for real, so a co-op wipe
      // can end the run instead of everyone popping back up forever.
      if (canSelfRecover(w, p)) recover(w, p)
      else p.dead = true
    }
  }
}

/** Can this downed player pull themselves up? Yes only when every OTHER player
 * is upright (or there are none at all — solo). */
const canSelfRecover = (w: World, p: Entity): boolean =>
  w.entities.every((e) => e === p || !e.playerCtl || (!e.playerCtl.downed && !e.dead))

/** Bring a downed player back up. In `normal` this costs a shared revive and a
 * comeback penalty (drop cash + non-key items, ability put on full cooldown);
 * `casual` just stands them up. Both paths (teammate + self) route through here
 * so the penalty lands exactly once per recovery. */
const recover = (w: World, p: Entity): void => {
  const ctl = p.playerCtl!
  ctl.downed = undefined
  p.health!.hp = Math.max(1, Math.floor(p.health!.max * REVIVE_HP_FRACTION))
  if (w.mode !== 'normal') return
  w.revivesLeft = Math.max(0, w.revivesLeft - 1)
  ctl.cash = 0
  ctl.inventory = ctl.inventory.filter((s) => itemClass(s.itemId) === 'key')
  ctl.activeSlot = -1 // dropped the weapon we were holding
  ctl.abilityCooldown = SPECIAL_COOLDOWN_TICKS
}

export const nearestInteractable = (entities: readonly Entity[], p: Entity): Entity | null => {
  let best: Entity | null = null
  let bestDist = Infinity
  for (const e of entities) {
    if (!e.interact || e.dead) continue
    const dist = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y)
    if (dist <= (e.interact.range ?? INTERACT_RANGE) && dist < bestDist) {
      best = e
      bestDist = dist
    }
  }
  return best
}

/** A picked-up weapon arrives loaded: its slot count starts at a full magazine
 * (ranged) or full durability (melee); anything else keeps its pickup qty. */
const startingCount = (itemId: string, qty: number): number => {
  const def = WEAPONS[itemId]
  if (def?.magSize) return def.magSize
  if (def?.durability) return def.durability
  return qty
}

const collect = (player: Entity, item: Entity): boolean => {
  const { itemId, qty } = item.pickup!
  const ctl = player.playerCtl!
  const c = itemClass(itemId)
  if (c === 'cash') {
    ctl.cash += qty
    return true
  }
  if (c === 'key') {
    ctl.inventory.push({ itemId, qty: 1 }) // mission item, ignores slot limit
    return true
  }
  if (c === 'consumable') {
    // Auto-heal if hurt, else stash.
    const heal = CONSUMABLES[itemId].heal ?? 0
    if (player.health && player.health.hp < player.health.max) {
      player.health.hp = Math.min(player.health.max, player.health.hp + heal)
      return true
    }
    return addItem(ctl.inventory, itemId, qty)
  }
  if (c === 'ammo') {
    // Rounds top up an existing gun; otherwise stash for the gun you'll find.
    const gun = ctl.inventory.find((s) => itemClass(s.itemId) === 'ranged')
    if (gun) {
      gun.qty += qty
      return true
    }
    return addItem(ctl.inventory, itemId, qty)
  }
  // Weapons and throwables take a slot; auto-equip the first weapon you grab.
  const added = addItem(ctl.inventory, itemId, startingCount(itemId, qty))
  if (added && (c === 'melee' || c === 'ranged') && ctl.activeSlot < 0) equipSlot(player, ctl.inventory.length - 1)
  return added
}
