// The PURE computation core of the live-play observation recorder
// (tools/observer/recorder.ts). Everything here is a plain function of its
// inputs — no sockets, no filesystem, no Date.now() — so the event-fold, the
// run-record bookkeeping, the wake-event edge-triggering, and the digest
// rendering are all unit-testable with vitest (digest.test.ts, standalone
// config in this directory since the root vitest config only includes src/**).
//
// READ-ONLY by construction: this module only *interprets* state/entity JSON
// replies and pushed sim events; it never issues a verb.

import type { GameInfo } from '../../src/debug/protocol'

// ── Tunables ────────────────────────────────────────────────────────────────
export const SIM_RATE = 30 // ticks/sec (src/game/types.ts SIM_RATE)
export const POLL_MS = 1500
export const HEARTBEAT_MS = 20_000
export const OUTBOX_MS = 1000
export const HISTORY_MS = 40 * 60_000 // in-memory rolling bound (~40 min)
export const RECENT_MS = 60_000 // the digest's LAST 60s window
export const FIGHT_MS = 10_000 // "current fight" rolling window
export const THREAT_RADIUS = 12 // tiles — NPCs this close to a player are threats
export const LOW_HP = 25 // wake when a player's hp crosses below this…
export const REARM_HP = 50 // …re-armed only after recovering above this
export const NEAR_DEATH_HP = 20 // run-ledger "near-death moment" threshold
export const TICK_RESET_SLACK = 300 // tick regression bigger than this = run restart
/** Events claiming a tick this far AHEAD of the target's estimated tick are
 * treated as another game's (the hub fans events out untagged). Behind-events
 * are always accepted: out-of-order delivery and run resets both look "behind". */
export const FOREIGN_AHEAD_TICKS = 1800

// ── Shapes ──────────────────────────────────────────────────────────────────
export interface Vec {
  x: number
  y: number
}

export interface ModSnap {
  id: string
  stacks: number
}

export interface PlayerSnap {
  id: number
  playerId: number
  pos: Vec
  vel: Vec
  intent: Vec
  hp: number
  maxHp: number
  cash: number
  weapon?: string
  mods: ModSnap[]
  status: string[]
  downed: boolean
}

export interface ThreatSnap {
  id: number
  archetype: string
  dist: number
  hp?: number
  maxHp?: number
  mode?: string
  goal?: string
  faction?: string
}

export interface Sample {
  wallMs: number
  tick: number
  seed: number
  floor: number
  alarm: number
  gameOver: boolean
  mission: {
    template?: string
    description?: string
    complete?: boolean
    exitUnlocked?: boolean
    alerted?: boolean
  }
  players: PlayerSnap[]
  threats: ThreatSnap[]
  frozen: boolean
}

/** id → kind/archetype, from the full entity poll — what lets a bare `death`
 * event (which carries only an id) be attributed to an archetype. */
export interface IndexEntry {
  id: number
  kind: string
  archetype: string
}

export interface Wake {
  kind: string
  tick: number
  detail: string
}

export interface FloorRecord {
  floor: number
  entryTick: number
  template?: string
  description?: string
  completeTick?: number
  /** First tick the alarm was seen at max (3) this floor. */
  alarm3Tick?: number
  /** Objective-gate breach (`bossDoorBreached`) tick. */
  breachTick?: number
  /** Station-alert escalation tick. */
  alertTick?: number
}

export interface RunRecord {
  seed: number
  startTick: number
  startWallMs: number
  lastTick: number
  floors: FloorRecord[]
  kills: Record<string, number>
  killsTotal: number
  dmgTaken: number
  dmgDealt: number
  dmgTakenLog: { tick: number; amount: number }[]
  nearDeaths: { tick: number; hp: number }[]
  modPickups: { tick: number; modId: string; weapon: string }[]
  weaponChanges: { tick: number; playerId: number; from: string; to: string }[]
  cashLog: { tick: number; cash: number }[]
  peakModStacks: number
  playerDeaths: number
  gameOverTick?: number
  endWallMs?: number
  endCause?: string
  /** Distinct 8x8-tile quadrants visited, keyed `floor:qx,qy`. */
  coverage: Set<string>
}

interface RecentLine {
  wallMs: number
  tick: number
  text: string
  wake?: boolean
}

export interface SessionState {
  runs: RunRecord[] // completed runs, oldest first
  run: RunRecord | null // the run in progress
  lastSample?: Sample
  prevPlayers: Map<number, PlayerSnap>
  playerIds: Set<number>
  archetypes: Map<number, { kind: string; archetype: string }>
  lowHpArmed: Map<number, boolean>
  bosses: Map<number, { maxHp: number; hp: number; halfFired: boolean }>
  recentLines: RecentLine[]
  hpSeries: { wallMs: number; tick: number; hp: number; max: number }[]
  trail: { wallMs: number; tick: number; x: number; y: number }[]
  goalChanges: { wallMs: number; goal: string }[]
  fight: { wallMs: number; tick: number; dir: 'in' | 'out'; amount: number; otherId: number }[]
  malformedEvents: number
  foreignEvents: number
  eventCount: number
  frozen: boolean
  noGame?: string
}

