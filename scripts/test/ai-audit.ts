// AI audit rig (chore/ai-audit) — MEASUREMENT ONLY, no game-source changes.
//
// Runs real seeded floors headless, drives a player that actually pushes into
// the level, and samples every NPC every tick. The sim already records its own
// "why trail" (ai.goal / ai.goalSince / ai.lastScores), so this is pure
// observation: nothing in src/game is modified or monkey-patched.
//
//   npx tsx scripts/test/ai-audit.ts > audit.json

import { createWorld, tickWorld, type World } from '../../src/game/world'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { spawnPlayer } from '../../src/game/player'
import { hasLineOfSight } from '../../src/game/los'
import { findPath } from '../../src/game/path'
import { BEHAVIORS, CONSIDERATIONS } from '../../src/game/systems/behaviors'
import type { Entity } from '../../src/game/entity'
import type { InputCmd } from '../../src/game/types'

const NEUTRAL: InputCmd = {
  seq: 0, moveX: 0, moveY: 0, attack: false, interact: false,
  special: false, aimX: 1, aimY: 0, hotbar: -1, throwItem: false, roll: false,
}

/** On-screen radius in tiles. Phone at default zoom shows ~12 tiles across
 * (ZOOM_MIN 0.5 => ~24), so ~12 tiles from the player is a generous "could the
 * player possibly have seen this happen" radius. */
const VIEW = 12
const CONTACT = 2.0   // melee contact
const FIRING = 7.0    // ranged engagement

const d2 = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

interface GoalStat {
  act: number; actNear: number; ticks: number; ticksNear: number
  npcs: Set<string>; seeds: Set<string>; behaviors: Set<string>
  minDist: number
}
const mkGoal = (): GoalStat => ({
  act: 0, actNear: 0, ticks: 0, ticksNear: 0,
  npcs: new Set(), seeds: new Set(), behaviors: new Set(), minDist: Infinity,
})

const goalStats = new Map<string, GoalStat>()
const behStats = new Map<string, { npcs: Set<string>; ticks: number; act: number; actNear: number; goals: Map<string, number>; nearTicks: number }>()
const consStats = new Map<string, { nonZero: number; max: number; top: number }>()
const eventCounts = new Map<string, number>()
const contactEvents = new Map<string, number>()
const modeAtContact = new Map<string, number>()
const goalAtContact = new Map<string, number>()
const sealOpenVia = new Map<string, number>()
const squadPerSeed: { seed: string; squads: number; members: number; roles: Record<string, number> }[] = []
const attackGaps: number[] = []
const bump = <K>(m: Map<K, number>, k: K, n = 1): void => { m.set(k, (m.get(k) ?? 0) + n) }

const G = (g: string): GoalStat => {
  let s = goalStats.get(g); if (!s) { s = mkGoal(); goalStats.set(g, s) } return s
}
const B = (b: string) => {
  let s = behStats.get(b)
  if (!s) { s = { npcs: new Set(), ticks: 0, act: 0, actNear: 0, goals: new Map(), nearTicks: 0 }; behStats.set(b, s) }
  return s
}

/** Drive the player like someone clearing a floor: route to the nearest live
 * NPC and swing/shoot on contact. Keeps the run in the contact regime that the
 * owner actually experiences. */
