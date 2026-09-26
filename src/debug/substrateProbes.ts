// Side-effect probes for docs/design/substrate-census.md: what a flooded lair
// does to the players, not only to the boss. `teamFight` is the census fight
// (`runFight`) with an optional second bot player standing beside the first;
// `stunProbe` stands players in front of an NPC stun gunner, dry or flooded.

import { ARENAS, arenaRoom, stageArena, TIDE_ARENA_AGE } from '../game/arenas'
import type { Entity } from '../game/entity'
import { isSolidTile } from '../game/levelgen/level'
import { spawnPlayer } from '../game/player'
import { npcLoadout, spawnNpc } from '../game/populate'
import { applyScenario } from '../game/scenarios'
import { startFloorModifier } from '../game/systems/modifierSystem'
import { hasStatus } from '../game/systems/statusFx'
import type { InputCmd } from '../game/types'
import { tickWorld, type World } from '../game/world'
import { botInput, FIGHT_TICKS, livingFoes, newRun, openStreetRow, type CensusBuild, type Outcome } from './census'
import { heldCmd, parseHeldInput, runVerb } from './verbs'

export type Team = 1 | 2

/** Per-player tallies, in playerId order. */
export interface PlayerTally {
  damage: number[]
  /** Electrocution hits taken: the `shock` event a wet body's arc damage emits. */
  arcHits: number[]
  /** Ticks spent electrified (locked in place). */
  shockedTicks: number[]
}

export interface TeamFightResult extends PlayerTally {
  arena: string
  build: string
  seed: number
  team: Team
  outcome: Outcome
  ticks: number
}

/** Where the stun probe stands: the arena room dry, the arena room under the
 * tide (EXPERIMENT_FLOODED_ROOMS), or an open street row under the tide, which
 * floods in real bog-tide play with no experiment. */
export type StunGround = 'dry room' | 'flooded room' | 'flooded street'

export interface StunProbeResult extends PlayerTally {
  seed: number
  ground: StunGround
  team: Team
  shots: number
  /** Tick each player went down, if they did. */
  downedAt: (number | undefined)[]
}

export const STUN_PROBE_TICKS = 300
export const STUN_GUNNER_DIST = 4

/** A second player one tile beside `first`, across the line `first` stands
 * on (`alongX`: the line runs along y), so the two stand inside one arc's chain
 * radius. */
const addTeammate = (w: World, first: Entity, alongX: boolean): Entity => {
  const spots = alongX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]
  const [dx, dy] = spots.find(([sx, sy]) => !isSolidTile(w.level, Math.floor(first.pos.x + sx), Math.floor(first.pos.y + sy))) ?? spots[0]
  const mate = spawnPlayer(w, 1, first.pos.x + dx, first.pos.y + dy)
  mate.facing = first.facing
  mate.health = { hp: mate.health!.max, max: mate.health!.max, iframes: 0 }
  return mate
}

const roomAlongX = (w: World): boolean => {
  const room = arenaRoom(w)
  return !room || room.w >= room.h
}

const teamOf = (w: World): Entity[] => w.entities.filter((e) => e.playerCtl).sort((a, b) => a.playerCtl!.playerId - b.playerCtl!.playerId)

/** Tick once with every standing player driven by the census bot (or held
 * neutral), and add this tick's damage, arc hits and lock to `tally`. */
const stepAndTally = (w: World, players: Entity[], tally: PlayerTally, prevHp: number[], bot: boolean): void => {
  const inputs = new Map<number, InputCmd>()
  if (bot) {
    for (const p of players) {
      if (p.dead || p.playerCtl!.downed) continue
      const step = botInput(w, p)
      if (!step) continue
      const held = parseHeldInput(w, JSON.stringify({ ...step, player: p.playerCtl!.playerId }))
      inputs.set(held.playerId, heldCmd(w, held, 0))
    }
  }
  tickWorld(w, inputs)
  for (const ev of w.events) {
    if (ev.type !== 'shock') continue
    const i = players.findIndex((p) => p.id === ev.targetId)
    if (i >= 0) tally.arcHits[i]++
  }
  players.forEach((p, i) => {
    const hp = Math.max(p.health!.hp, 0)
    if (hp < prevHp[i]) tally.damage[i] += prevHp[i] - hp
    prevHp[i] = hp
    if (hasStatus(p, 'electrified')) tally.shockedTicks[i]++
  })
}

const emptyTally = (n: number): PlayerTally => ({ damage: Array(n).fill(0), arcHits: Array(n).fill(0), shockedTicks: Array(n).fill(0) })

/** `runFight` with `team` bot players. With team 1 it replays runFight's fight
 * tick for tick. The fight is lost once every player is down. */
