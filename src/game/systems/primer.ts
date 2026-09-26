// Primer/Striker prototype (World.primerStriker, design A): the second gun.
//
// A player carries two sequenced wands. The STRIKER is the ordinary weapon
// (`weaponStack`, fired by `attack`). The PRIMER is a second inventory stack
// whose chassis has `role: 'primer'` (the Lobber), fired by `InputCmd.prime`.
// A Primer round deals no damage: its cast's payload mod picks the substance
// its glob coats bodies with (data/mods.ts `primer` faces), and Striker rounds
// react with those coats (systems/reactions.ts).
//
// The reorder input (`InputCmd.modSwap`, packed a<<8|b) spans both guns here:
//   0..15   Striker mod list position
//   16..31  Primer mod list position
//   0xFF    the floor: (i, 0xFF) ejects mod i as a world cartridge
// A swap within one gun is the ordinary reorder. A swap or move across guns
// starts the receiving gun's recharge, so re-slotting is never a free reload.
// An index at or past the end of a list means "the empty slot after the last".

import { WEAPONS } from '../data/items'
import { MODS, modMaxStacks } from '../data/mods'
import { EJECT_NOGRAB_TICKS, LOBBER_SPLASH, SPLASH_CAP, SUBSTANCES, VERB_LABEL, verbOf } from '../data/reactions'
import { makeEntity, type Entity, type ItemStack, type WeaponMod } from '../entity'
import { PRIMER_START_MODS, PRIMER_START_WEAPON } from '../player'
import { addEntity, isBlocked, type World } from '../world'
import { applyDraftPick } from './draft'
import { weaponStack, type ModPickupResult } from './inventory'
import { liveEntries, pelletShares, planCasts, recharging, sequenceShape, unpackModSwap } from './modSequence'
import { resolveWeapon } from './resolveWeapon'

export const PRIMER_BASE = 16
export const FLOOR_SLOT = 0xff

const isPrimerItem = (itemId: string): boolean => WEAPONS[itemId]?.role === 'primer'

/** The entity's Primer stack, if it carries one. */
export const primerStack = (e: Entity): ItemStack | undefined => e.loadout?.inventory.find((s) => isPrimerItem(s.itemId))

/** Give `e` a Primer (idempotent: an entity that already has one keeps it). */
export const armPrimer = (e: Entity, mods: readonly WeaponMod[] = PRIMER_START_MODS): ItemStack | undefined => {
  if (!e.loadout) return undefined
  const have = primerStack(e)
  if (have) return have
  const stack: ItemStack = { itemId: PRIMER_START_WEAPON, qty: 1, ...(mods.length ? { mods: mods.map((m) => ({ ...m })) } : {}) }
  e.loadout.inventory.push(stack)
  return stack
}

/** Fire the Primer: one trigger pull of its wand. Returns false while it is
 * recharging or when there is no Primer. The Primer keeps its own clock on its
 * stack (`rechargeUntil` doubles as its cooldown), independent of the Striker. */
