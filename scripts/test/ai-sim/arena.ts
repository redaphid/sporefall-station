// Shared headless AI-simulation harness. Builds a clean open arena (no levelgen
// crowd), places NPCs/players exactly, ticks the REAL systems, and measures AI
// behaviour deterministically. Used by the baseline + prototype comparison
// scripts in this directory. Nothing here touches render/input/net.

import { makeEntity, type Entity } from '../../../src/game/entity'
import { Tile } from '../../../src/game/levelgen/level'
import { spawnNpc } from '../../../src/game/populate'
import { spawnPlayer } from '../../../src/game/player'
import { createWorld, tickWorld, type World } from '../../../src/game/world'
import { emptyInput, type InputCmd } from '../../../src/game/types'
// Re-exported so probe scripts get `decide` through a graph loaded in the right
// order (world -> ai -> behaviors), sidestepping the ai<->behaviors init cycle.
export { decide } from '../../../src/game/systems/behaviors'

/** A fresh world with a big open floor arena carved centre, no populate crowd. */
export const makeArena = (seed: number, half = 22, hostile = true): World => {
  const w = createWorld(seed, 1, 'normal', hostile)
  const cx = Math.floor(w.level.w / 2)
  const cy = Math.floor(w.level.h / 2)
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x > 0 && y > 0 && x < w.level.w - 1 && y < w.level.h - 1) {
        w.level.tiles[y * w.level.w + x] = Tile.Floor
        w.level.solid[y * w.level.w + x] = 0
      }
    }
  }
  w.level.spawn = { x: cx + 0.5, y: cy + 0.5 }
  return w
}

export const center = (w: World): { x: number; y: number } => ({
  x: Math.floor(w.level.w / 2) + 0.5,
  y: Math.floor(w.level.h / 2) + 0.5,
})

/** Turn a rectangle of tiles solid (an obstacle / chokepoint wall). */
export const wall = (w: World, x0: number, y0: number, x1: number, y1: number): void => {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      w.level.tiles[y * w.level.w + x] = Tile.Wall
      w.level.solid[y * w.level.w + x] = 1
    }
  }
}

/** A player entity that hostiles will target. `iframes:0` so it can be hit;
 * high hp so a measurement run isn't cut short by its death. Stationary. */
export const addPlayer = (w: World, x: number, y: number, hp = 100000): Entity => {
  const p = spawnPlayer(w, 0, x, y)
  p.health = { hp, max: hp, iframes: 0 }
  return p
}

/** An NPC at an exact spot; opts override archetype defaults. Speed 0 pins it. */
export const addNpc = (
  w: World,
  archetype: string,
  x: number,
  y: number,
  opts: { hp?: number; behavior?: string; sight?: number; weapon?: string; speed?: number; guard?: boolean } = {},
): Entity => {
  const e = spawnNpc(w, archetype, x, y)
  if (opts.hp !== undefined) e.health = { hp: opts.hp, max: e.health!.max, iframes: 0 }
  if (opts.behavior !== undefined) e.ai!.behavior = opts.behavior
  if (opts.sight !== undefined) e.ai!.sightRange = opts.sight
  if (opts.weapon !== undefined) e.combat!.weapon = opts.weapon
  if (opts.speed !== undefined) e.speed = opts.speed
  if (opts.guard) e.ai!.guard = true
  return e
}

const npcs = (w: World): Entity[] => w.entities.filter((e) => e.kind === 'npc' && e.ai && !e.dead)

export interface Metrics {
  ticks: number
  npcCount: number
  /** aiGoal transition events total. */
  goalFlips: number
  /** goal flips per surviving NPC per 100 ticks — the #59 thrash number. */
  flipRate: number
  /** ticks any NPC spent oscillating within one 3-flip window (proxy for jitter). */
  battleFleeFlips: number
  /** DIRECT per-tick sampling (not the gated event stream): every change in an
   * NPC's `ai.goal` code across consecutive ticks. Catches battle<->pursue and
   * flee<->battle flips the notable-event filter hides. */
  goalChanges: number
  /** per-tick changes in an NPC's `ai.targetId` — target-dithering / retargeting
   * jitter (beelines a new direction each think). */
  targetSwitches: number
  /** goalChanges per surviving NPC per 100 ticks — the true thrash rate. */
  changeRate: number
  /** total `hit` events (aggression / engagement). */
  hits: number
  /** total `death` events among NPCs. */
  deaths: number
  /** mean pairwise distance among living NPCs at the final tick (clustering). */
  finalSpread: number
  /** per-entity flip counts (id -> flips). */
  perNpcFlips: Record<number, number>
  /** any custom counters a scenario adds. */
  extra: Record<string, number>
}

