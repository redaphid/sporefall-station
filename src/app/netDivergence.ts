import { generateLevel } from '../game/levelgen/generate'
import { levelChecksum, type Level } from '../game/levelgen/level'
import type { World } from '../game/world'
import type { RenderView } from './session'

/**
 * HOST↔CLIENT DIVERGENCE DETECTOR — a test-side instrument, not game code.
 *
 * This file is imported ONLY by tests (`*.test.ts`); nothing on the shipped path
 * reaches it, so it never enters the bundle. It also respects the layer boundary:
 * it lives in `src/app/` (not `src/game/`) because it reads a *session's*
 * `RenderView`, which is an app-layer concept.
 *
 * WHY IT EXISTS. This engine is not lockstep — the host is the SOLE simulator
 * (`netHost.tick` → `tickWorld`), and clients never tick the sim (`netClient.ts`
 * imports `moveAndCollide` only, for local prediction). So "desync" here does
 * not mean two diverging PRNG streams. It means the client's *reconstructed
 * view* — the level it regenerated from `seed+floor`, the entity set it kept
 * from the last snapshot, its predicted own position, and the mission/HUD state
 * it mirrors — disagreeing with the host's authoritative world.
 *
 * The nastiest case is invisible: level layout never crosses the wire (it
 * regenerates from `seed+floor`, `netClient.ts` `changeFloor`), so a seed or
 * floor disagreement puts a client on a DIFFERENT MAP with nothing on screen
 * saying so. `level.map` is that check, and it is the reason this instrument
 * exists.
 *
 * HOW TO TRUST IT. A detector that has never fired is worse than none — it
 * manufactures confidence. `netDesync.test.ts` § "the detector itself" feeds it
 * known-divergent pairs (one per issue kind) and asserts each one fires, and
 * feeds it a matched pair and asserts silence. Do not add an issue kind without
 * adding its red-proof.
 */

/** One structural disagreement between the host world and a client's view. */
export type DivergenceKind =
  /** The client's level is not the host's level — different seed and/or floor.
   * The client is walking a different map; nothing on screen reveals it. */
  | 'level.map'
  /** The client's own view is self-inconsistent: the level it drew is not the
   * level for the floor number it is REPORTING (`RenderView.floor` comes from
   * the 2 Hz `StateMsg`, while the level follows snapshots/events at 10 Hz). */
  | 'level.selfInconsistent'
  /** Reported floor number disagrees with the host's floor. */
  | 'floor'
  /** The client has no avatar at all (`RenderView.self` undefined). */
  | 'self.missing'
  /** The client's avatar is a DIFFERENT entity than the host thinks it owns. */
  | 'self.identity'
  /** Predicted own position is further from the host's than prediction allows. */
  | 'self.position'
  /** The client renders an entity the host does not have (or has killed). */
  | 'entity.phantom'
  /** The host has an entity the client should be seeing and is not. */
  | 'entity.missing'
  /** Both sides have the id, but disagree about what it IS. */
  | 'entity.archetype'
  /** Both sides have the id, but disagree about where it is. */
  | 'entity.position'
  /** Mission text / completion disagree. */
  | 'mission'
  /** Run-over state disagrees. */
  | 'gameOver'

/** How much a given kind matters when it shows up in a soak. */
export type DivergenceSeverity = 'fatal' | 'major' | 'minor'

/**
 * `fatal` — the two screens are playing different games and no amount of
 * snapshots re-aligns them by itself.
 * `major` — play-affecting while it lasts (a missed shot, a phantom body).
 * `minor` — a stale number or a smoothing lag; corrects itself on the next
 * message of that class.
 */
export const SEVERITY: Readonly<Record<DivergenceKind, DivergenceSeverity>> = {
  'level.map': 'fatal',
  'self.identity': 'fatal',
  'level.selfInconsistent': 'minor',
  floor: 'minor',
  'self.missing': 'major',
  'self.position': 'major',
  'entity.phantom': 'major',
  'entity.missing': 'major',
  'entity.archetype': 'major',
  'entity.position': 'minor',
  mission: 'minor',
  gameOver: 'major',
}

