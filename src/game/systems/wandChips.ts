// Reactive wands (Design B), the chip half: every mod on a reactive wand is one
// CHIP, one list entry, and a chip can leave the wand to become a thing on the
// floor. Three verbs live here:
//
//   EJECT  `packModSwap(i, i)` (a swap of an entry with itself, a no-op in plain
//          sequence mode) drops entry i at the player's feet as a pickup.
//   PICKUP walking onto a chip puts it at the END of your wand, if the wand has
//          room (live slots + POCKET) and holds fewer copies than the mod's cap.
//          Your own ejected chip ignores you until you have stepped off it once.
//   CRACK  any projectile hitting an ARMED ejected payload chip destroys it and
//          bursts its element over every body within CHIP_BURST_RADIUS, through
//          the reaction table. Loot chips never crack; only ejected ones do.
//
// Scarcity invariant: nothing here creates a chip. Eject moves one from a wand
// to the floor, pickup moves one back, and crack destroys one.

import { WEAPONS } from '../data/items'
import { MODS, modMaxStacks } from '../data/mods'
import { makeEntity, type Entity, type ItemStack } from '../entity'
import { vlen } from '../simMath'
import { addEntity, type World } from '../world'
import { weaponStack, type ModPickupResult } from './inventory'
import { DEFAULT_SEQUENCE_SHAPE, liveEntries, sequenceShape, unpackModSwap, type SequenceShape } from './modSequence'
import { landElement, reactiveWands } from './reactions'

/** Chips a wand can hold past its live slots (Design B's "pocket"). */
export const POCKET = 2
/** Ticks after an eject before a projectile can crack the chip (1 s). */
export const CHIP_ARM_TICKS = 30
/** Radius of a cracked chip's element burst (tiles). */
export const CHIP_BURST_RADIUS = 2
/** A round whose shooter stands this close to a chip passes over it, so firing
 * while standing on your own dropped chip does not crack it in your face. */
export const CHIP_POINT_BLANK = 1

const shapeOf = (stack: ItemStack): SequenceShape => {
  const def = WEAPONS[stack.itemId]
  return def ? sequenceShape(def) : DEFAULT_SEQUENCE_SHAPE
}

/** Most chips (list entries) this weapon can carry: live slots plus the pocket. */
export const wandCapacity = (stack: ItemStack): number => shapeOf(stack).slots + POCKET

const copiesOf = (stack: ItemStack, modId: string): number =>
  (stack.mods ?? []).reduce((n, m) => n + (m.id === modId ? Math.max(0, m.stacks) : 0), 0)

/**
 * Handle a `modSwap` input as an eject if it is one: reactive run, and the
 * packed pair names the same entry twice. Returns true when it was an eject
 * request (valid or not), so the caller does not also treat it as a swap.
 *
 * The cast cursor follows the chips: ejecting a chip the wand already fired
 * this loop moves the cursor back one, so the next pull fires the same next
 * chip. If the cursor ends up past the end of the shrunk window, the wand
 * RECHARGES as if it wrapped. Without that, ejecting the not-yet-fired tail
 * would skip the recharge (planCasts restarts a stale index from 0 for free).
 */
export const ejectChip = (w: World, e: Entity, packed: number): boolean => {
  if (!reactiveWands(w) || !Number.isInteger(packed) || packed < 0) return false
  const { a, b } = unpackModSwap(packed)
  if (a !== b) return false
  const stack = weaponStack(e)
  const mods = stack?.mods
  if (!stack || !mods || a >= mods.length) return true
  const entry = mods[a]
  if (!MODS[entry.id] || !(entry.stacks > 0)) return true
  const shape = shapeOf(stack)
  const pos = liveEntries(mods, shape.slots).indexOf(a)
  // A legacy multi-stack entry gives up one copy; a normal chip leaves the list.
  const removed = entry.stacks <= 1
  if (removed) mods.splice(a, 1)
  else entry.stacks -= 1
  let idx = stack.castIndex ?? 0
  if (removed && pos >= 0 && pos < idx) idx -= 1
  const live = liveEntries(mods, shape.slots).length
  if (live > 0 && idx >= live) {
    idx = 0
    if (shape.rechargeOnWrap > 0) stack.rechargeUntil = Math.max(stack.rechargeUntil ?? 0, w.tick + shape.rechargeOnWrap)
  }
  if (stack.castIndex !== undefined || idx !== 0) stack.castIndex = idx
  const chip = makeEntity('pickup', `mod.${entry.id}`, e.pos.x, e.pos.y, 0.3)
  chip.pickup = { itemId: entry.id, qty: 1, chip: { ejectedBy: e.id, armedAt: w.tick + CHIP_ARM_TICKS, ownerLeft: false } }
  addEntity(w, chip)
  w.events.push({ type: 'chipEject', entityId: chip.id, byId: e.id, modId: entry.id, x: chip.pos.x, y: chip.pos.y })
  return true
}

/** Reactive-run mod pickup: append ONE entry, if there is room. Returns null
 * (the chip stays on the floor) when the wand is full, already holds the mod's
 * copy cap, or this is the grabber's own just-dropped chip. */
export const pickUpChip = (p: Entity, chipEnt: Entity): ModPickupResult | null => {
  const pk = chipEnt.pickup!
  if (pk.chip && pk.chip.ejectedBy === p.id && !pk.chip.ownerLeft) return null
  const stack = weaponStack(p)
  if (!stack || !MODS[pk.itemId]) return null
  if ((stack.mods?.length ?? 0) >= wandCapacity(stack)) return null
  if (copiesOf(stack, pk.itemId) >= modMaxStacks(pk.itemId)) return null
  ;(stack.mods ??= []).push({ id: pk.itemId, stacks: 1 })
  return { modId: pk.itemId, weapon: stack.itemId, maxed: false }
}

/** Crack the first armed payload chip projectile `proj` touches. Returns true
 * when it cracked one (the round is spent on it). */
export const crackChipHit = (w: World, proj: Entity): boolean => {
  const p = proj.projectile!
  const owner = w.byId.get(p.ownerId)
  for (const c of w.entities) {
    const chip = c.pickup?.chip
    if (!chip || c.dead || w.tick < chip.armedAt) continue
    const onHit = MODS[c.pickup!.itemId]?.onHit
    if (!onHit) continue // stat / behaviour chips are for stashing and trading, never bombs
    const rr = c.radius + proj.radius
    const dx = c.pos.x - proj.pos.x
    const dy = c.pos.y - proj.pos.y
    if (dx * dx + dy * dy >= rr * rr) continue
    if (owner && vlen(owner.pos.x - c.pos.x, owner.pos.y - c.pos.y) < CHIP_POINT_BLANK) continue
    c.dead = true
    let bodies = 0
    for (const body of w.entities) {
      if (body.dead || !body.health || (body.kind !== 'npc' && body.kind !== 'player')) continue
      if (vlen(body.pos.x - c.pos.x, body.pos.y - c.pos.y) > CHIP_BURST_RADIUS + body.radius) continue
      landElement(w, body, onHit, p.ownerId)
      bodies++
    }
    w.events.push({ type: 'chipBurst', entityId: c.id, byId: p.ownerId, modId: c.pickup!.itemId, x: c.pos.x, y: c.pos.y, radius: CHIP_BURST_RADIUS, bodies })
    return true
  }
  return false
}