const drivePlayer = (w: World, p: Entity, cache: { path: import('../../src/game/types').Vec2[] | null; at: number }): InputCmd => {
  let target: Entity | null = null
  let bestD = Infinity
  for (const e of w.entities) {
    if (e.kind !== 'npc' || e.dead || !e.ai) continue
    const d = d2(p.pos, e.pos)
    if (d < bestD) { bestD = d; target = e }
  }
  if (!target) return { ...NEUTRAL }
  const los = hasLineOfSight(w.level, p.pos.x, p.pos.y, target.pos.x, target.pos.y)
  const cmd: InputCmd = { ...NEUTRAL }
  const ax = target.pos.x - p.pos.x, ay = target.pos.y - p.pos.y
  const al = Math.hypot(ax, ay) || 1
  cmd.aimX = ax / al; cmd.aimY = ay / al
  cmd.attack = los && bestD <= FIRING
  if (bestD <= CONTACT * 0.8) return cmd // in his face already

  if (w.tick >= cache.at || !cache.path || cache.path.length === 0) {
    cache.path = findPath(w.level, p.pos.x, p.pos.y, target.pos.x, target.pos.y, { bestEffort: true })
    cache.at = w.tick + 12
  }
  const node = cache.path?.[0]
  if (node) {
    const nx = node.x + 0.5 - p.pos.x, ny = node.y + 0.5 - p.pos.y
    const nl = Math.hypot(nx, ny)
    if (nl < 0.35) cache.path!.shift()
    else { cmd.moveX = nx / nl; cmd.moveY = ny / nl }
  } else {
    cmd.moveX = ax / al; cmd.moveY = ay / al
  }
  cmd.interact = true // shove doors / use things on the way, like a player does
  return cmd
}

const runOne = (seed: number, floor: number, ticks: number): void => {
  const tag = `${seed}/${floor}`
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const p = spawnPlayer(w, 0, w.level.spawn.x, w.level.spawn.y)
  // Measurement rig: keep the observer alive so the whole floor gets sampled.
  if (p.health) { p.health.hp = 100000; p.health.max = 100000 }

  // Squad census at spawn (before anything moves).
  const squads = new Map<number, number>()
  const roles: Record<string, number> = {}
  for (const e of w.entities) {
    if (e.ai?.squad) {
      bump(squads as unknown as Map<number, number>, e.ai.squad.id)
      roles[e.ai.squad.role] = (roles[e.ai.squad.role] ?? 0) + 1
    }
  }
  squadPerSeed.push({ seed: tag, squads: squads.size, members: [...squads.values()].reduce((a, b) => a + b, 0), roles })

  const prev = new Map<number, string>()
  const lastAttackTick = new Map<number, number>()
  const cache = { path: null as import('../../src/game/types').Vec2[] | null, at: -1 }

  for (let t = 0; t < ticks; t++) {
    const inputs = new Map<number, InputCmd>()
    if (!p.dead) inputs.set(0, drivePlayer(w, p, cache))
    tickWorld(w, inputs)

    for (const ev of w.events) {
      bump(eventCounts, String((ev as { type: string }).type))
      const anyEv = ev as { type: string; entityId?: number; via?: string }
      if (anyEv.type === 'sealOpen' && anyEv.via) bump(sealOpenVia, anyEv.via)
      const src = anyEv.entityId !== undefined ? w.byId.get(anyEv.entityId) : undefined
      if (src && src.kind === 'npc' && d2(src.pos, p.pos) <= FIRING) {
        bump(contactEvents, anyEv.type)
        if (/attack|swing|shoot|fire|melee/i.test(anyEv.type)) {
          const last = lastAttackTick.get(src.id)
          if (last !== undefined) attackGaps.push(w.tick - last)
          lastAttackTick.set(src.id, w.tick)
        }
      }
    }

    for (const e of w.entities) {
      if (e.kind !== 'npc' || e.dead || !e.ai) continue
      const nid = `${tag}#${e.id}`
      const beh = e.ai.behavior ?? 'basic'
      const goal = e.ai.goal ?? '(none)'
      const dist = d2(e.pos, p.pos)
      const los = dist <= VIEW && hasLineOfSight(w.level, p.pos.x, p.pos.y, e.pos.x, e.pos.y)
      const near = dist <= VIEW && los

      const gs = G(goal)
      gs.ticks++; gs.npcs.add(nid); gs.seeds.add(tag); gs.behaviors.add(beh)
      if (dist < gs.minDist) gs.minDist = dist
      if (near) gs.ticksNear++

      const bs = B(beh)
      bs.ticks++; bs.npcs.add(nid); bump(bs.goals, goal)
      if (near) bs.nearTicks++

      const sig = `${goal}@${e.ai.goalSince ?? -1}`
      if (prev.get(e.id) !== sig) {
        prev.set(e.id, sig)
        gs.act++; bs.act++
        if (near) { gs.actNear++; bs.actNear++ }
      }

      if (e.ai.lastScores) {
        let topId = '', topVal = -Infinity
        for (const [k, v] of Object.entries(e.ai.lastScores)) {
          let c = consStats.get(k)
          if (!c) { c = { nonZero: 0, max: -Infinity, top: 0 }; consStats.set(k, c) }
          if (v > 0) c.nonZero++
          if (v > c.max) c.max = v
          if (v > topVal) { topVal = v; topId = k }
        }
        if (topId) { const c = consStats.get(topId)!; c.top++ }
      }

      if (dist <= CONTACT) {
        bump(modeAtContact, e.ai.mode)
        bump(goalAtContact, goal)
      }
    }
  }
}