export const createSession = (): SessionState => ({
  runs: [],
  run: null,
  prevPlayers: new Map(),
  playerIds: new Set(),
  archetypes: new Map(),
  lowHpArmed: new Map(),
  bosses: new Map(),
  recentLines: [],
  hpSeries: [],
  trail: [],
  goalChanges: [],
  fight: [],
  malformedEvents: 0,
  foreignEvents: 0,
  eventCount: 0,
  frozen: false,
})

// ── Small pure helpers ──────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const strOr = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const r2 = (n: number): number => Math.round(n * 100) / 100

/** `2026-08-22T17:31:02Z` — the "iso-ish" stamp wake lines and the digest use. */
export const isoStamp = (wallMs: number): string => new Date(wallMs).toISOString().replace(/\.\d{3}Z$/, 'Z')

export const formatWakeLine = (w: Wake, wallMs: number): string =>
  `${isoStamp(wallMs)} t${w.tick} EVENT ${w.kind} ${w.detail}`

/** Where is the target's sim clock, probably, right now? Frozen worlds hold. */
export const estimateTick = (s: SessionState, nowMs: number): number => {
  if (!s.lastSample) return 0
  if (s.lastSample.frozen || s.lastSample.gameOver) return s.lastSample.tick
  return Math.round(s.lastSample.tick + ((nowMs - s.lastSample.wallMs) * SIM_RATE) / 1000)
}

/** Choose the game to observe: a real-time game (ticking !== null — the headless
 * harness reports no tick), preferring live+ticking, then live-but-frozen (a
 * tabbed-out browser is still the player's game), then anything real-time.
 * Ties go to the most recently heard from, then the furthest-advanced tick. */
export const pickTarget = (games: GameInfo[]): GameInfo | null => {
  const real = games.filter((g) => g.ticking !== null)
  if (real.length === 0) return null
  const rank = (g: GameInfo): number => (g.live && g.ticking ? 0 : g.live ? 1 : 2)
  return [...real].sort(
    (a, b) => rank(a) - rank(b) || a.lastSeenMs - b.lastSeenMs || (b.tick ?? 0) - (a.tick ?? 0),
  )[0]
}

// ── Extraction: raw verb replies → one compact Sample ───────────────────────
const vec = (v: unknown): Vec => (isObj(v) ? { x: r2(numOr(v.x, 0)), y: r2(numOr(v.y, 0)) } : { x: 0, y: 0 })

const playerStatus = (e: Record<string, unknown>, tick: number): string[] => {
  const out: string[] = []
  const ctl = isObj(e.playerCtl) ? e.playerCtl : undefined
  if (ctl?.downed) out.push('DOWNED')
  const st = isObj(e.status) ? e.status : undefined
  if (numOr(st?.stun, 0) > 0) out.push('stunned')
  if (numOr(st?.sleep, 0) > 0) out.push('asleep')
  const fx = isObj(e.fx) ? e.fx : undefined
  if (fx) for (const k of Object.keys(fx)) if (numOr((fx[k] as Record<string, unknown>)?.until, 0) > tick) out.push(k)
  const roll = isObj(ctl?.roll) ? (ctl.roll as Record<string, unknown>) : undefined
  if (roll && numOr(roll.untilTick, 0) > tick) out.push('rolling')
  const chan = isObj(ctl?.channel) ? (ctl.channel as Record<string, unknown>) : undefined
  if (chan) out.push(strOr(chan.kind, 'channeling'))
  return out
}

const playerMods = (e: Record<string, unknown>): ModSnap[] => {
  const lo = isObj(e.loadout) ? e.loadout : undefined
  const inv = Array.isArray(lo?.inventory) ? (lo.inventory as unknown[]) : []
  const slot = numOr(lo?.activeSlot, -1)
  const stack = slot >= 0 && isObj(inv[slot]) ? (inv[slot] as Record<string, unknown>) : undefined
  const mods = Array.isArray(stack?.mods) ? (stack.mods as unknown[]) : []
  return mods
    .filter(isObj)
    .map((m) => ({ id: strOr(m.id, '?'), stacks: numOr(m.stacks, 1) }))
}

/** Fold the `state` + `entities` replies into one compact Sample plus an id →
 * kind/archetype index (kept out of the Sample so timeline lines stay small). */
