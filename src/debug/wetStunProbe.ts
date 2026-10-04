// The wet stun-lock probe, ported from integration PR #122 (substrateProbes.ts
// `stunProbe`, flooded street). One gangster armed with a stun gun starts
// STUN_GUNNER_DIST tiles down an open street row from the players. On a flooded
// street the bog tide is in from the first tick, so everyone there is wet and
// each stun hit on a wet player is a `shock` that floods the wet cluster.
//
//   npx tsx scripts/wet-stun-probe.mts

import { HostSession } from '../app/hostSession'
import type { Entity } from '../game/entity'
import { TIDE_FLOOD, TIDE_PERIOD } from '../game/floorModifiers'
import { isSolidTile, rectContains } from '../game/levelgen/level'
import type { Rect } from '../game/levelgen/rooms'
import { spawnPlayer } from '../game/player'
import { npcLoadout, spawnNpc } from '../game/populate'
import { vlen } from '../game/simMath'
import { startFloorModifier } from '../game/systems/modifierSystem'
import { isImmobilized } from '../game/systems/statusFx'
import { emptyInput, SIM_RATE, type InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'

/** #122's census seeds. */
export const PROBE_SEEDS: readonly number[] = [303, 5, 4, 2, 44, 18, 51, 10]
export const STUN_PROBE_TICKS = 10 * SIM_RATE
export const STUN_GUNNER_DIST = 4
export const REACT_TICKS = SIM_RATE / 2

export type Ground = 'dry street' | 'flooded street'
/** What each player does on every tick it can act.
 * - `stand`: nothing, as in #122.
 * - `fight`: stand and shoot the gunner.
 * - `react`: stand until first hurt or locked, then walk straight away from the
 *   gunner REACT_TICKS later.
 * - `flee`: walk straight away from the gunner from the first tick. */
export type Policy = 'stand' | 'fight' | 'react' | 'flee'
export const POLICIES: readonly Policy[] = ['stand', 'fight', 'react', 'flee']
export type Team = 1 | 2

export interface StunRun {
  seed: number
  ground: Ground
  policy: Policy
  team: Team
  shots: number
  /** Tick the gunner died, if it did. */
  gunnerDownAt?: number
  /** Per player, in playerId order. */
  damage: number[]
  /** `shock` events that hit the player: one per electrocution. */
  arcHits: number[]
  /** Of those, the ones that landed on a tick the player started immobilized. */
  lockedArcHits: number[]
  /** Damage taken on ticks the player started immobilized: harm it had no
   * way to answer. */
  lockedDamage: number[]
  /** Ticks spent immobilized. */
  lockedTicks: number[]
  /** Longest unbroken run of immobilized ticks. */
  longestLock: number[]
  /** Ticks the player was standing (not downed), for damage per second. */
  upTicks: number[]
  downedAt: (number | undefined)[]
}

/** The open 3-wide street row of `n` cells nearest the level's centre (#122's
 * census `openStreetRow`). */
const openStreetRow = (w: World, n: number): Rect => {
  const { level } = w
  const indoors = (x: number, y: number): boolean => level.buildings.some((b) => rectContains(b.rect, x, y))
  const standing = w.entities.filter((e) => e.kind === 'interactable' || e.kind === 'door')
  const occupied = new Set(standing.map((e) => Math.floor(e.pos.y) * level.w + Math.floor(e.pos.x)))
  const clear = (x: number, y: number): boolean => !isSolidTile(level, x, y) && !indoors(x, y) && !occupied.has(y * level.w + x)
  let best: Rect | undefined
  let bestD = Infinity
  for (let y = 1; y < level.h - 1; y++) {
    for (let x = 1; x + n < level.w; x++) {
      let ok = true
      for (let i = 0; i < n && ok; i++) ok = clear(x + i, y - 1) && clear(x + i, y) && clear(x + i, y + 1)
      const d = Math.abs(x + n / 2 - level.w / 2) + Math.abs(y - level.h / 2)
      if (ok && d < bestD) {
        best = { x, y, w: n, h: 1 }
        bestD = d
      }
    }
  }
  if (!best) throw new Error(`probe: seed ${w.seed} has no ${n}-cell open street row`)
  return best
}

const playersOf = (w: World): Entity[] => w.entities.filter((e) => e.playerCtl).sort((a, b) => a.playerCtl!.playerId - b.playerCtl!.playerId)

/** Clear the cast, loot, fire and projectiles, and stand player 0 on the row's
 * second cell at full health (#122's `stageArena` with no foes). */
const stage = (w: World, row: Rect): Entity => {
  w.entities = w.entities.filter(
    (e) => e.playerCtl || !(e.ai || e.projectile || e.kind === 'pickup' || e.kind === 'fire' || (e.kind === 'interactable' && rectContains(row, Math.floor(e.pos.x), Math.floor(e.pos.y)))),
  )
  w.byId.clear()
  for (const e of w.entities) w.byId.set(e.id, e)
  w.groups = undefined
  w.hostile = true
  w.mission = { template: 'reach', complete: true, exitUnlocked: false, description: 'Probe' }
  const p = playersOf(w)[0]
  if (!p) throw new Error('probe: the run has no player')
  p.pos = { x: row.x + 1.5, y: row.y + 0.5 }
  p.prevPos = { ...p.pos }
  p.facing = 0
  p.health = { hp: p.health!.max, max: p.health!.max, iframes: 0 }
  return p
}

/** A second player one tile across the row from `first`, inside one arc's
 * chain radius. */
const addTeammate = (w: World, first: Entity): Entity => {
  const dy = isSolidTile(w.level, Math.floor(first.pos.x), Math.floor(first.pos.y + 1)) ? -1 : 1
  const mate = spawnPlayer(w, 1, first.pos.x, first.pos.y + dy)
  mate.facing = first.facing
  mate.health = { hp: mate.health!.max, max: mate.health!.max, iframes: 0 }
  return mate
}

const policyInput = (policy: Policy, p: Entity, gunner: Entity, t: number, hitAt: number | undefined): InputCmd | undefined => {
  const dx = gunner.pos.x - p.pos.x
  const dy = gunner.pos.y - p.pos.y
  const d = vlen(dx, dy) || 1
  const aim = { ...emptyInput(), seq: t + 1, aimX: dx / d, aimY: dy / d }
  if (policy === 'fight') return gunner.dead ? undefined : { ...aim, attack: true }
  const moving = policy === 'flee' || (hitAt !== undefined && t >= hitAt + REACT_TICKS)
  return policy !== 'stand' && moving ? { ...aim, moveX: -dx / d, moveY: -dy / d } : undefined
}

export const stunProbe = (seed: number, ground: Ground, policy: Policy, team: Team): StunRun => {
  const w = new HostSession(seed, { sample: emptyInput }).world
  const row = openStreetRow(w, STUN_GUNNER_DIST + 2)
  const first = stage(w, row)
  if (ground === 'flooded street') startFloorModifier(w, 'bogTide', TIDE_PERIOD - TIDE_FLOOD)
  if (team === 2) addTeammate(w, first)
  const players = playersOf(w)
  const gunner = spawnNpc(w, 'gangster', first.pos.x + STUN_GUNNER_DIST, first.pos.y)
  gunner.combat!.weapon = 'stunGun'
  gunner.loadout = npcLoadout('stunGun')

  const n = players.length
  const run: StunRun = {
    seed, ground, policy, team, shots: 0,
    damage: Array(n).fill(0), lockedDamage: Array(n).fill(0), arcHits: Array(n).fill(0), lockedArcHits: Array(n).fill(0), lockedTicks: Array(n).fill(0),
    longestLock: Array(n).fill(0), upTicks: Array(n).fill(0), downedAt: Array(n).fill(undefined),
  }
  const shots = new Set<number>()
  const prevHp = players.map((p) => p.health!.hp)
  const streak: number[] = Array(n).fill(0)
  const hitAt: (number | undefined)[] = Array(n).fill(undefined)
  const down = (p: Entity): boolean => p.dead || !!p.playerCtl!.downed
  for (let t = 0; t < STUN_PROBE_TICKS; t++) {
    const inputs = new Map<number, InputCmd>()
    const lockedBefore = players.map(isImmobilized)
    players.forEach((p, i) => {
      if (down(p) || isImmobilized(p)) return
      const cmd = policyInput(policy, p, gunner, t, hitAt[i])
      if (cmd) inputs.set(p.playerCtl!.playerId, cmd)
    })
    tickWorld(w, inputs)
    for (const ev of w.events) {
      if (ev.type !== 'shock') continue
      const i = players.findIndex((p) => p.id === ev.targetId)
      if (i < 0) continue
      run.arcHits[i]++
      if (lockedBefore[i]) run.lockedArcHits[i]++
    }
    for (const e of w.entities) if (e.projectile?.ownerId === gunner.id) shots.add(e.id)
    if (run.gunnerDownAt === undefined && (gunner.dead || gunner.health!.hp <= 0)) run.gunnerDownAt = t + 1
    players.forEach((p, i) => {
      const hp = Math.max(p.health!.hp, 0)
      if (hp < prevHp[i]) run.damage[i] += prevHp[i] - hp
      if (hp < prevHp[i] && lockedBefore[i]) run.lockedDamage[i] += prevHp[i] - hp
      prevHp[i] = hp
      if (down(p)) {
        run.downedAt[i] ??= t + 1
        return
      }
      run.upTicks[i]++
      if (hitAt[i] === undefined && (hp < p.health!.max || isImmobilized(p))) hitAt[i] = t
      streak[i] = isImmobilized(p) ? streak[i] + 1 : 0
      if (streak[i]) run.lockedTicks[i]++
      run.longestLock[i] = Math.max(run.longestLock[i], streak[i])
    })
  }
  run.shots = shots.size
  return run
}

export interface StunSummary {
  ground: Ground
  policy: Policy
  team: Team
  /** Seeds on which the gunner died. */
  gunnerDowned: number
  /** Per player: seeds on which they went down. */
  downed: number[]
  /** Per player: median seconds to down, over the seeds they went down on. */
  medianDownS: (number | undefined)[]
  /** Per player: damage taken per second standing, over all seeds. */
  dps: number[]
  /** Per player: share of damage taken while immobilized. */
  lockedDamageShare: number[]
  arcHits: number[]
  lockedArcHits: number[]
  /** Per player: share of standing time spent immobilized. */
  lockedShare: number[]
  longestLockS: number[]
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

export const summarize = (runs: readonly StunRun[]): StunSummary => {
  const { ground, policy, team } = runs[0]
  const each = <T>(f: (i: number) => T): T[] => [...Array(team).keys()].map(f)
  return {
    ground, policy, team,
    gunnerDowned: runs.filter((r) => r.gunnerDownAt !== undefined).length,
    downed: each((i) => runs.filter((r) => r.downedAt[i] !== undefined).length),
    medianDownS: each((i) => {
      const m = median(runs.flatMap((r) => (r.downedAt[i] === undefined ? [] : [r.downedAt[i]!])))
      return m === undefined ? undefined : m / SIM_RATE
    }),
    dps: each((i) => (sum(runs.map((r) => r.damage[i])) * SIM_RATE) / sum(runs.map((r) => r.upTicks[i]))),
    lockedDamageShare: each((i) => sum(runs.map((r) => r.lockedDamage[i])) / Math.max(1, sum(runs.map((r) => r.damage[i])))),
    arcHits: each((i) => sum(runs.map((r) => r.arcHits[i]))),
    lockedArcHits: each((i) => sum(runs.map((r) => r.lockedArcHits[i]))),
    lockedShare: each((i) => sum(runs.map((r) => r.lockedTicks[i])) / sum(runs.map((r) => r.upTicks[i]))),
    longestLockS: each((i) => Math.max(...runs.map((r) => r.longestLock[i])) / SIM_RATE),
  }
}

export const probeTable = (seeds: readonly number[] = PROBE_SEEDS): StunSummary[] => {
  const out: StunSummary[] = []
  for (const ground of ['dry street', 'flooded street'] as const)
    for (const policy of POLICIES)
      for (const team of [1, 2] as const) out.push(summarize(seeds.map((s) => stunProbe(s, ground, policy, team))))
  return out
}
