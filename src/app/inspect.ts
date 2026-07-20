// The always-on browser-console inspection surface: `window.world` and
// `window.sporefall` (docs/ai-inspection.md). This is the AI-native ECS
// philosophy applied to the console — an agent driving Chrome (claude-in-chrome)
// against a dev build OR the deployed site can answer "what is happening in this
// game right now?" with no debug-hub WebSocket infrastructure.
//
// Design contract:
// - Reads work in EVERY build. The world is plain serializable objects, so
//   handing out a live reference (`.world`) plus JSON-clone accessors
//   (`.entities()`, `.entity()`, …) is harmless and enormously useful.
// - Every accessor EXCEPT `.world` returns a deep JSON clone — mutating a
//   returned object can never touch the sim. `.world` is the one live
//   reference (look, don't touch); the namespace itself is frozen.
// - Writes stay dev-gated: `.verb()` bridges to the existing debug verb
//   dispatcher (src/debug/verbs.ts) only under `?debug`/`?e2e`. In production
//   it exists but returns a refusal string explaining the gate —
//   discoverability without capability.
// - Sessions without an authoritative world (join/client) still answer reads
//   from the latest predicted RenderView, cached from the frame loop so
//   inspection never double-consumes the client's one-shot event queue.

import type { Entity } from '../game/entity'
import { serializeWorld } from '../game/serialize'
import type { SimEvent } from '../game/types'
import type { World } from '../game/world'
import { buildSchema, runVerb, serializeEntity } from '../debug/verbs'
import type { RenderView } from './session'

/** A sim event tagged with the tick it happened on (world.events is wiped every
 * tick; the surface keeps a ring of the last ~EVENT_TICK_WINDOW ticks' worth). */
export type TaggedEvent = SimEvent & { tick: number }

/** How many ticks of events the ring buffer keeps (~20s at 30tps). */
export const EVENT_TICK_WINDOW = 600
/** Hard cap on buffered events so a particle storm can't grow memory unbounded. */
export const EVENT_CAP = 2048

/** What a join (client) session exposes as `window.world`: the latest predicted
 * view, shaped like the World fields a reader cares about, flagged `predicted`. */
export interface PredictedWorldView {
  predicted: true
  tick: number
  floor: number
  gameOver: boolean
  entities: readonly Entity[]
  mission: { description: string; complete: boolean; targetEntityId?: number }
}

export interface Sporefall {
  /** Live world reference — authoritative on host/solo, predicted view on a client. */
  readonly world: World | PredictedWorldView
  help(): string
  tick(): number
  session(): Record<string, unknown>
  version(): string
  entities(filter?: string | ((e: Entity) => boolean)): Record<string, unknown>[]
  entity(id: number): Record<string, unknown> | undefined
  player(playerId?: number): Record<string, unknown> | undefined
  mission(): Record<string, unknown>
  events(sinceTick?: number): TaggedEvent[]
  schema(): ReturnType<typeof buildSchema>
  serialize(): string
  verb(line: string, args?: string): string
}

export interface InspectDeps {
  /** The authoritative world, when this session owns one (solo/host). */
  getWorld: () => World | undefined
  /** Fallback view source for reads that land before the first frame. */
  getView: () => RenderView
  /** Session-level facts main.ts owns: {mode, paused, peers?}. */
  sessionInfo: () => Record<string, unknown>
  /** Are mutation verbs enabled? (?debug / ?e2e — never in production.) */
  devWrites: boolean
  /** Running build number (git commit count via APP_VERSION). */
  version: string
  /** Renderer hook for the `theme` verb (presentation-only). */
  setTheme?: (id: string) => void
}

export interface Inspect {
  ns: Sporefall
  /** Call once per sim tick (host/solo): harvest this tick's events before the
   * next tick wipes world.events. Duplicate-tick calls (pause) are ignored. */
  afterTick(): void
  /** Call once per frame with the view the render loop obtained. Caches it for
   * reads and (client only, where renderView() drains events) harvests events. */
  frame(view: RenderView): void
}