export interface RunOpts {
  ticks: number
  input?: Map<number, Partial<InputCmd>>
  /** Called every tick after the sim step (custom measurement / scripted acts). */
  onTick?: (w: World, t: number) => void
}

/** Run N ticks, collecting the standard behaviour metrics from world events. */
export const measure = (w: World, opts: RunOpts): Metrics => {
  const perNpcFlips: Record<number, number> = {}
  let goalFlips = 0
  let hits = 0
  let deaths = 0
  let battleFleeFlips = 0
  const lastGoal: Record<number, string> = {}
  const prevGoalCode: Record<number, string | undefined> = {}
  const prevTarget: Record<number, number | undefined> = {}
  let goalChanges = 0
  let targetSwitches = 0
  const input = new Map<number, InputCmd>(
    [...(opts.input ?? new Map())].map(([s, c]) => [s, { ...emptyInput(), ...c }]),
  )
  for (let t = 0; t < opts.ticks; t++) {
    tickWorld(w, input)
    // Direct per-tick sampling of decided goal/target (bypasses the event gate).
    for (const e of npcs(w)) {
      const g = e.ai!.goal
      if (g !== undefined && e.id in prevGoalCode && prevGoalCode[e.id] !== g) goalChanges++
      prevGoalCode[e.id] = g
      const tgt = e.ai!.targetId
      if (e.id in prevTarget && prevTarget[e.id] !== tgt && (prevTarget[e.id] !== undefined || tgt !== undefined))
        targetSwitches++
      prevTarget[e.id] = tgt
    }
    for (const ev of w.events) {
      if (ev.type === 'aiGoal') {
        goalFlips++
        perNpcFlips[ev.entityId] = (perNpcFlips[ev.entityId] ?? 0) + 1
        const prev = lastGoal[ev.entityId]
        const bf = new Set(['battle', 'flee', 'pursue'])
        if (prev !== undefined && bf.has(prev) && bf.has(ev.goal)) battleFleeFlips++
        lastGoal[ev.entityId] = ev.goal
      } else if (ev.type === 'hit') hits++
      else if (ev.type === 'death') deaths++
    }
    opts.onTick?.(w, t)
  }
  const living = npcs(w)
  let spread = 0
  let pairs = 0
  for (let i = 0; i < living.length; i++) {
    for (let j = i + 1; j < living.length; j++) {
      spread += Math.hypot(living[i].pos.x - living[j].pos.x, living[i].pos.y - living[j].pos.y)
      pairs++
    }
  }
  const npcCount = Math.max(1, living.length)
  return {
    ticks: opts.ticks,
    npcCount: living.length,
    goalFlips,
    flipRate: (goalFlips / npcCount / opts.ticks) * 100,
    battleFleeFlips,
    goalChanges,
    targetSwitches,
    changeRate: (goalChanges / npcCount / opts.ticks) * 100,
    hits,
    deaths,
    finalSpread: pairs ? spread / pairs : 0,
    perNpcFlips,
    extra: {},
  }
}

export const fmt = (m: Metrics, label: string): string =>
  `${label.padEnd(26)} chg=${String(m.goalChanges).padStart(4)} rate=${m.changeRate
    .toFixed(2)
    .padStart(6)}/npc/100t  tgtSw=${String(m.targetSwitches).padStart(4)}  b<->f=${String(m.battleFleeFlips).padStart(
    3,
  )}  hits=${String(m.hits).padStart(4)}  deaths=${String(m.deaths).padStart(2)}  spread=${m.finalSpread.toFixed(1)}`
