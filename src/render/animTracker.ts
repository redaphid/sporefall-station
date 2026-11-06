/**
 * Per-entity animation MEMORY — the render-side observer that turns what the
 * sim exposes on an entity into the one-shot start ticks animState.ts resolves.
 *
 * The sim knows nothing about animation, so a one-shot's start is DERIVED from
 * observed change between frames where the entity carries the signal:
 *
 * - attack: `combat.cooldown` rose (the sim only ever decrements it);
 * - draw:   `ai.mode` became `'aggro'` (the body engaged a target), after at
 *           least DRAW_REARM_TICKS not engaged — a flicker does not re-draw;
 * - hurt:   `status.hitFlashUntil` (the sim stamps the hit tick + 3);
 * - roll:   `playerCtl.roll` (the sim's own window);
 * - fidget: the body has been still and calm since `stillSince`, and the
 *           entity's hashed fidget grid has an onset (animState.fidgetStart).
 *
 * Some actions leave no such trace on the actor: the lobber's shell and a hive
 * spire's budding raise no `combat.cooldown`. Those start from sim EVENTS
 * (EVENT_STARTS). An event lives for one tick, so the renderer reads it from
 * the RenderView's `eventLog` (every recent tick, app/eventLog.ts), taking
 * every tick since its last update: a frame that ran three ticks, or a hitstop
 * that froze the entity layer, still sees each one, and the clip starts on the
 * event's own tick. An event-driven start plays only frames the pack draws;
 * without them the body looks exactly as it did before it had the action.
 *
 * Pure apart from the memory object it updates, imports no pixi, and reads the
 * clock only as the sim tick, so EntityViews and the tests run the same code.
 */

import type { TickEvents } from '../app/eventLog'
import { DRAW_REARM_TICKS } from '../game/data/npcs'
import type { Entity } from '../game/entity'
import { ROLL_TICKS } from '../game/systems/roll'
import { SIM_DT, type EntityId, type SimEvent } from '../game/types'
import { entityMoving } from './anim'
import { fidgetStart, hurtStart, resolveAnimState, type AnimStateName, type ResolvedAnim } from './animState'

/** Ticks a body must spend NOT engaged before engaging again re-plays `draw`.
 * The sim's own: the same window decides when an engage waits its
 * `NpcDef.drawTicks` again (systems/ai.ts), so the clip and the held fire agree. */
export { DRAW_REARM_TICKS }

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
  /** Latest start per state from a sim event (EVENT_STARTS). */
  eventStarts?: Partial<Record<AnimStateName, number>>
}

type EventOf<K extends SimEvent['type']> = Extract<SimEvent, { type: K }>

/** A sim event that starts a one-shot on the entity it names. */
interface EventStart<K extends SimEvent['type']> {
  readonly state: AnimStateName
  /** The entity that acts (not always `entityId`: a hive event names the bud). */
  readonly actor: (ev: EventOf<K>) => EntityId
}

/** THE event start sources: which sim event starts which one-shot, on whom.
 * A new event-driven action is one row here (and its state's row in
 * animState.ANIM_STATE_DEFS). */
export const EVENT_STARTS: { readonly [K in SimEvent['type']]?: EventStart<K> } = {
  // The siege gun fires a shell (systems/groups.ts lob).
  lob: { state: 'attack', actor: (ev) => ev.entityId },
  // A hive spire buds a sporeling, or roots a new spire nearby.
  hiveSpawn: { state: 'attack', actor: (ev) => ev.byId },
  hiveSpread: { state: 'attack', actor: (ev) => ev.byId },
}

/** The one-shot starts the events of ticks `after` (exclusive) through `upTo`
 * (inclusive) call for, per acting entity; a later event wins. */
export const eventStarts = (
  log: readonly TickEvents[],
  after: number,
  upTo: number,
): Map<EntityId, Partial<Record<AnimStateName, number>>> => {
  const out = new Map<EntityId, Partial<Record<AnimStateName, number>>>()
  for (const { tick, events } of log) {
    if (tick <= after || tick > upTo) continue
    for (const ev of events) {
      // EVENT_STARTS[ev.type] is the row for ev's own type; TS cannot
      // correlate the two through the union.
      const src = EVENT_STARTS[ev.type] as EventStart<SimEvent['type']> | undefined
      if (!src) continue
      const id = (src.actor as (e: SimEvent) => EntityId)(ev)
      const starts = out.get(id) ?? {}
      starts[src.state] = tick
      out.set(id, starts)
    }
  }
  return out
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
 * each clip-sized state (animState.CLIP_SIZED_STATES); a state absent there is
 * not drawn. `fromEvents` are the starts the sim events since the last
 * observation call for on this entity (eventStarts).
 */
export const trackAnim = (
  mem: AnimMemory,
  e: Entity,
  tick: number,
  clipTicks: Partial<Record<AnimStateName, number>>,
  fromEvents?: Partial<Record<AnimStateName, number>>,
): ResolvedAnim => {
  for (const [s, at] of Object.entries(fromEvents ?? {}) as [AnimStateName, number][]) {
    if (!((mem.eventStarts?.[s] ?? -Infinity) >= at)) (mem.eventStarts ??= {})[s] = at
  }

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
  const starts: Partial<Record<AnimStateName, number>> = {
    attack: mem.attackStart,
    draw: mem.drawStart,
    hurt: hurtStart(e.status?.hitFlashUntil),
    roll: rolling ? roll.untilTick - ROLL_TICKS : undefined,
    fidget: calm ? fidgetStart(e.id, tick, mem.stillSince, clipTicks.fidget ?? 0) : undefined,
  }
  // An event start counts only where the pose draws the state, only once its
  // tick has come (a rewound tracker can hold one from the future), and only
  // over an older observed start.
  for (const [s, at] of Object.entries(mem.eventStarts ?? {}) as [AnimStateName, number][]) {
    const own = starts[s]
    if ((clipTicks[s] ?? 0) > 0 && at <= tick && (own === undefined || own > tick || own < at)) starts[s] = at
  }
  const anim = resolveAnimState({
    tick,
    moving: entityMoving(e, SIM_DT),
    starts,
    simEnds: { roll: rolling ? roll.untilTick : undefined },
    clipTicks,
  })

  const still = calm && (anim.state === 'idle' || anim.state === 'fidget')
  if (!still) mem.stillSince = undefined
  else mem.stillSince ??= tick
  return anim
}