/** One source of truth for the API: `sig` leads with the exact member name so
 * help() and the namespace can be tested against each other for completeness. */
const HELP: readonly { sig: string; doc: string }[] = [
  { sig: 'world', doc: 'live World object (host/solo authoritative; join: predicted view). Look, don’t touch — use .verb() to mutate.' },
  { sig: 'help()', doc: 'this usage doc' },
  { sig: 'tick()', doc: 'current sim tick' },
  { sig: 'session()', doc: '{mode, paused, floor, tick, gameOver, seed?, difficulty?, alarm?, peers?}' },
  { sig: 'version()', doc: 'running build number' },
  { sig: "entities(filter?)", doc: "JSON clones of matching entities. filter: a kind/archetype/component name ('npc', 'guard', 'door') or a predicate ('e => e.health?.hp < 3')" },
  { sig: 'entity(id)', doc: 'one entity as a JSON clone (undefined if absent), e.g. sporefall.entity(12)' },
  { sig: 'player(playerId?)', doc: 'the local player entity (or player N) as a JSON clone' },
  { sig: 'mission()', doc: 'current mission state {description, complete, ...}' },
  { sig: 'events(sinceTick?)', doc: `recent sim events tagged {tick, type, ...} — ring buffer of the last ~${EVENT_TICK_WINDOW} ticks` },
  { sig: 'schema()', doc: 'live component/archetype reflection derived from the entities actually present' },
  { sig: 'serialize()', doc: 'lossless WorldJson string (replayable via the load verb or ?world=)' },
  { sig: "verb(line, args?)", doc: "debug verbs — get/set/spawn/kill/teleport/step/load/annotate/ai/setBehavior/… e.g. verb('teleport 12 5 5'). Dev-gated: needs ?debug (or ?e2e); returns a refusal string in production." },
]

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Turn an `entities()` filter into a predicate. A plain name matches kind,
 * archetype, or component presence; a string containing `=>` is compiled as a
 * predicate so a console/AI caller can filter without a function object. */