export interface Divergence {
  kind: DivergenceKind
  severity: DivergenceSeverity
  detail: string
  /** Tiles of disagreement, for the positional kinds. */
  drift?: number
  entityId?: number
}

export interface DivergenceReport {
  /** The host's tick at the moment of comparison. */
  tick: number
  diverged: boolean
  issues: Divergence[]
  /** Worst positional disagreement across every entity both sides can see. */
  maxDrift: number
  /** Positional disagreement on the client's OWN avatar (its prediction error). */
  selfDrift: number
  /**
   * Which `(seed, floor)` pair the client's level actually came from. `'match'`
   * when it is the host's own level; an explicit pair when the client is on a
   * recognisable other floor of a searched seed; `'unknown'` when it matches no
   * searched combination at all (the signature of a genuine SEED mismatch).
   */
  clientLevelOrigin: 'match' | { seed: number; floor: number } | 'unknown'
}

export interface DivergenceOptions {
  /**
   * The host-side entity id of the avatar this client controls
   * (`host.peersBySlot.get(slot)!.entityId`). Without it, self checks are skipped.
   */
  selfEntityId?: number
  /**
   * Tiles the client's predicted own position may lead/lag the host's before it
   * counts. The client predicts at a fixed 4.5 tiles/s while real class speeds
   * vary (`netClient.stepSelf`), and `reconcile` deliberately keeps its own
   * position when the replayed authoritative result lands within 0.5 tiles — so
   * a steady-state offset is EXPECTED here, not a bug. Default 1.5.
   */
  selfTolerance?: number
  /**
   * Tiles a remote entity may lag its host position. Remote entities ease toward
   * their snapshot target at `SMOOTH` per tick and hard-snap past `SNAP_DIST`
   * (2.5), so anything beyond that means the client is not tracking at all.
   * Default 2.5.
   */
  remoteTolerance?: number
  /**
   * Host interest radius (`netHost.INTEREST_RADIUS`). Only host entities well
   * inside it are required to be present on the client. Default 14.
   */
  interestRadius?: number
  /** Margin shaved off `interestRadius` before demanding presence, so entities
   * flapping across the boundary between snapshots are not false positives.
   * Default 3. */
  interestMargin?: number
  /** Host per-snapshot entity cap (`netHost.sendSnapshots`). When the client is
   * at the cap, absence is truncation rather than divergence, so non-player
   * missing-checks are skipped. Default 48. */
  snapshotCap?: number
  /** Floors to search when identifying an unrecognised client level. Default 8. */
  maxFloor?: number
  /** Extra seeds to search besides the host's — pass the pre-restart seed to get
   * "the client is still on seed X" instead of a bare `'unknown'`. */
  candidateSeeds?: readonly number[]
  /** Skip the mission/gameOver comparison. The client mirrors those from the
   * 2 Hz `StateMsg`, so they are legitimately stale between State messages;
   * set this when sampling every tick. Default false. */
  ignoreStaleState?: boolean
}

// Levels are large and immutable once generated; both sides hold the same object
// across many samples, so identity-keyed memoisation makes a per-tick soak cheap.
const checksumByLevel = new WeakMap<Level, number>()
const checksumOf = (level: Level): number => {
  let c = checksumByLevel.get(level)
  if (c === undefined) {
    c = levelChecksum(level)
    checksumByLevel.set(level, c)
  }
  return c
}

const checksumBySeedFloor = new Map<string, number>()
const checksumForSeedFloor = (seed: number, floor: number): number => {
  const key = `${seed >>> 0}:${floor}`
  let c = checksumBySeedFloor.get(key)
  if (c === undefined) {
    c = levelChecksum(generateLevel(seed, floor))
    checksumBySeedFloor.set(key, c)
  }
  return c
}

