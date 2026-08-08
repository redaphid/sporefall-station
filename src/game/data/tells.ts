// Attack COMMITMENT profiles — issue #1. Before this table every archetype
// collapsed at contact into the same routine: face the target, `fireWeapon`,
// repeat every `cooldownTicks`. A measured arena sweep found 11 of 13 archetypes
// showing exactly two action patterns and ONE constant swing interval, so a
// skittish civilian, a stalking predator and an ambush lurker were
// indistinguishable at knife range.
//
// A tell gives an attack three phases the player can read:
//
//   wind-up  — the body commits and telegraphs. It cannot move or re-target
//              (past `lock`), and a stun/freeze here BREAKS the attack.
//   active   — the strike(s) land. UNCANCELLABLE: once the wind-up completes the
//              enemy is stuck with the consequence even if stunned or frozen.
//   recovery — the punish window. Still locked in place, and taking PUNISH_MULT
//              extra damage.
//
// Every field is an integer tick count or a plain number, and every derived
// window is an ABSOLUTE tick stamped at commit time (systems/commitment.ts), so
// the whole mechanic is a pure function of world tick + seed. No wall-clock, no
// per-frame accumulators, nothing to drift across a serialize round-trip.
//
// The shapes are deliberately DIFFERENT rather than one universal wind-up: the
// point is that an enemy becomes identifiable by HOW it attacks, so melee and
// ranged, brawler and ambusher, get different silhouettes in time.

import type { Entity } from '../entity'
import { WEAPONS } from './items'

/** Extra damage a body takes while in the RECOVERY window — the payoff for
 * reading the tell and punishing it. Applied in combat.applyDamage. */
export const PUNISH_MULT = 1.5

/** One archetype's attack silhouette in time. `strikes` are tick offsets from
 * the first active tick (always starts at 0, ascending, no duplicates — asserted
 * by the unit suite), so a multi-hit flurry and a single haymaker are the same
 * shape of data. */
export interface Tell {
  /** Presentation key: what the renderer draws, the mixer plays, and the haptic
   * pattern keys off. Shared by archetypes that genuinely attack alike. */
  shape: string
  /** Ticks of wind-up before the first strike lands. The dodge window. */
  windup: number
  /** Tick offsets (from the first active tick) at which a strike resolves. */
  strikes: readonly number[]
  /** Ticks after the LAST strike before the body is free — the punish window. */
  recovery: number
  /** Damage multiplier per strike. Heavier tells hit harder to pay for the
   * commitment; spam tells hit softer. */
  damage: number
  /** Ticks BEFORE the first strike at which the aim freezes. Past this the
   * enemy no longer tracks: sidestepping is a real counter, not just i-frames. */
  lock: number
  /** Forward impulse (tiles/sec) applied on the first strike — a lunge/slam
   * carries its body into the blow. Goes through the normal `vel` + collision
   * path, so it never clips a wall. */
  dash?: number
  /** Minimum facing-dot a victim must satisfy for this tell's melee arc, in
   * place of the stock 0.5 (~120 degrees total). LOWER is wider: 0 is a 180-degree
   * sweep that catches a crowd, 0.8 is a ~74-degree piston you can stand beside.
   * Expressed as a raw dot product, never an angle, so the hit test needs no
   * trig at all and stays bit-identical on every device. */
  arcDot?: number
}

/** How long the whole commitment runs, in ticks. */
export const tellLength = (t: Tell): number => t.windup + activeLength(t) + t.recovery

/** How long the ACTIVE (uncancellable) window runs, in ticks. */
export const activeLength = (t: Tell): number => t.strikes[t.strikes.length - 1] + 1

/**
 * The reaction-delay window, in ticks after the wind-up begins, during which
 * starting a dodge-roll puts its i-frames over the ENTIRE active window.
 *
 * A roll grants `rollTicks` of invulnerability from the tick it starts. Rolling
 * at delay `r` covers `[r, r + rollTicks)`; the active window is
 * `[windup, windup + activeLength)`. Containment needs `r <= windup` (rolled in
 * time) and `r + rollTicks >= windup + activeLength` (still invulnerable when
 * the last strike lands). Returns `[first, last]` inclusive — `last - first + 1`
 * is how many ticks of human reaction slack the tell allows.
 *
 * This is the acceptance test for issue #1 in executable form: the unit suite
 * asserts every shipped tell leaves a window a human can actually hit.
 */
export const dodgeWindow = (t: Tell, rollTicks: number): readonly [number, number] => [
  Math.max(0, t.windup + activeLength(t) - rollTicks),
  t.windup,
]

/**
 * Ticks of free hits a dodge earns, for a roll started at reaction delay `r`.
 * The roll ends at `r + rollTicks`; recovery ends at `windup + activeLength +
 * recovery`. Worst case is the LATEST safe dodge (`r === windup`); the earliest
 * safe dodge leaves the full `recovery`. Every shipped tell must be positive at
 * the worst case, or reading the tell buys nothing.
 */
export const punishWindow = (t: Tell, rollTicks: number, r: number): number =>
  t.windup + activeLength(t) + t.recovery - (r + rollTicks)