export const extractSample = (
  stateJson: unknown,
  entitiesJson: unknown,
  wallMs: number,
  frozen: boolean,
): { sample: Sample; index: IndexEntry[] } => {
  const st = isObj(stateJson) ? stateJson : {}
  const tick = numOr(st.tick, 0)
  const mission = isObj(st.mission) ? st.mission : {}
  const ents = (Array.isArray(entitiesJson) ? entitiesJson : []).filter(isObj)

  const index: IndexEntry[] = ents.map((e) => ({
    id: numOr(e.id, -1),
    kind: strOr(e.kind, '?'),
    archetype: strOr(e.archetype, '?'),
  }))

  const players: PlayerSnap[] = ents
    .filter((e) => e.kind === 'player' && !e.dead)
    .map((e) => {
      const ctl = isObj(e.playerCtl) ? e.playerCtl : {}
      const health = isObj(e.health) ? e.health : {}
      const combat = isObj(e.combat) ? e.combat : {}
      return {
        id: numOr(e.id, -1),
        playerId: numOr(ctl.playerId, 0),
        pos: vec(e.pos),
        vel: vec(e.vel),
        intent: vec(e.intent),
        hp: numOr(health.hp, 0),
        maxHp: numOr(health.max, 0),
        cash: numOr(ctl.cash, 0),
        weapon: typeof combat.weapon === 'string' ? combat.weapon : undefined,
        mods: playerMods(e),
        status: playerStatus(e, tick),
        downed: !!ctl.downed,
      }
    })
    .sort((a, b) => a.playerId - b.playerId)

  const distToNearestPlayer = (p: Vec): number => {
    let best = Infinity
    for (const pl of players) best = Math.min(best, Math.hypot(pl.pos.x - p.x, pl.pos.y - p.y))
    return best
  }

  const threats: ThreatSnap[] = ents
    .filter((e) => e.kind === 'npc' && !e.dead)
    .map((e) => {
      const ai = isObj(e.ai) ? e.ai : {}
      const health = isObj(e.health) ? e.health : {}
      return {
        id: numOr(e.id, -1),
        archetype: strOr(e.archetype, '?'),
        dist: r2(distToNearestPlayer(vec(e.pos))),
        hp: isObj(e.health) ? numOr(health.hp, 0) : undefined,
        maxHp: isObj(e.health) ? numOr(health.max, 0) : undefined,
        mode: typeof ai.mode === 'string' ? ai.mode : undefined,
        goal: typeof ai.goal === 'string' ? ai.goal : undefined,
        faction: typeof ai.faction === 'string' ? ai.faction : undefined,
      }
    })
    // Bosses stay visible however far away — the boss-half wake needs their hp.
    .filter((t) => t.dist <= THREAT_RADIUS || t.archetype === 'boss')
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 16)

  return {
    sample: {
      wallMs,
      tick,
      seed: numOr(st.seed, 0),
      floor: numOr(st.floor, 0),
      alarm: numOr(st.alarm, 0),
      gameOver: !!st.gameOver,
      mission: {
        template: typeof mission.template === 'string' ? mission.template : undefined,
        description: typeof mission.description === 'string' ? mission.description : undefined,
        complete: typeof mission.complete === 'boolean' ? mission.complete : undefined,
        exitUnlocked: typeof mission.exitUnlocked === 'boolean' ? mission.exitUnlocked : undefined,
        alerted: mission.alertTick !== undefined,
      },
      players,
      threats,
      frozen,
    },
    index,
  }
}

export const updateIndex = (s: SessionState, index: IndexEntry[]): void => {
  for (const e of index) {
    s.archetypes.set(e.id, { kind: e.kind, archetype: e.archetype })
    if (e.kind === 'player') s.playerIds.add(e.id)
  }
}

// ── The fold: samples & events → run records + wakes + terse lines ──────────
const line = (s: SessionState, wallMs: number, tick: number, text: string, wake = false): void => {
  s.recentLines.push({ wallMs, tick, text, wake })
  if (s.recentLines.length > 400) s.recentLines.splice(0, s.recentLines.length - 400)
}

const emitWake = (s: SessionState, wakes: Wake[], wallMs: number, kind: string, tick: number, detail: string): void => {
  wakes.push({ kind, tick, detail })
  line(s, wallMs, tick, `WAKE ${kind} ${detail}`, true)
}

const newRun = (seed: number, tick: number, wallMs: number): RunRecord => ({
  seed,
  startTick: tick,
  startWallMs: wallMs,
  lastTick: tick,
  floors: [],
  kills: {},
  killsTotal: 0,
  dmgTaken: 0,
  dmgDealt: 0,
  dmgTakenLog: [],
  nearDeaths: [],
  modPickups: [],
  weaponChanges: [],
  cashLog: [],
  peakModStacks: 0,
  playerDeaths: 0,
  coverage: new Set(),
})

const currentFloor = (run: RunRecord): FloorRecord | undefined => run.floors[run.floors.length - 1]

const endRun = (s: SessionState, wallMs: number, cause: string): void => {
  if (!s.run) return
  s.run.endWallMs = wallMs
  s.run.endCause = s.run.gameOverTick !== undefined ? 'gameOver' : cause
  s.runs.push(s.run)
  if (s.runs.length > 50) s.runs.splice(0, s.runs.length - 50)
  s.run = null
}

const startRun = (s: SessionState, seed: number, floor: number, tick: number, wallMs: number): void => {
  s.run = newRun(seed, tick, wallMs)
  s.run.floors.push({ floor, entryTick: tick })
  s.lowHpArmed.clear()
  s.bosses.clear()
  s.prevPlayers.clear()
}