export const teamFight = (arena: string, build: CensusBuild, seed: number, team: Team): TeamFightResult => {
  const spec = ARENAS[arena]
  if (!spec) throw new Error(`probe: unknown arena "${arena}"`)
  const w = newRun(seed, build.sequenced)
  applyScenario(w, arena)
  const first = teamOf(w)[0]
  if (!first) throw new Error('probe: the run has no player')
  if (team === 2) addTeammate(w, first, roomAlongX(w))
  const players = teamOf(w)
  for (const p of players) for (const mod of build.mods) runVerb(w, `addMod ${p.id} ${mod}`)
  const staged = livingFoes(w)
  const want = spec.foes.reduce((n, f) => n + f.count, 0)
  if (staged.length !== want) throw new Error(`probe: ${arena} on seed ${seed} staged ${staged.length} of ${want} foes`)
  const floor = w.floor
  const tally = emptyTally(players.length)
  const prevHp = players.map((p) => p.health!.hp)
  for (let t = 0; ; t++) {
    if (w.floor !== floor) throw new Error(`probe: ${arena} on seed ${seed} left floor ${floor} at tick ${t}`)
    const won = staged.every((e) => e.dead || e.health!.hp <= 0)
    const down = players.every((p) => p.dead || p.playerCtl!.downed)
    const outcome: Outcome | undefined = won ? 'won' : down ? 'downed' : t >= FIGHT_TICKS ? 'timeout' : undefined
    if (outcome) return { arena, build: build.name, seed, team, outcome, ticks: t, ...tally }
    stepAndTally(w, players, tally, prevHp, true)
  }
}

/** Players hold still for STUN_PROBE_TICKS while one NPC armed with a stun
 * gun, STUN_GUNNER_DIST tiles off, fights them. On flooded ground the players
 * and the gunner are wet. */
export const stunProbe = (seed: number, ground: StunGround, team: Team): StunProbeResult => {
  const w = newRun(seed, false)
  const street = ground === 'flooded street'
  stageArena(w, { question: 'stun probe', foes: [], tide: ground === 'flooded room' }, street ? openStreetRow(w, STUN_GUNNER_DIST + 2) : undefined)
  if (street) startFloorModifier(w, 'bogTide', TIDE_ARENA_AGE)
  const alongX = street || roomAlongX(w)
  const first = teamOf(w)[0]
  if (!first) throw new Error('probe: the run has no player')
  if (team === 2) addTeammate(w, first, alongX)
  const players = teamOf(w)
  const gx = first.pos.x + (alongX ? STUN_GUNNER_DIST : 0)
  const gy = first.pos.y + (alongX ? 0 : STUN_GUNNER_DIST)
  if (isSolidTile(w.level, Math.floor(gx), Math.floor(gy))) throw new Error(`probe: seed ${seed} has a wall where the stun gunner stands`)
  const gunner = spawnNpc(w, 'gangster', gx, gy)
  gunner.combat!.weapon = 'stunGun'
  gunner.loadout = npcLoadout('stunGun')
  const shots = new Set<number>()
  const tally = emptyTally(players.length)
  const prevHp = players.map((p) => p.health!.hp)
  const downedAt: (number | undefined)[] = players.map(() => undefined)
  for (let t = 0; t < STUN_PROBE_TICKS; t++) {
    stepAndTally(w, players, tally, prevHp, false)
    for (const e of w.entities) if (e.projectile?.ownerId === gunner.id) shots.add(e.id)
    players.forEach((p, i) => {
      if (downedAt[i] === undefined && (p.dead || p.playerCtl!.downed)) downedAt[i] = t + 1
    })
  }
  return { seed, ground, team, shots: shots.size, downedAt, ...tally }
}

export interface RangeFightResult {
  seed: number
  distance: number
  build: string
  outcome: Outcome
  ticks: number
  damage: number
  /** Tick a gangster first fired, if one did. */
  firstReply?: number
}

/** arena-kiter's three gangsters, staged `distance` tiles down an open street
 * row (past the 8 tiles they can see) against the census bot. */
export const kiterAtRange = (seed: number, distance: number, build: CensusBuild): RangeFightResult => {
  const w = newRun(seed, build.sequenced)
  stageArena(w, { question: 'kiter at range', foes: [] }, openStreetRow(w, distance + 2))
  const me = teamOf(w)[0]
  if (!me) throw new Error('probe: the run has no player')
  for (const mod of build.mods) runVerb(w, `addMod ${me.id} ${mod}`)
  const foes = [0, -1, 1].map((dy) => spawnNpc(w, 'gangster', me.pos.x + distance, me.pos.y + dy))
  const ids = new Set(foes.map((f) => f.id))
  const tally = emptyTally(1)
  const prevHp = [me.health!.hp]
  let firstReply: number | undefined
  for (let t = 0; ; t++) {
    const won = foes.every((e) => e.dead || e.health!.hp <= 0)
    const down = me.dead || me.playerCtl!.downed
    const outcome: Outcome | undefined = won ? 'won' : down ? 'downed' : t >= FIGHT_TICKS ? 'timeout' : undefined
    if (outcome) return { seed, distance, build: build.name, outcome, ticks: t, damage: tally.damage[0], firstReply }
    stepAndTally(w, [me], tally, prevHp, true)
    if (firstReply === undefined && w.entities.some((e) => e.projectile && ids.has(e.projectile.ownerId))) firstReply = t
  }
}