const SEEDS = (process.env.AUDIT_SEEDS ?? '1001,1002,1003,1004,1005,1006,2077,31337').split(',').map(Number)
const FLOORS = (process.env.AUDIT_FLOORS ?? '1,2,3').split(',').map(Number)
const TICKS = Number(process.env.AUDIT_TICKS ?? 2400) // 80s of sim per run

for (const s of SEEDS) for (const f of FLOORS) runOne(s, f, TICKS)

const out = {
  config: { seeds: SEEDS, floors: FLOORS, ticksPerRun: TICKS, runs: SEEDS.length * FLOORS.length, viewTiles: VIEW },
  registryBehaviors: Object.keys(BEHAVIORS),
  registryConsiderations: Object.keys(CONSIDERATIONS),
  goals: [...goalStats.entries()].map(([g, s]) => ({
    goal: g, activations: s.act, activationsNearPlayer: s.actNear,
    ticks: s.ticks, ticksNearPlayer: s.ticksNear,
    distinctNpcs: s.npcs.size, seedsSeen: s.seeds.size,
    behaviors: [...s.behaviors].sort(), closestApproachTiles: Number(s.minDist.toFixed(2)),
  })).sort((a, b) => b.activations - a.activations),
  behaviors: [...behStats.entries()].map(([b, s]) => ({
    behavior: b, distinctNpcs: s.npcs.size, npcTicks: s.ticks, npcTicksNearPlayer: s.nearTicks,
    activations: s.act, activationsNearPlayer: s.actNear,
    goalMix: [...s.goals.entries()].sort((x, y) => y[1] - x[1]).map(([g, n]) => `${g}:${n}`),
  })).sort((a, b) => b.npcTicks - a.npcTicks),
  behaviorsNeverInstantiated: Object.keys(BEHAVIORS).filter((b) => !behStats.has(b)),
  considerations: [...consStats.entries()].map(([c, s]) => ({
    consideration: c, timesScoredNonZero: s.nonZero, timesTopScorer: s.top, maxScore: s.max === -Infinity ? null : s.max,
  })).sort((a, b) => b.timesTopScorer - a.timesTopScorer),
  considerationsNeverEvaluated: Object.keys(CONSIDERATIONS).filter((c) => !consStats.has(c)),
  squads: squadPerSeed,
  contact: {
    modeAtMeleeContact: Object.fromEntries(modeAtContact),
    goalAtMeleeContact: Object.fromEntries(goalAtContact),
    npcEventTypesWithinFiringRange: Object.fromEntries([...contactEvents.entries()].sort((a, b) => b[1] - a[1])),
    attackIntervalTicks: attackGaps.length
      ? {
          n: attackGaps.length,
          distinct: [...new Set(attackGaps)].sort((a, b) => a - b).slice(0, 20),
          min: Math.min(...attackGaps), max: Math.max(...attackGaps),
          mean: Number((attackGaps.reduce((a, b) => a + b, 0) / attackGaps.length).toFixed(2)),
        }
      : null,
  },
  sealOpenVia: Object.fromEntries(sealOpenVia),
  allEventTypes: Object.fromEntries([...eventCounts.entries()].sort((a, b) => b[1] - a[1])),
}
console.log(JSON.stringify(out, null, 2))