const noteFloor = (s: SessionState, wakes: Wake[], floor: number, tick: number, wallMs: number): void => {
  if (!s.run) return
  const cur = currentFloor(s.run)
  if (cur && cur.floor === floor) return
  s.run.floors.push({ floor, entryTick: tick })
  emitWake(s, wakes, wallMs, 'floorChange', tick, `floor ${cur ? `${cur.floor}→` : ''}${floor}`)
}

const noteMissionComplete = (s: SessionState, wakes: Wake[], tick: number, wallMs: number, desc: string): void => {
  const fl = s.run ? currentFloor(s.run) : undefined
  if (!fl || fl.completeTick !== undefined) return
  fl.completeTick = tick
  emitWake(s, wakes, wallMs, 'missionComplete', tick, desc)
}

const prune = (s: SessionState, nowMs: number): void => {
  const drop = <T extends { wallMs: number }>(arr: T[], keepMs: number, cap: number): void => {
    const cut = nowMs - keepMs
    let i = 0
    while (i < arr.length && arr[i].wallMs < cut) i++
    if (i > 0) arr.splice(0, i)
    if (arr.length > cap) arr.splice(0, arr.length - cap)
  }
  drop(s.hpSeries, HISTORY_MS, 2000)
  drop(s.trail, 30_000, 200)
  drop(s.goalChanges, RECENT_MS, 500)
  drop(s.fight, FIGHT_MS, 500)
  drop(s.recentLines, HISTORY_MS, 400)
}

/** Fold one poll sample into the session. Returns the wake events it produced.
 * Handles: seed change (new run), same-seed tick reset (restart), floor/alarm/
 * mission/gameOver transitions, hp low-water wakes with hysteresis, near-death
 * ledger, build timeline (mods/weapon/cash), movement coverage + trail. */
export const applySample = (s: SessionState, sample: Sample): Wake[] => {
  const wakes: Wake[] = []
  const { wallMs, tick } = sample
  const prev = s.lastSample

  // Run identity: a seed change is a new run; so is a big tick regression on
  // the same seed (the player restarted and rolled the same seed).
  const restarted = s.run && s.run.seed === sample.seed && tick < s.run.lastTick - TICK_RESET_SLACK
  if (!s.run || s.run.seed !== sample.seed || restarted) {
    const hadRun = s.run !== null || prev !== undefined
    if (s.run) endRun(s, wallMs, restarted ? 'restart' : 'reset')
    startRun(s, sample.seed, sample.floor, tick, wallMs)
    if (hadRun)
      emitWake(s, wakes, wallMs, 'seedChange', tick, restarted ? `run restart (same seed ${sample.seed})` : `new run seed ${sample.seed}`)
  }
  const run = s.run
  if (!run) return wakes // unreachable; keeps TS honest
  run.lastTick = Math.max(run.lastTick, tick)

  noteFloor(s, wakes, sample.floor, tick, wallMs)
  const fl = currentFloor(run)
  if (fl) {
    if (sample.mission.template) fl.template = sample.mission.template
    if (sample.mission.description) fl.description = sample.mission.description
    if (sample.alarm >= 3 && fl.alarm3Tick === undefined) fl.alarm3Tick = tick
  }

  if (prev && prev.seed === sample.seed && prev.alarm !== sample.alarm)
    emitWake(s, wakes, wallMs, 'alarmChange', tick, `alarm ${prev.alarm}→${sample.alarm}`)

  // Mission completion via the state flag — TRANSITION-triggered (false→true),
  // because a fresh default world reports complete:true before the mission
  // generator has run; the missionComplete event also lands here via its latch.
  if (prev && prev.seed === sample.seed && prev.mission.complete === false && sample.mission.complete === true)
    noteMissionComplete(s, wakes, tick, wallMs, sample.mission.description ?? 'objective met')

  if (sample.gameOver && run.gameOverTick === undefined) {
    run.gameOverTick = tick
    emitWake(s, wakes, wallMs, 'gameOver', tick, `run over on floor ${sample.floor}`)
  }

  // Players: hp wake hysteresis, near-death ledger, build timeline, movement.
  for (const p of sample.players) {
    s.playerIds.add(p.id)
    s.archetypes.set(p.id, { kind: 'player', archetype: 'player' })
    const prevP = s.prevPlayers.get(p.id)

    const armed = s.lowHpArmed.get(p.id) ?? true
    if (armed && p.maxHp > 0 && p.hp < LOW_HP) {
      s.lowHpArmed.set(p.id, false)
      emitWake(s, wakes, wallMs, 'lowHp', tick, `P${p.playerId} hp ${p.hp}/${p.maxHp}`)
    } else if (!armed && p.hp > REARM_HP) {
      s.lowHpArmed.set(p.id, true)
    }

    if (p.hp < NEAR_DEATH_HP && (!prevP || prevP.hp >= NEAR_DEATH_HP)) run.nearDeaths.push({ tick, hp: p.hp })
    if (run.nearDeaths.length > 100) run.nearDeaths.splice(0, run.nearDeaths.length - 100)

    if (prevP && prevP.weapon !== p.weapon) {
      run.weaponChanges.push({ tick, playerId: p.playerId, from: prevP.weapon ?? 'fists', to: p.weapon ?? 'fists' })
      line(s, wallMs, tick, `P${p.playerId} weapon ${prevP.weapon ?? 'fists'} → ${p.weapon ?? 'fists'}`)
    }
    if (!prevP || prevP.cash !== p.cash) {
      run.cashLog.push({ tick, cash: p.cash })
      if (run.cashLog.length > 400) run.cashLog.splice(0, run.cashLog.length - 400)
    }
    if (prevP && !prevP.downed && p.downed) emitWake(s, wakes, wallMs, 'playerDowned', tick, `P${p.playerId} DOWNED`)

    const stacks = p.mods.reduce((n, m) => n + m.stacks, 0)
    if (stacks > run.peakModStacks) run.peakModStacks = stacks

    run.coverage.add(`${sample.floor}:${Math.floor(p.pos.x / 8)},${Math.floor(p.pos.y / 8)}`)
    s.prevPlayers.set(p.id, p)
  }

  const p0 = sample.players[0]
  if (p0) {
    s.hpSeries.push({ wallMs, tick, hp: p0.hp, max: p0.maxHp })
    s.trail.push({ wallMs, tick, x: p0.pos.x, y: p0.pos.y })
  }

  // Bosses seen in the threat extraction: track hp for the half-health wake.
  for (const t of sample.threats) {
    s.archetypes.set(t.id, { kind: 'npc', archetype: t.archetype })
    if (t.archetype === 'boss' && t.hp !== undefined && t.maxHp !== undefined && t.maxHp > 0) {
      const b = s.bosses.get(t.id) ?? { maxHp: t.maxHp, hp: t.hp, halfFired: false }
      b.maxHp = t.maxHp
      b.hp = t.hp
      if (!b.halfFired && b.hp < b.maxHp / 2) {
        b.halfFired = true
        emitWake(s, wakes, wallMs, 'bossHalf', tick, `boss#${t.id} hp ${b.hp}/${b.maxHp}`)
      }
      s.bosses.set(t.id, b)
    }
  }

  if (s.frozen !== sample.frozen) {
    s.frozen = sample.frozen
    line(s, wallMs, tick, sample.frozen ? 'game FROZEN (tick stalled — tabbed out?)' : 'game resumed ticking')
  }

  s.lastSample = sample
  s.noGame = undefined
  prune(s, wallMs)
  return wakes
}

