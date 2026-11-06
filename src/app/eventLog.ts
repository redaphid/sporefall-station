/**
 * Every recent sim tick's events, for render-side consumers that can skip
 * ticks.
 *
 * A session's RenderView carries `events`: on a host that is `world.events`,
 * the events of the LAST tick only, wiped by the next one. A frame runs as
 * many sim ticks as the wall clock owes (a slow frame several), and hitstop
 * freezes the entity layer for up to HITSTOP_MAX frames while the sim runs on.
 * A consumer that reads `view.events` once per frame therefore misses the
 * events of every tick but the last. This log keeps them: main.ts feeds it
 * after each sim tick (and, on a client, each frame's drained events), and the
 * RenderView carries it as `eventLog`. A consumer remembers the last tick it
 * read and takes every entry after it.
 *
 * Presentation only: the sim never reads it, and nothing here reaches the wire.
 */

import { SIM_RATE, type SimEvent } from '../game/types'

/** The events of one sim tick (client: of one frame, stamped with its tick). */
export interface TickEvents {
  readonly tick: number
  readonly events: readonly SimEvent[]
}

/** Ticks of history kept: well past the longest gap between two entity-layer
 * updates (a frame runs at most ~8 ticks, a hitstop holds at most 6 frames). */
export const EVENT_LOG_TICKS = 2 * SIM_RATE

export interface EventLog {
  /** Oldest first; ticks with no events have no entry. */
  readonly entries: readonly TickEvents[]
  /** Host and solo: once after each sim tick, with that tick's world.events
   * (copied, since the next tick wipes them). A repeat of the newest tick is
   * ignored (a paused session does not advance). */
  afterTick(tick: number, events: readonly SimEvent[]): void
  /** Client: once per frame, with the events the session drained for this
   * frame, stamped with the view's tick. Two frames on one tick both land. */
  frame(tick: number, events: readonly SimEvent[]): void
}

export const createEventLog = (): EventLog => {
  const entries: TickEvents[] = []
  let newest = -1

  const add = (tick: number, events: readonly SimEvent[]): void => {
    // A tick earlier than the newest is a restart or a rewind: the history
    // belongs to a world that no longer exists.
    if (tick < newest) entries.length = 0
    newest = tick
    while (entries.length > 0 && entries[0].tick <= tick - EVENT_LOG_TICKS) entries.shift()
    if (events.length > 0) entries.push({ tick, events: events.slice() })
  }

  return {
    entries,
    afterTick(tick, events) {
      if (tick === newest) return
      add(tick, events)
    },
    frame(tick, events) {
      add(tick, events)
    },
  }
}