export const firePrimer = (w: World, e: Entity): boolean => {
  const stack = primerStack(e)
  const def = stack && WEAPONS[stack.itemId]
  if (!stack || !def) return false
  if (recharging(stack, w.tick)) return false
  const shape = sequenceShape(def)
  const plan = planCasts(stack.mods, shape, stack.castIndex ?? 0)
  if (plan.casts.length === 0) return false // an empty Primer has nothing to lob
  stack.castIndex = plan.nextIndex
  const shares = pelletShares(def.pellets ?? 1, shape.castsPerTrigger)
  let cooldown = 1
  for (let g = 0; g < plan.casts.length; g++) {
    const cast = plan.casts[g]
    const rw = resolveWeapon({ ...def, pellets: shares[g] }, cast.mods)
    cooldown = Math.max(cooldown, rw.cooldownTicks)
    const substance = cast.payload ? MODS[cast.payload.id]?.primer : undefined
    const radius = Math.min(SPLASH_CAP, LOBBER_SPLASH + rw.behavior.explodeRadius)
    for (let j = 0; j < rw.pellets; j++) {
      const offset = rw.pellets > 1 ? (j / (rw.pellets - 1) - 0.5) * rw.spread : 0
      const angle = e.facing + offset
      const p = makeEntity('projectile', 'projectile', e.pos.x, e.pos.y, 0.15)
      p.facing = angle
      p.vel.x = Math.cos(angle) * rw.projectileSpeed
      p.vel.y = Math.sin(angle) * rw.projectileSpeed
      p.projectile = {
        ownerId: e.id,
        damage: 0,
        ttl: Math.ceil((def.range / rw.projectileSpeed) * 30),
        prime: { ...(substance ? { substance } : {}), radius },
        mods: cast.mods.map((m) => ({ ...m })),
      }
      if (rw.behavior.pierce) p.projectile.pierceLeft = rw.behavior.pierce
      if (rw.behavior.bounce) p.projectile.bounceLeft = rw.behavior.bounce
      if (rw.behavior.homing) p.projectile.homing = rw.behavior.homing
      addEntity(w, p)
    }
  }
  if (plan.wrapped) cooldown = Math.max(cooldown, shape.rechargeOnWrap)
  stack.rechargeUntil = w.tick + cooldown
  return true
}

interface SlotRef {
  stack: ItemStack
  index: number
}

const slotRef = (e: Entity, idx: number): SlotRef | undefined => {
  const stack = idx < PRIMER_BASE ? weaponStack(e) : idx < PRIMER_BASE * 2 ? primerStack(e) : undefined
  return stack ? { stack, index: idx % PRIMER_BASE } : undefined
}

const startRecharge = (w: World, stack: ItemStack): void => {
  const def = WEAPONS[stack.itemId]
  if (!def) return
  const r = sequenceShape(def).rechargeOnWrap
  if (r > 0) stack.rechargeUntil = Math.max(stack.rechargeUntil ?? 0, w.tick + r)
}

const has = (ref: SlotRef): boolean => ref.index < (ref.stack.mods?.length ?? 0)

/** Apply one packed reorder request across both guns. Invalid requests are ignored. */
export const applyLoadoutSwap = (w: World, e: Entity, packed: number): boolean => {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffff) return false
  let { a, b } = unpackModSwap(packed)
  if (a === b) return false
  if (a === FLOOR_SLOT) [a, b] = [b, a]
  if (b === FLOOR_SLOT) return ejectMod(w, e, a)
  const A = slotRef(e, a)
  const B = slotRef(e, b)
  if (!A || !B) return false
  const aHas = has(A)
  const bHas = has(B)
  if (!aHas && !bHas) return false
  if (aHas && bHas) {
    const ma = A.stack.mods!
    const mb = B.stack.mods!
    const tmp = ma[A.index]
    ma[A.index] = mb[B.index]
    mb[B.index] = tmp
  } else {
    // Move the one real entry to the end of the other side's list.
    const [src, dst] = aHas ? [A, B] : [B, A]
    const [moved] = src.stack.mods!.splice(src.index, 1)
    ;(dst.stack.mods ??= []).push(moved)
  }
  if (A.stack !== B.stack) {
    startRecharge(w, A.stack)
    startRecharge(w, B.stack)
  }
  return true
}

/** Pop one stack of mod `idx` out of its gun as a cartridge on the floor, one
 * tile ahead of the player (at their feet if that tile is a wall). The dropper
 * cannot re-grab it for EJECT_NOGRAB_TICKS; anyone else can at once. */
export const ejectMod = (w: World, e: Entity, idx: number): boolean => {
  const ref = slotRef(e, idx)
  if (!ref || !has(ref)) return false
  const mods = ref.stack.mods!
  const m = mods[ref.index]
  if (!MODS[m.id]) return false
  if (m.stacks > 1) m.stacks -= 1
  else mods.splice(ref.index, 1)
  const ax = e.pos.x + Math.cos(e.facing)
  const ay = e.pos.y + Math.sin(e.facing)
  const clear = !isBlocked(w, Math.floor(ax), Math.floor(ay))
  const x = clear ? ax : e.pos.x
  const y = clear ? ay : e.pos.y
  const c = makeEntity('pickup', `mod.${m.id}`, x, y, 0.3)
  c.pickup = { itemId: m.id, qty: 1, noGrabUntil: w.tick + EJECT_NOGRAB_TICKS, dropperId: e.id }
  addEntity(w, c)
  w.events.push({ type: 'modEject', entityId: c.id, byId: e.id, modId: m.id, x, y })
  return true
}