const compileFilter = (filter?: string | ((e: Entity) => boolean)): ((e: Entity) => boolean) => {
  if (filter === undefined) return () => true
  if (typeof filter === 'function') return filter
  if (filter.includes('=>')) {
    let fn: unknown
    try {
      fn = new Function(`return (${filter})`)()
    } catch (err) {
      throw new Error(`bad predicate ${JSON.stringify(filter)}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
    if (typeof fn !== 'function') throw new Error(`bad predicate ${JSON.stringify(filter)}: not a function`)
    return (e) => !!(fn as (e: Entity) => unknown)(e)
  }
  const name = filter
  return (e) => e.kind === name || e.archetype === name || (e as unknown as Record<string, unknown>)[name] != null
}

export const createInspect = (deps: InspectDeps): Inspect => {
  /** Latest RenderView, cached from the frame loop. Reads prefer it so client
   * sessions are never asked to renderView() twice (which would drain events). */
  let lastView: RenderView | undefined
  const view = (): RenderView => (lastView ??= deps.getView())

  const events: TaggedEvent[] = []
  let lastCapturedTick = -1
  const capture = (tick: number, evs: readonly SimEvent[]): void => {
    for (const e of evs) events.push({ ...clone(e), tick })
    while (events.length > 0 && events[0].tick < tick - EVENT_TICK_WINDOW) events.shift()
    while (events.length > EVENT_CAP) events.shift()
  }

  const liveEntities = (): readonly Entity[] => deps.getWorld()?.entities ?? view().entities

  const predictedWorld = (): PredictedWorldView => {
    const v = view()
    return {
      predicted: true,
      tick: v.tick,
      floor: v.floor,
      gameOver: v.gameOver,
      entities: v.entities,
      mission: {
        description: v.missionText,
        complete: v.missionComplete,
        ...(v.missionTargetId !== undefined ? { targetEntityId: v.missionTargetId } : {}),
      },
    }
  }

  const ns: Sporefall = {
    get world() {
      return deps.getWorld() ?? predictedWorld()
    },

    help: () =>
      [
        'sporefall — console inspection surface for the live game (docs/ai-inspection.md).',
        'Everything but .world returns detached JSON clones; mutating them never touches the sim.',
        ...HELP.map(({ sig, doc }) => `  sporefall.${sig} — ${doc}`),
      ].join('\n'),

    tick: () => deps.getWorld()?.tick ?? view().tick,

    session: () => {
      const w = deps.getWorld()
      return {
        ...deps.sessionInfo(),
        tick: w?.tick ?? view().tick,
        floor: w?.floor ?? view().floor,
        gameOver: w?.gameOver ?? view().gameOver,
        ...(w ? { seed: w.seed, difficulty: w.mode, alarm: w.alarm } : { predicted: true }),
      }
    },

    version: () => deps.version,

    entities: (filter) => {
      const match = compileFilter(filter)
      const out: Record<string, unknown>[] = []
      for (const e of liveEntities()) if (match(e)) out.push(serializeEntity(e))
      return out
    },

    entity: (id) => {
      const w = deps.getWorld()
      const e = w ? w.byId.get(id) : liveEntities().find((x) => x.id === id)
      return e ? serializeEntity(e) : undefined
    },

    player: (playerId) => {
      const e =
        playerId === undefined ? view().self : liveEntities().find((x) => x.playerCtl?.playerId === playerId)
      return e ? serializeEntity(e) : undefined
    },

    mission: () => {
      const w = deps.getWorld()
      if (w) return clone(w.mission) as unknown as Record<string, unknown>
      const v = view()
      return {
        description: v.missionText,
        complete: v.missionComplete,
        ...(v.missionTargetId !== undefined ? { targetEntityId: v.missionTargetId } : {}),
      }
    },

    events: (sinceTick) => clone(sinceTick === undefined ? events : events.filter((e) => e.tick >= sinceTick)),

    schema: () => buildSchema({ entities: liveEntities() }),

    serialize: () => {
      const w = deps.getWorld()
      if (!w)
        return 'unavailable: this is a join (client) session — only the host owns the authoritative world. Serialize on the host device, or run solo.'
      return JSON.stringify(serializeWorld(w))
    },

    verb: (line, args) => {
      const full = args === undefined ? line : `${line} ${args}`
      if (!deps.devWrites)
        return (
          'sporefall.verb is disabled in this build: mutation verbs are dev-only. ' +
          'Reload with ?debug in the URL to enable them. ' +
          'Read-only inspection (sporefall.world/entities/events/serialize/…) works right here.'
        )
      const w = deps.getWorld()
      if (!w)
        return 'sporefall.verb needs the authoritative world — this is a join (client) session; run verbs on the host device (or a solo session).'
      return runVerb(w, full, { events, setTheme: deps.setTheme })
    },
  }
  Object.freeze(ns)

  return {
    ns,
    afterTick: () => {
      const w = deps.getWorld()
      if (!w || w.tick === lastCapturedTick) return
      lastCapturedTick = w.tick
      capture(w.tick, w.events)
    },
    frame: (v) => {
      lastView = v
      // Clients drain their event queue in renderView(); this frame's view is
      // the only place those events ever appear, so harvest them here. Hosts
      // are covered per-tick in afterTick() — harvesting here too would dupe.
      if (!deps.getWorld()) capture(v.tick, v.events)
    },
  }
}

/** Install the surface on a window-like target: `world` (getter, so it tracks
 * world replacement via ?world= / the load verb / restart) and `sporefall`. */
export const installInspect = (inspect: Inspect, target: object): void => {
  Object.defineProperty(target, 'world', { configurable: true, get: () => inspect.ns.world })
  Object.defineProperty(target, 'sporefall', { configurable: true, value: inspect.ns })
}