/** Which `(seed, floor)` produced this level? Only called on a mismatch. */
const identifyLevel = (
  checksum: number,
  seeds: readonly number[],
  maxFloor: number,
): { seed: number; floor: number } | 'unknown' => {
  for (const seed of seeds) {
    for (let floor = 1; floor <= maxFloor; floor++) {
      if (checksumForSeedFloor(seed, floor) === checksum) return { seed, floor }
    }
  }
  return 'unknown'
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Structurally diff the host's authoritative world against one client's view.
 *
 * `view` is whatever `NetClientSession.renderView()` returned — the detector
 * deliberately consumes only the PUBLIC surface a client actually renders, so it
 * measures what a player would see rather than internals a refactor could move.
 */
export const diffHostClient = (
  world: World,
  view: RenderView,
  opts: DivergenceOptions = {},
): DivergenceReport => {
  const {
    selfEntityId,
    selfTolerance = 1.5,
    remoteTolerance = 2.5,
    interestRadius = 14,
    interestMargin = 3,
    snapshotCap = 48,
    maxFloor = 8,
    candidateSeeds = [],
    ignoreStaleState = false,
  } = opts

  const issues: Divergence[] = []
  const add = (kind: DivergenceKind, detail: string, extra: Partial<Divergence> = {}): void => {
    issues.push({ kind, severity: SEVERITY[kind], detail, ...extra })
  }

  // --- The map itself -------------------------------------------------------
  // Layout never crosses the wire, so this is the only thing standing between a
  // seed/floor disagreement and two players walking different buildings.
  const hostSum = checksumOf(world.level)
  const clientSum = checksumOf(view.level)
  let clientLevelOrigin: DivergenceReport['clientLevelOrigin'] = 'match'
  if (hostSum !== clientSum) {
    const seeds = [world.seed, ...candidateSeeds]
    clientLevelOrigin = identifyLevel(clientSum, seeds, maxFloor)
    const where =
      clientLevelOrigin === 'unknown'
        ? 'a level from NO known (seed, floor) — seed mismatch'
        : `the level for seed ${clientLevelOrigin.seed} floor ${clientLevelOrigin.floor}`
    add(
      'level.map',
      `client is walking ${where}; host is on seed ${world.seed} floor ${world.floor} ` +
        `(checksum ${clientSum} vs ${hostSum})`,
    )
  }

  // --- Floor bookkeeping ----------------------------------------------------
  if (view.floor !== world.floor) {
    add('floor', `client reports floor ${view.floor}, host is on floor ${world.floor}`)
  }
  // Self-consistency: does the client's REPORTED floor even describe the map it
  // drew? `RenderView.floor` rides the 2 Hz StateMsg while the level follows
  // 10 Hz snapshots, so these two client-side facts can disagree with each other.
  // (Floors outside a sane range are reported without generating a level for
  // them — a hostile/garbage StateMsg must not cost the instrument a worldgen.)
  const sane = Number.isInteger(view.floor) && view.floor >= 1 && view.floor <= 64
  if (!sane || clientSum !== checksumForSeedFloor(world.seed, view.floor)) {
    add(
      'level.selfInconsistent',
      `client reports floor ${view.floor} but its level is not seed ${world.seed} floor ${view.floor}`,
    )
  }

  // --- The client's own avatar ---------------------------------------------
  let selfDrift = 0
  const hostSelf = selfEntityId !== undefined ? world.byId.get(selfEntityId) : undefined
  if (selfEntityId !== undefined) {
    if (!view.self) {
      add('self.missing', `client has no avatar; host expects entity ${selfEntityId}`)
    } else if (view.self.id !== selfEntityId) {
      add('self.identity', `client thinks it controls entity ${view.self.id}, host says ${selfEntityId}`)
    } else if (hostSelf) {
      selfDrift = dist(view.self.pos, hostSelf.pos)
      if (selfDrift > selfTolerance) {
        add(
          'self.position',
          `predicted own position is ${selfDrift.toFixed(2)} tiles from the host's ` +
            `(client ${view.self.pos.x.toFixed(2)},${view.self.pos.y.toFixed(2)} vs ` +
            `host ${hostSelf.pos.x.toFixed(2)},${hostSelf.pos.y.toFixed(2)})`,
          { drift: selfDrift, entityId: selfEntityId },
        )
      }
    }
  }

  // --- Entity sets ----------------------------------------------------------
  let maxDrift = selfDrift
  const seen = new Set<number>()
  for (const ce of view.entities) {
    seen.add(ce.id)
    const he = world.byId.get(ce.id)
    if (!he || he.dead) {
      add('entity.phantom', `client renders entity ${ce.id} (${ce.archetype}) the host does not have`, {
        entityId: ce.id,
      })
      continue
    }
    if (he.archetype !== ce.archetype) {
      add('entity.archetype', `entity ${ce.id}: client sees '${ce.archetype}', host has '${he.archetype}'`, {
        entityId: ce.id,
      })
    }
    if (ce.id === selfEntityId) continue // measured above with its own tolerance
    const drift = dist(ce.pos, he.pos)
    if (drift > maxDrift) maxDrift = drift
    if (drift > remoteTolerance) {
      add('entity.position', `entity ${ce.id} (${he.archetype}) is ${drift.toFixed(2)} tiles adrift`, {
        drift,
        entityId: ce.id,
      })
    }
  }

  // What the client SHOULD be seeing. Players are unconditional in the host's
  // snapshot builder; other entities only when near the avatar. When the client
  // is at the snapshot cap, absence is truncation, so only players are demanded.
  const truncated = view.entities.length >= snapshotCap
  const demandRadius = Math.max(0, interestRadius - interestMargin)
  for (const he of world.entities) {
    if (he.dead || seen.has(he.id)) continue
    const isPlayer = he.playerCtl !== undefined
    if (!isPlayer) {
      if (truncated || !hostSelf) continue
      const near =
        Math.abs(he.pos.x - hostSelf.pos.x) < demandRadius && Math.abs(he.pos.y - hostSelf.pos.y) < demandRadius
      if (!near) continue
    }
    add(
      'entity.missing',
      `host entity ${he.id} (${he.archetype}${isPlayer ? ', a PLAYER' : ''}) is absent from the client's view`,
      { entityId: he.id },
    )
  }

  // --- Mirrored run state ---------------------------------------------------
  if (!ignoreStaleState) {
    if (view.gameOver !== world.gameOver) {
      add('gameOver', `client gameOver=${view.gameOver}, host gameOver=${world.gameOver}`)
    }
    if (view.missionComplete !== world.mission.complete) {
      add('mission', `client missionComplete=${view.missionComplete}, host=${world.mission.complete}`)
    }
    if (view.missionText !== world.mission.description) {
      add('mission', `client mission text "${view.missionText}" vs host "${world.mission.description}"`)
    }
  }

  return { tick: world.tick, diverged: issues.length > 0, issues, maxDrift, selfDrift, clientLevelOrigin }
}

/** Issues of at least the given severity — what a soak assertion filters on. */
export const atLeast = (report: DivergenceReport, severity: DivergenceSeverity): Divergence[] => {
  const rank: Record<DivergenceSeverity, number> = { minor: 0, major: 1, fatal: 2 }
  return report.issues.filter((i) => rank[i.severity] >= rank[severity])
}

/** Readable one-liner list for an assertion message. */
export const formatDivergence = (report: DivergenceReport): string =>
  report.issues.length === 0
    ? `no divergence at tick ${report.tick}`
    : `tick ${report.tick}: ` + report.issues.map((i) => `[${i.severity}] ${i.kind}: ${i.detail}`).join(' | ')
