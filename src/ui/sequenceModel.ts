// View model for the sequenced-mods strip (HUD and pause-menu loadout). Pure:
// reads the wielded weapon's ItemStack exactly as the sim left it. The "next"
// highlight comes from the stack's own `castIndex`, the value the fire path
// will read, never from a UI-side counter that could drift from it. On a co-op
// client that stack is the host's, delivered verbatim in InventoryMsg.

import { WEAPONS } from '../game/data/items'
import { MODS } from '../game/data/mods'
import type { Entity } from '../game/entity'
import { weaponStack } from '../game/systems/inventory'
import { isPayloadMod, liveEntries, sequenceShape } from '../game/systems/modSequence'
import type { ModCasting } from '../game/world'
import { modPickupColor } from '../render/modColors'
import { toCssHex } from './loadoutModel'
import { modVerdict } from '../game/systems/modEffect'

export interface SequenceEntry {
  /** Raw index into the weapon's mod list (what a swap request names). */
  listIndex: number
  id: string
  name: string
  icon: string
  color: string
  stacks: number
  /** Element mod: ends a cast. Otherwise a modifier riding on the next payload. */
  payload: boolean
  /** Inside the weapon's live window. False = stowed (past `slots`). */
  live: boolean
  /** Part of the cast the next trigger pull fires. */
  next: boolean
  /** Why a live-window mod changes nothing (or only hurts) on the shot it
   * rides in. Absent when it works, and for stowed mods. */
  verdict?: string
}

export interface SequenceModel {
  weaponName: string
  slots: number
  castsPerTrigger: number
  entries: SequenceEntry[]
  /** Ticks of recharge left (0 = ready). */
  rechargeLeft: number
  /** The weapon's full recharge, for drawing a progress bar. */
  rechargeTotal: number
}

/**
 * Build the strip for `self`, or null when there is nothing to show: the run is
 * not sequenced, or the wielded weapon has no mod list. `simTick` must be the
 * host's tick (RenderView.simTick ?? tick). `order` optionally previews pending
 * reorder requests; highlighting still follows the sim's stored index.
 */
export const buildSequence = (
  self: Entity | undefined,
  modCasting: ModCasting | undefined,
  simTick: number,
  order?: (mods: readonly { id: string; stacks: number }[]) => { id: string; stacks: number }[],
): SequenceModel | null => {
  if (modCasting !== 'sequence' || !self?.combat) return null
  const def = WEAPONS[self.combat.weapon]
  const stack = weaponStack(self)
  if (!def || !stack?.mods || stack.mods.length === 0) return null
  const shape = sequenceShape(def)
  const mods = order ? order(stack.mods) : stack.mods
  const live = liveEntries(mods, shape.slots)
  const liveSet = new Set(live)
  // Mark the cast(s) the next pull fires: walk forward from castIndex the same
  // way planCasts does, stopping at the wrap.
  const nextSet = new Set<number>()
  const start = stack.castIndex ?? 0
  let i = Number.isInteger(start) && start >= 0 && start < live.length ? start : 0
  for (let c = 0; c < shape.castsPerTrigger && i < live.length; c++) {
    while (i < live.length) {
      const idx = live[i++]
      nextSet.add(idx)
      if (isPayloadMod(mods[idx].id)) break
    }
  }
  const entries: SequenceEntry[] = mods.map((m, listIndex) => {
    const d = MODS[m.id]
    const v = d && liveSet.has(listIndex) ? modVerdict(def, mods, m.id, true) : undefined
    return {
      ...(v && v.kind !== 'live' ? { verdict: v.reason } : {}),
      listIndex,
      id: m.id,
      name: d?.name ?? m.id,
      icon: d?.icon ?? '?',
      color: toCssHex(modPickupColor(m.id)),
      stacks: m.stacks,
      payload: isPayloadMod(m.id),
      live: liveSet.has(listIndex),
      next: nextSet.has(listIndex),
    }
  })
  const left = stack.rechargeUntil !== undefined ? Math.max(0, stack.rechargeUntil - simTick) : 0
  return {
    weaponName: def.name,
    slots: shape.slots,
    castsPerTrigger: shape.castsPerTrigger,
    entries,
    rechargeLeft: left,
    rechargeTotal: shape.rechargeOnWrap,
  }
}
