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
 * Not a state but an overlay on idle: a SKID (observeSkid) — the body ran at
 * speed and stopped dead, so the display leans back against the run while the
 * sim position has already stopped.
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
import type { SkidMotion } from './motion'

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
  /** Where the body was at the last observation (observeSkid). */
  seen?: { tick: number; x: number; y: number }
  /** The run in progress at speed: since when, and the last step observed
   * (`vx/vy` tiles per tick, ending at `x/y` on `tick`). */
  run?: { since: number; peak: number; tick: number; x: number; y: number; vx: number; vy: number }
  /** The skid playing, or the last one while its dust is still in the air:
   * where the feet stopped and how fast the run was (tiles/s). */
  skid?: Skid
}

export interface Skid extends SkidMotion {
  x: number
  y: number
  speed: number
}

/** When a stop is a SKID. `minSpeed` tiles/s is a run (every walker's top speed
 * is 2.4+, the player's 4; a half-pushed stick or a wade is not); `runUp` ticks
 * at that speed before the stop, so a 1-tick jitter never skids; and the last
 * step must keep `keep` of the run's peak speed, so a body that eases down, a
 * knockback slide decaying by friction, and the short final step that snaps a
 * body flush against a wall all stop without one. `life` is how long a skid's
 * memory lasts: the lean, and the dust after it. */
export const SKID_GATE = { minSpeed: 2.2, runUp: 6, keep: 0.85, life: 16 } as const

const still = (e: Entity): boolean =>
  e.playerCtl?.downed !== undefined ||
  (e.status !== undefined && (e.status.stun > 0 || e.status.sleep > 0)) ||
  e.fx?.frozen !== undefined

/**
 * Observe a body's run and stop for the skid, given the state it resolved to.
 *
 * A frame may run several ticks at once, a hitstop may skip up to six, and a
 * network client sees the same body at another cadence. So a stop's tick is not
 * the tick it was SEEN: it is reconstructed from the distance covered since the
 * last step seen at speed (a run is constant speed, so `distance / step` ticks
 * of it went unseen). The lean is then a function of that tick alone, the same
 * at every frame rate. A run's start, and the tick a skid is cut, come back the
 * same way.
 *
 * No skid when the body stops into anything but idle (an attack, a draw, a
 * flinch: those carry the momentum themselves), rolls (the tumble and its
 * landing squash are the stop), is still pushing on (`intent` toward the run:
 * a wall stopped it, not the legs), or is stunned, asleep, frozen or downed.
 */
export const observeSkid = (mem: AnimMemory, e: Entity, tick: number, state: AnimStateName, rolling: boolean): void => {
  const seen = mem.seen
  if (seen !== undefined && tick === seen.tick) return // a second frame of the same tick
  if (seen !== undefined && tick < seen.tick) {
    mem.run = undefined // rewound: what was observed is in the future now
    mem.skid = undefined
  }
  mem.seen = { tick, x: e.pos.x, y: e.pos.y }
  if (mem.skid !== undefined && tick >= mem.skid.at + SKID_GATE.life) mem.skid = undefined

  const vx = e.pos.x - e.prevPos.x
  const vy = e.pos.y - e.prevPos.y
  const step = Math.hypot(vx, vy)
  // Ticks of a constant-speed step it took to get from (x, y) to here.
  const unseen = (x: number, y: number): number => (step > 0 ? Math.round(Math.hypot(e.pos.x - x, e.pos.y - y) / step) : 0)

  if (rolling) {
    mem.run = undefined
    mem.skid = undefined
    return
  }
  if (entityMoving(e, SIM_DT)) {
    const sp = step / SIM_DT
    const run = mem.run
    // When this movement began: just after the last observation, give or take
    // the unseen steps in between.
    const began = seen === undefined ? tick : Math.max(seen.tick + 1, tick + 1 - unseen(seen.x, seen.y))
    if (mem.skid !== undefined && mem.skid.cutAt === undefined) mem.skid.cutAt = Math.max(mem.skid.at, began)
    if (sp < SKID_GATE.minSpeed || (run !== undefined && sp < SKID_GATE.keep * run.peak)) {
      mem.run = undefined // a walk, or a body slowing down: no skid out of this
      return
    }
    mem.run = { since: run?.since ?? began, peak: Math.max(run?.peak ?? 0, sp), tick, x: e.pos.x, y: e.pos.y, vx, vy }
    return
  }

  if (mem.skid !== undefined && mem.skid.cutAt === undefined && state !== 'idle' && state !== 'fidget' && tick > mem.skid.at) {
    mem.skid.cutAt = tick
  }
  const run = mem.run
  mem.run = undefined
  if (run === undefined) return
  const len = Math.hypot(run.vx, run.vy)
  // The run kept its last step for `unseen` more ticks, then stopped.
  const at = Math.min(tick, run.tick + 1 + Math.round(Math.hypot(e.pos.x - run.x, e.pos.y - run.y) / len))
  if (at - run.since < SKID_GATE.runUp) return
  if (state !== 'idle' && state !== 'fidget') return
  if (still(e)) return
  const dirX = run.vx / len
  const dirY = run.vy / len
  if (e.intent.x * dirX + e.intent.y * dirY > 0.5) return // pushing into a wall
  mem.skid = { at, dirX, dirY, x: e.pos.x, y: e.pos.y, speed: len / SIM_DT }
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
  observeSkid(mem, e, tick, anim.state, rolling)
  return anim
}
