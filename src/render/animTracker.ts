/**
 * Per-entity animation MEMORY — the render-side observer that turns what the
 * sim exposes on an entity into the one-shot start ticks animState.ts resolves.
 *
 * The sim knows nothing about animation, so a one-shot's start is DERIVED from
 * observed change between frames, never from a one-tick event (events are
 * cleared every tick and a slow frame can run several ticks):
 *
 * - attack: `combat.cooldown` rose (the sim only ever decrements it);
 * - draw:   `ai.mode` became `'aggro'` (the body engaged a target), after at
 *           least DRAW_REARM_TICKS not engaged — a flicker does not re-draw;
 * - hurt:   `status.hitFlashUntil` (the sim stamps the hit tick + 3);
 * - roll:   `playerCtl.roll` (the sim's own window);
 * - fidget: the body has been still and calm since `stillSince`, and the
 *           entity's hashed fidget grid has an onset (animState.fidgetStart).
 *
 * Pure apart from the memory object it updates, imports no pixi, and reads the
 * clock only as the sim tick, so EntityViews and the tests run the same code.
 */

import type { Entity } from '../game/entity'
import { ROLL_TICKS } from '../game/systems/roll'
import { SIM_DT } from '../game/types'
import { entityMoving } from './anim'
import { fidgetStart, hurtStart, resolveAnimState, type AnimStateName, type ResolvedAnim } from './animState'

/** Ticks a body must spend NOT engaged before engaging again re-plays `draw`.
 * The AI drops in and out of aggro at perception edges (a target stepping
 * behind a pillar); a weapon already out is not drawn twice in a second. */
export const DRAW_REARM_TICKS = 30

export interface AnimMemory {
  /** combat.cooldown at the last observation. */
  prevCooldown?: number
  /** Tick the last observed attack started. */
  attackStart?: number
  /** Was the body engaged at the last observation? Undefined until first seen:
   * a body that is already engaged when it first appears does not draw. */
  engaged?: boolean
  /** Tick the body last went from engaged to not engaged. */
  disengagedAt?: number
  /** Tick the last draw started. */
  drawStart?: number
  /** Tick the body last became still and calm (idle or fidgeting); undefined
   * while it is doing anything else. */
  stillSince?: number
}

/** The engage signal: the AI is in its hostile mode (battle or pursue). */
export const isEngaged = (e: Entity): boolean => e.ai?.mode === 'aggro'

/** Calm enough to fidget: no fight, flight or errand on its mind, not dormant,
 * downed, stunned, asleep or frozen. A scratch mid-firefight reads as a bug. */
export const isCalm = (e: Entity): boolean => {
  const mode = e.ai?.mode
  if (mode === 'aggro' || mode === 'flee' || mode === 'seek') return false
  if (e.ai?.dormant === true || e.playerCtl?.downed !== undefined) return false
  if (e.status !== undefined && (e.status.stun > 0 || e.status.sleep > 0)) return false
  return e.fx?.frozen === undefined
}

/**
 * Observe `e` at `tick`, update `mem`, and resolve its animation state.
 * `clipTicks` holds the length (frames × tpf) of the facing pose's OWN clip for
 * each drawn-only state; a state absent there is not drawn and never plays.
 */
export const trackAnim = (
  mem: AnimMemory,
  e: Entity,
  tick: number,
  clipTicks: Partial<Record<AnimStateName, number>>,
): ResolvedAnim => {
  const cd = e.combat?.cooldown
  if (cd !== undefined && mem.prevCooldown !== undefined && cd > mem.prevCooldown) mem.attackStart = tick
  mem.prevCooldown = cd

  const engaged = isEngaged(e)
  if (mem.engaged === false && engaged) {
    if (mem.disengagedAt === undefined || tick - mem.disengagedAt >= DRAW_REARM_TICKS) mem.drawStart = tick
  } else if (mem.engaged === true && !engaged) {
    mem.disengagedAt = tick
  }
  mem.engaged = engaged

  const roll = e.playerCtl?.roll
  const rolling = roll !== undefined && tick < roll.untilTick
  const calm = isCalm(e)
  const anim = resolveAnimState({
    tick,
    moving: entityMoving(e, SIM_DT),
    starts: {
      attack: mem.attackStart,
      draw: mem.drawStart,
      hurt: hurtStart(e.status?.hitFlashUntil),
      roll: rolling ? roll.untilTick - ROLL_TICKS : undefined,
      fidget: calm ? fidgetStart(e.id, tick, mem.stillSince, clipTicks.fidget ?? 0) : undefined,
    },
    simEnds: { roll: rolling ? roll.untilTick : undefined },
    clipTicks,
  })

  const still = calm && (anim.state === 'idle' || anim.state === 'fidget')
  if (!still) mem.stillSince = undefined
  else mem.stillSince ??= tick
  return anim
}