// ── The shapes ──────────────────────────────────────────────────────────────
// Tuned against ROLL_TICKS = 12 (systems/roll.ts): every entry leaves at least
// 8 ticks (~270ms at 30Hz) of reaction slack and at least 3 ticks of punish in
// the worst case. `tells.test.ts` proves both for every row, so retuning a
// number that breaks the dodge fails the suite rather than shipping.
export const TELLS: Record<string, Tell> = {
  /** Bat raised high overhead, held, then dropped. The bread-and-butter thug
   * beat: slow, obvious, and it hurts if you stand there. */
  overhead: { shape: 'overhead', windup: 20, strikes: [0], recovery: 14, damage: 1.8, lock: 8 },
  /** Both arms up, a visible crouch, then a body-slam that carries forward.
   * The longest read in the game — and the biggest punish for taking it. */
  slam: { shape: 'slam', windup: 30, strikes: [0], recovery: 24, damage: 2.2, lock: 12, dash: 3, arcDot: 0.3 },
  /** The Mireclaw's two-beat maul: a rising claw, then a second rake. */
  maul: { shape: 'maul', windup: 26, strikes: [0, 3], recovery: 22, damage: 1.5, lock: 10, dash: 4, arcDot: 0.4 },
  /** A wide, loaded, from-the-hip haymaker. Peaceful until provoked, then it
   * winds up like it means to end the conversation. */
  haymaker: { shape: 'haymaker', windup: 24, strikes: [0], recovery: 20, damage: 1.9, lock: 10 },
  /** Trained two-hit baton combo — short read, short punish. Professional. */
  combo: { shape: 'combo', windup: 12, strikes: [0, 4], recovery: 12, damage: 0.9, lock: 5 },
  /** Coils back, then covers ground in one committed stab. The predator. */
  lunge: { shape: 'lunge', windup: 14, strikes: [0], recovery: 18, damage: 1.5, lock: 6, dash: 9 },
  /** The ambusher: almost no wind-up — the fastest tell in the game — paid for
   * with the longest recovery. Survive the scare and it is wide open. */
  snap: { shape: 'snap', windup: 8, strikes: [0], recovery: 24, damage: 1.4, lock: 4 },
  /** Three scrabbling swipes from a swarm-thing. Individually trivial, and the
   * short recovery means it is back on you fast. */
  flurry: { shape: 'flurry', windup: 9, strikes: [0, 2, 4], recovery: 10, damage: 0.5, lock: 4 },
  /** A wide two-beat arc that catches everything beside it — do not stand in
   * the crowd for this one. */
  sweep: { shape: 'sweep', windup: 18, strikes: [0, 2], recovery: 16, damage: 0.8, lock: 7, arcDot: 0 },
  /** Panicked, flailing, badly committed: a civilian who decided to fight. */
  flail: { shape: 'flail', windup: 16, strikes: [0], recovery: 20, damage: 0.9, lock: 3 },
  /** Servo whine, arm retracts, one straight piston blow. Narrow — sidestep it. */
  piston: { shape: 'piston', windup: 22, strikes: [0], recovery: 18, damage: 1.8, lock: 9, dash: 2, arcDot: 0.8 },
  /** Generic melee fallback for an archetype with no entry of its own. */
  swing: { shape: 'swing', windup: 14, strikes: [0], recovery: 12, damage: 1.3, lock: 6 },

  // ── ranged ────────────────────────────────────────────────────────────────
  /** Plants, shoulders the weapon and holds a line on you before firing. The
   * aim FREEZES at `lock`, so stepping off the line beats it without a roll. */
  aimed: { shape: 'aimed', windup: 15, strikes: [0], recovery: 14, damage: 1.4, lock: 10 },
  /** Two fast shots off a rapid weapon — less read, less punish. */
  volley: { shape: 'volley', windup: 11, strikes: [0, 3], recovery: 16, damage: 0.6, lock: 5 },
}

/** Archetypes whose attack is their signature. Anything absent falls back to
 * the weapon-kind default below, so a new NPC still commits (never the old
 * instant swing) and a designer only writes a row when they want a silhouette. */
const BY_ARCHETYPE: Record<string, string> = {
  thug: 'overhead',
  brute: 'slam',
  boss: 'maul',
  bouncer: 'haymaker',
  cop: 'combo',
  stalker: 'lunge',
  lurker: 'snap',
  sporeling: 'flurry',
  pod: 'flurry',
  cinder: 'sweep',
  civilian: 'flail',
  scientist: 'flail',
  shopkeeper: 'flail',
  robot: 'piston',
  gangster: 'aimed',
}

/** Rapid-fire weapons (machinegun, flamethrower) get the volley shape instead
 * of the deliberate aimed one — a weapon that spits should read as spitting. */
const RAPID_COOLDOWN = 8

/**
 * The tell `e` attacks with: its archetype's signature if it has one, else a
 * default derived from the equipped weapon. Total, never undefined — every
 * attacker commits, so there is no path back to the instant swing.
 */
export const tellFor = (e: Entity): Tell => {
  const named = BY_ARCHETYPE[e.archetype]
  if (named) return TELLS[named]
  const weapon = WEAPONS[e.combat?.weapon ?? 'fists'] ?? WEAPONS.fists
  if (weapon.kind === 'ranged') return weapon.cooldownTicks <= RAPID_COOLDOWN ? TELLS.volley : TELLS.aimed
  return TELLS.swing
}