/** May `p` grab this pickup now? Only an ejected cartridge's dropper waits. */
export const canGrab = (w: World, p: Entity, pickup: NonNullable<Entity['pickup']>): boolean =>
  pickup.dropperId !== p.id || pickup.noGrabUntil === undefined || w.tick >= pickup.noGrabUntil

/** A walked-over mod cartridge on a Primer/Striker run: into the Primer if its
 * live window has room, else into the Striker. Returns null with no gun at all. */
export const routeModPickup = (e: Entity, modId: string): ModPickupResult | null => {
  if (!MODS[modId]) return null
  const primer = primerStack(e)
  const primerDef = primer && WEAPONS[primer.itemId]
  const room = primer && primerDef && liveEntries(primer.mods, sequenceShape(primerDef).slots).length < sequenceShape(primerDef).slots
  const stack = room ? primer : weaponStack(e)
  if (!stack) return null
  const before = stack.mods?.find((m) => m.id === modId)?.stacks ?? 0
  const cap = modMaxStacks(modId)
  applyDraftPick(stack, modId, 1)
  return { modId, weapon: stack.itemId, maxed: before >= cap }
}

/** One gun, described for a player: its mods with their swap indices, and the
 * full cast cycle it fires from slot 0 (what will actually execute). */
export interface WandView {
  weapon: string
  slots: number
  ready: boolean
  /** `"<swap index>:<mod id>"`, stowed entries (past `slots`) marked. */
  mods: string[]
  /** One label per cast in a full cycle, e.g. `SPARK +pierce`, `SOAK splash 2.5`. */
  cycle: string[]
  /** The cast the next trigger pull starts at (index into `cycle`). */
  next: number
}

export const describeWand = (w: World, stack: ItemStack | undefined, base: number): WandView | undefined => {
  const def = stack && WEAPONS[stack.itemId]
  if (!stack || !def) return undefined
  const shape = { ...sequenceShape(def), castsPerTrigger: 1 }
  const primer = def.role === 'primer'
  const live = new Set(liveEntries(stack.mods, shape.slots))
  const mods = (stack.mods ?? []).map((m, i) => `${base + i}:${m.id}${m.stacks > 1 ? `x${m.stacks}` : ''}${live.has(i) ? '' : ' (stowed)'}`)
  const cycle: string[] = []
  let at = 0
  let next = 0
  for (let guard = 0; guard < shape.slots + 1; guard++) {
    if (at === (stack.castIndex ?? 0)) next = cycle.length
    const plan = planCasts(stack.mods, shape, at)
    const cast = plan.casts[0]
    if (!cast) break
    const extras = cast.mods.filter((m) => m.id !== cast.payload?.id).map((m) => m.id)
    if (primer) {
      const sub = cast.payload ? MODS[cast.payload.id]?.primer : undefined
      const rw = resolveWeapon(def, cast.mods)
      const radius = Math.min(SPLASH_CAP, LOBBER_SPLASH + rw.behavior.explodeRadius)
      cycle.push(`${sub ? SUBSTANCES[sub].label : 'DUD'} splash ${Math.round(radius * 10) / 10}${extras.length ? ` +${extras.join('+')}` : ''}`)
    } else {
      const onHit = cast.payload ? MODS[cast.payload.id]?.onHit : undefined
      cycle.push(`${VERB_LABEL[verbOf(onHit)]}${extras.length ? ` +${extras.join('+')}` : ''}`)
    }
    if (plan.wrapped) break
    at = plan.nextIndex
  }
  return { weapon: stack.itemId, slots: shape.slots, ready: !recharging(stack, w.tick), mods, cycle, next }
}