/** Fold one pushed sim event (`{tick, ...SimEvent}`) into the session. Unknown
 * event types get a generic line; malformed payloads are counted and skipped;
 * events claiming a tick far AHEAD of the target's clock are counted as another
 * game's (the hub fans all games' events to every debugger, untagged). */
export const applyEvent = (s: SessionState, raw: unknown, wallMs: number): Wake[] => {
  if (!isObj(raw) || typeof raw.type !== 'string' || typeof raw.tick !== 'number' || !Number.isFinite(raw.tick)) {
    s.malformedEvents++
    return []
  }
  const tick = raw.tick
  if (s.lastSample && tick > estimateTick(s, wallMs) + FOREIGN_AHEAD_TICKS) {
    s.foreignEvents++
    return []
  }
  s.eventCount++
  const wakes: Wake[] = []
  const run = s.run
  const who = (id: unknown): string => {
    const n = numOr(id, -1)
    const a = s.archetypes.get(n)
    return a ? `${a.archetype}#${n}` : `#${n}`
  }

  switch (raw.type) {
    case 'death': {
      const id = numOr(raw.entityId, -1)
      const a = s.archetypes.get(id)
      if (s.playerIds.has(id) || a?.kind === 'player') {
        if (run) run.playerDeaths++
        emitWake(s, wakes, wallMs, 'playerDeath', tick, `player ${who(id)} died`)
      } else if (a?.kind === 'npc' || a === undefined) {
        // Unknown ids are counted as kills too — an NPC can spawn and die
        // entirely between two polls (never indexed) and must not be lost.
        const arch = a?.archetype ?? 'unknown'
        if (run) {
          run.kills[arch] = (run.kills[arch] ?? 0) + 1
          run.killsTotal++
        }
        line(s, wallMs, tick, `kill ${arch}#${id}`)
      } else {
        line(s, wallMs, tick, `destroyed ${who(id)}`)
      }
      break
    }
    case 'hit': {
      const targetId = numOr(raw.targetId, -1)
      const amount = numOr(raw.amount, 0)
      const a = s.archetypes.get(targetId)
      if (s.playerIds.has(targetId) || a?.kind === 'player') {
        if (run) {
          run.dmgTaken += amount
          run.dmgTakenLog.push({ tick, amount })
          if (run.dmgTakenLog.length > 2000) run.dmgTakenLog.splice(0, run.dmgTakenLog.length - 2000)
        }
        s.fight.push({ wallMs, tick, dir: 'in', amount, otherId: targetId })
        line(s, wallMs, tick, `HIT taken -${amount} (${who(targetId)})`)
      } else {
        // Attribution is approximate: hit events carry no source, so NPC-vs-NPC
        // damage is counted here too (the digest legend says so).
        if (run) run.dmgDealt += amount
        s.fight.push({ wallMs, tick, dir: 'out', amount, otherId: targetId })
        const b = s.bosses.get(targetId)
        if (b) {
          b.hp = Math.max(0, b.hp - amount)
          if (!b.halfFired && b.hp < b.maxHp / 2) {
            b.halfFired = true
            emitWake(s, wakes, wallMs, 'bossHalf', tick, `boss#${targetId} hp ~${b.hp}/${b.maxHp}`)
          }
        }
      }
      break
    }
    case 'modPickup': {
      const modId = strOr(raw.modId, '?')
      const weapon = strOr(raw.weapon, '?')
      if (run) {
        run.modPickups.push({ tick, modId, weapon })
        if (run.modPickups.length > 200) run.modPickups.splice(0, run.modPickups.length - 200)
      }
      line(s, wallMs, tick, `mod ${modId} → ${weapon}${raw.maxed ? ' (maxed, no-op)' : ''}`)
      break
    }
    case 'pickup':
      line(s, wallMs, tick, `pickup ${strOr(raw.itemId, '?')} by ${who(raw.byId)}`)
      break
    case 'weaponDrop':
      line(s, wallMs, tick, `weapon drop ${strOr(raw.itemId, '?')} from ${who(raw.fromId)}`)
      break
    case 'missionComplete':
      noteMissionComplete(s, wakes, tick, wallMs, strOr(raw.description, 'objective met'))
      break
    case 'stationAlert': {
      const fl = run ? currentFloor(run) : undefined
      if (fl && fl.alertTick === undefined) fl.alertTick = tick
      line(s, wallMs, tick, `STATION ALERT — ${numOr(raw.hunters, 0)} hunters, ${numOr(raw.doorsOpened, 0)} doors popped`)
      break
    }
    case 'bossDoorBreached': {
      const fl = run ? currentFloor(run) : undefined
      if (fl && fl.breachTick === undefined) fl.breachTick = tick
      line(s, wallMs, tick, `objective gate BREACHED (${who(raw.entityId)})`)
      break
    }
    case 'bossReveal': {
      const id = numOr(raw.entityId, -1)
      const maxHp = numOr(raw.maxHp, 0)
      if (!s.bosses.has(id)) s.bosses.set(id, { maxHp, hp: maxHp, halfFired: false })
      line(s, wallMs, tick, `BOSS revealed #${id} (${maxHp}hp)`)
      break
    }
    case 'floorChange':
      noteFloor(s, wakes, numOr(raw.floor, 0), tick, wallMs)
      break
    case 'aiGoal':
      s.goalChanges.push({ wallMs, goal: strOr(raw.goal, '?') })
      break
    case 'runOver':
      line(s, wallMs, tick, `runOver (floor ${numOr(raw.floor, 0)})`)
      break
    case 'powerCut':
      line(s, wallMs, tick, `power CUT to wing ${strOr(raw.wing, '?')} by ${who(raw.byId)}`)
      break
    case 'sealOpen':
      line(s, wallMs, tick, `seal opened via ${strOr(raw.via, '?')} (${who(raw.entityId)})`)
      break
    case 'sealDenied':
      line(s, wallMs, tick, `seal DENIED (${strOr(raw.sealKind, '?')}) to ${who(raw.byId)}`)
      break
    case 'bloom':
      line(s, wallMs, tick, `spore node BLOOMED (${who(raw.entityId)}) — room flooding`)
      break
    case 'doorBreach':
      line(s, wallMs, tick, `door blown open (${who(raw.entityId)})`)
      break
    case 'doorsReleased':
      line(s, wallMs, tick, `${numOr(raw.count, 0)} doors released`)
      break
    case 'explosion':
      line(s, wallMs, tick, `explosion r${numOr(raw.radius, 0)} @ (${r2(numOr(raw.x, 0))},${r2(numOr(raw.y, 0))})`)
      break
    case 'woke':
      line(s, wallMs, tick, `${who(raw.entityId)} WOKE (by ${strOr(raw.by, '?')})`)
      break
    case 'alerted':
      line(s, wallMs, tick, `${who(raw.entityId)} alerted to hunt ${who(raw.targetId)} (tipped by ${who(raw.byId)})`)
      break
    case 'barricade':
      line(s, wallMs, tick, `barricade built by ${who(raw.byId)}`)
      break
    case 'burnDoused':
      line(s, wallMs, tick, `${who(raw.entityId)} doused burn (${numOr(raw.remainingTicks, 0)} ticks left)`)
      break
    case 'pickStart':
      line(s, wallMs, tick, `${who(raw.byId)} lockpicking ${who(raw.entityId)} (${numOr(raw.ticks, 0)} ticks)`)
      break
    case 'pickCancel':
      line(s, wallMs, tick, `lockpick cancelled (${strOr(raw.reason, '?')})`)
      break
    // High-frequency noise — aggregated (aiGoal) or ignored entirely.
    case 'noise':
    case 'roll':
    case 'shock':
    case 'shatter':
    case 'use':
    case 'doorToggle':
    case 'doorBlocked':
      break
    default:
      // Unknown/future event type: keep a line so nothing vanishes silently.
      line(s, wallMs, tick, `event ${raw.type}`)
  }
  if (run) run.lastTick = Math.max(run.lastTick, tick)
  prune(s, wallMs)
  return wakes
}

// ── Rendering ───────────────────────────────────────────────────────────────
const BLOCKS = '▁▂▃▄▅▆▇█'

/** Map values (0..max) to block characters. NaN/absent → '·'. */
export const sparkline = (values: number[], max: number): string => {
  if (max <= 0) return values.map(() => '·').join('')
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return '·'
      const r = Math.max(0, Math.min(1, v / max))
      return BLOCKS[Math.round(r * (BLOCKS.length - 1))]
    })
    .join('')
}

const mins = (ticks: number): string => `${(ticks / SIM_RATE / 60).toFixed(1)}m`
const fmtVec = (v: Vec): string => `(${v.x.toFixed(1)},${v.y.toFixed(1)})`

const runSummaryLine = (r: RunRecord): string => {
  const floors = r.floors.map((f) => f.floor)
  const floorSpan = floors.length ? `${floors[0]}→${floors[floors.length - 1]}` : '-'
  return `seed ${r.seed} · ${mins(r.lastTick - r.startTick)} · floors ${floorSpan} · end: ${r.endCause ?? 'in progress'} · kills ${r.killsTotal} · deaths ${r.playerDeaths} · dmg in/out ${r.dmgTaken}/${r.dmgDealt} · peak mod stacks ${r.peakModStacks}`
}

/** Render the whole digest — the ONE file the observer reads per wake-up. */
export const renderDigest = (s: SessionState, nowMs: number): string => {
  const out: string[] = []
  out.push(`# Sporefall live observer digest`)
  out.push(`updated ${isoStamp(nowMs)} · events folded ${s.eventCount} (malformed ${s.malformedEvents}, foreign-skipped ${s.foreignEvents})`)
  out.push('')

  const sm = s.lastSample
  out.push(`## NOW`)
  if (s.noGame || !sm) {
    out.push(s.noGame ?? 'no sample yet — waiting for the first poll')
    out.push('')
  } else {
    const age = ((nowMs - sm.wallMs) / 1000).toFixed(1)
    const m = sm.mission
    out.push(`- tick ${sm.tick} · seed ${sm.seed} · floor ${sm.floor} · alarm ${sm.alarm}/3 · gameOver ${sm.gameOver ? 'YES' : 'no'} · sampled ${age}s ago`)
    out.push(`- mission: ${m.template ?? '?'} — "${m.description ?? '?'}" · complete ${m.complete ? 'YES' : 'no'} · exit ${m.exitUnlocked ? 'UNLOCKED' : 'locked'} · stationAlert ${m.alerted ? 'YES' : 'no'}`)
    out.push(`- frozen: ${sm.frozen ? 'YES — tick not advancing (tabbed out?); heartbeat paused' : 'no'}`)
    if (sm.players.length === 0) out.push(`- players: NONE VISIBLE`)
    for (const p of sm.players) {
      const mods = p.mods.length ? ` [${p.mods.map((mo) => `${mo.id}×${mo.stacks}`).join(', ')}]` : ''
      const st = p.status.length ? ` · status: ${p.status.join(',')}` : ''
      out.push(`- P${p.playerId} #${p.id}: hp ${p.hp}/${p.maxHp} · pos ${fmtVec(p.pos)} · vel ${fmtVec(p.vel)} · intent ${fmtVec(p.intent)} · cash ${p.cash} · weapon ${p.weapon ?? 'fists'}${mods}${st}`)
    }
    const th = sm.threats
    if (th.length === 0) out.push(`- threats: none within ${THREAT_RADIUS} tiles`)
    else
      out.push(`- threats (${th.length}): ${th.map((t) => `${t.archetype}#${t.id} d${t.dist.toFixed(1)} ${t.mode ?? '?'}${t.goal ? `/${t.goal}` : ''}${t.faction ? ` ${t.faction}` : ''}${t.hp !== undefined ? ` hp${t.hp}` : ''}`).join(' · ')}`)
    const fin = s.fight.filter((f) => f.dir === 'in' && f.wallMs >= nowMs - FIGHT_MS)
    const fout = s.fight.filter((f) => f.dir === 'out' && f.wallMs >= nowMs - FIGHT_MS)
    if (fin.length || fout.length) {
      const dmgIn = fin.reduce((n, f) => n + f.amount, 0)
      const dmgOut = fout.reduce((n, f) => n + f.amount, 0)
      const attackers = sm.threats.filter((t) => t.mode === 'aggro').map((t) => `${t.archetype}#${t.id}`)
      out.push(`- FIGHT (last 10s): dmg in ${dmgIn} (${fin.length} hits) · dmg out ${dmgOut} (${fout.length} hits)${attackers.length ? ` · aggro: ${attackers.join(', ')}` : ''} (out-attribution approximate — hits carry no source)`)
    } else out.push(`- fight: none in the last 10s`)
    if (s.trail.length > 1) {
      const step = Math.max(1, Math.floor(s.trail.length / 8))
      const pts = s.trail.filter((_, i) => i % step === 0 || i === s.trail.length - 1)
      out.push(`- trail (30s): ${pts.map((t) => `(${t.x.toFixed(0)},${t.y.toFixed(0)})`).join('→')}`)
    }
    out.push('')
  }

  out.push(`## LAST 60s`)
  const recent = s.recentLines.filter((l) => l.wallMs >= nowMs - RECENT_MS)
  const hp60 = s.hpSeries.filter((h) => h.wallMs >= nowMs - RECENT_MS)
  if (hp60.length > 1) {
    const max = hp60[hp60.length - 1].max || Math.max(...hp60.map((h) => h.hp), 1)
    out.push(`hp ${sparkline(hp60.map((h) => h.hp), max)} (${hp60[0].hp}→${hp60[hp60.length - 1].hp}/${max})`)
  }
  const goals = s.goalChanges.filter((g) => g.wallMs >= nowMs - RECENT_MS)
  if (goals.length) {
    const byGoal: Record<string, number> = {}
    for (const g of goals) byGoal[g.goal] = (byGoal[g.goal] ?? 0) + 1
    out.push(`aiGoal shifts: ${Object.entries(byGoal).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}×${n}`).join(' ')}`)
  }
  if (recent.length === 0) out.push('(quiet)')
  for (const l of recent.slice(-30)) out.push(`t${l.tick} ${l.text}`)
  out.push('')

  out.push(`## THIS RUN`)
  const run = s.run
  if (!run) out.push('(no run in progress)')
  else {
    out.push(`seed ${run.seed} · started t${run.startTick} · ${mins(run.lastTick - run.startTick)} elapsed${run.gameOverTick !== undefined ? ` · GAME OVER t${run.gameOverTick}` : ''}`)
    for (const f of run.floors) {
      const bits = [
        `floor ${f.floor} entry t${f.entryTick}`,
        f.template ? `${f.template} "${f.description ?? ''}"` : undefined,
        f.alarm3Tick !== undefined ? `alarm3 t${f.alarm3Tick}` : undefined,
        f.breachTick !== undefined ? `gate-breach t${f.breachTick}` : undefined,
        f.alertTick !== undefined ? `stationAlert t${f.alertTick}` : undefined,
        f.completeTick !== undefined ? `COMPLETE t${f.completeTick}` : undefined,
      ].filter(Boolean)
      out.push(`- ${bits.join(' · ')}`)
    }
    const kills = Object.entries(run.kills).sort((a, b) => b[1] - a[1])
    out.push(`- kills ${run.killsTotal}: ${kills.length ? kills.map(([a, n]) => `${a}×${n}`).join(' ') : 'none'}`)
    out.push(`- damage: taken ${run.dmgTaken} (${run.dmgTakenLog.length} hits) · dealt ~${run.dmgDealt} (attribution approximate) · near-deaths ${run.nearDeaths.length}${run.nearDeaths.length ? ` (${run.nearDeaths.slice(-5).map((n) => `t${n.tick}@${n.hp}hp`).join(', ')})` : ''} · player deaths ${run.playerDeaths}`)
    out.push(`- build: ${run.modPickups.length ? run.modPickups.map((mp) => `t${mp.tick} ${mp.modId}→${mp.weapon}`).join(' · ') : 'no mods yet'}`)
    if (run.weaponChanges.length) out.push(`- weapons: ${run.weaponChanges.slice(-8).map((wc) => `t${wc.tick} P${wc.playerId} ${wc.from}→${wc.to}`).join(' · ')}`)
    if (run.cashLog.length) {
      const cs = run.cashLog
      out.push(`- cash: ${cs[0].cash} → ${cs[cs.length - 1].cash} (${cs.length} changes)`)
    }
    out.push(`- coverage: ${run.coverage.size} distinct 8×8-tile quadrants visited`)
  }
  out.push('')

  out.push(`## SESSION`)
  if (s.runs.length === 0 && !run) out.push('(no runs yet)')
  for (const r of s.runs) out.push(`- ${runSummaryLine(r)}`)
  if (run) out.push(`- ${runSummaryLine(run)} (current)`)
  out.push('')
  return out.join('\n')
}

// ── Outbox → annotations ────────────────────────────────────────────────────
export interface OutboxAnnotation {
  id: string
  kind: 'text'
  text: string
  x: number
  y: number
  ttlTick: number
}

/** Turn the outbox file's content into stacked text-banner annotations (x16,
 * y 110+78·i, ttl tick+1800). Quotes/backslashes are safe because the payload
 * is JSON.stringify-ed at the call site; text is capped under the game's
 * 240-char annotation limit. Stable ids let the recorder clear the previous
 * batch (annotate with a reused id APPENDS — it does not replace). */
export const outboxAnnotations = (content: string, tick: number): OutboxAnnotation[] =>
  content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 8)
    .map((text, i) => ({
      id: `observer-msg-${i}`,
      kind: 'text' as const,
      text: text.slice(0, 200),
      x: 16,
      y: 110 + 78 * i,
      ttlTick: Math.round(tick) + 1800,
    }))
