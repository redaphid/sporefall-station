// The boss health bar / name plate MODEL — pure, DOM-free, unit-testable.
//
// Why this exists: the Mireclaw Alpha shipped with no name plate, no health bar
// and no entrance. It shared the thug's sprite, so the only way to know you had
// met the floor's boss was to read the mission chip and infer it. Players
// killed it repeatedly without ever registering that a boss had happened.
//
// The bar is LATCHED by the `bossReveal` event rather than by proximity, so it
// works identically on the host and on a BLE client (events are JSON pass-
// through over the wire) and never flickers when the boss steps behind a wall.

import type { Entity } from '../game/entity'
import type { SimEvent } from '../game/types'
import { MIRECLAW_ENRAGE_FRAC, MIRECLAW_RETREAT_FRAC } from '../game/systems/behaviors'

/** The subset of RenderView the boss bar reads. */
export interface BossViewLike {
  entities: readonly Entity[]
  events: readonly SimEvent[]
  /** The entity this device controls. Absent on a spectator/pre-spawn frame. */
  self?: Entity
  /** The run is over. */
  gameOver?: boolean
}

/**
 * True while the LOCAL player is out of the fight — dead, bleeding out, or the
 * run is over.
 *
 * This is the same condition that raises the restart overlay
 * (`screens.restartAffordance`), and `bossModel.equivalence.test.ts` pins the
 * two together so they cannot drift apart. It is stated here rather than
 * imported from `screens.ts` because `screens.ts` imports *this* module.
 */
export const playerOutOfFight = (view: BossViewLike): boolean =>
  !!view.gameOver || !!view.self?.dead || !!view.self?.playerCtl?.downed

/** What to draw. `null` from `bossBar` means: draw nothing at all. */
export interface BossBar {
  name: string
  /** 0..1, clamped — the bar width. */
  hpFrac: number
  hp: number
  maxHp: number
  /** 1 = brooding, 2 = regenerating, 3 = enraged. Mirrors systems/mireclaw. */
  phase: 1 | 2 | 3
  /** Short, all-caps phase read-out that also TEACHES the counterplay. */
  phaseLabel: string
}

/** Phase copy. Phase 2 names the counter out loud: the Alpha heals in an
 * unburnt spore cloud (systems/mireclaw.inSafeCloud), so fire is the answer —
 * a mechanic that was previously invisible because phase 2 lasted ~0.9s. */
const PHASE_LABEL: Record<1 | 2 | 3, string> = {
  1: 'SUMMONING BROOD',
  2: 'REGENERATING — BURN THE SPORES',
  3: 'ENRAGED',
}

/** HP fraction → phase, using the SAME thresholds the sim runs on. */
export const bossPhase = (hpFrac: number): 1 | 2 | 3 => {
  if (hpFrac <= MIRECLAW_ENRAGE_FRAC) return 3
  if (hpFrac <= MIRECLAW_RETREAT_FRAC) return 2
  return 1
}

/**
 * Pure reducer for the latched boss id, folded over one frame's events.
 *
 * - `bossReveal` latches that boss (the entrance fired).
 * - `floorChange` clears it — the next floor's boss must announce itself.
 *
 * Everything else passes through, so the latch survives the boss walking out of
 * sight. Death is NOT handled here: `bossBar` drops the bar once the entity is
 * gone or dead, which keeps this reducer a one-liner over the event list.
 */
export const latchBossId = (prev: number | undefined, events: readonly SimEvent[]): number | undefined => {
  let id = prev
  for (const ev of events) {
    if (ev.type === 'bossReveal') id = ev.entityId
    else if (ev.type === 'floorChange') id = undefined
  }
  return id
}

/**
 * True when this frame belongs to a NEW run rather than the one we were just
 * watching.
 *
 * `screens.ts` is built once (main.ts) and never rebuilt, but "Run it back" /
 * "New Seed" rebuild the world in place (`app/hostSession.buildRun`) — which
 * resets the tick to 0 **and restarts entity ids at 1**
 * (`game/world.createWorld`). A latch carried across that boundary therefore
 * does not merely go stale: the dead boss's id is handed straight back out to
 * an unrelated floor-1 enemy, and the Alpha's name plate reappears over a thug
 * that never announced itself. A tick that fails to advance is a new world.
 */
export const isRunReset = (prevTick: number | undefined, tick: number): boolean =>
  prevTick !== undefined && tick < prevTick

/** The entrance card text for a reveal event, or undefined if this frame has none. */
export const bossRevealName = (events: readonly SimEvent[], name: string): string | undefined => {
  for (const ev of events) if (ev.type === 'bossReveal') return name
  return undefined
}

/**
 * The bar to draw this frame, or `null` for none. Returns null when no boss has
 * been revealed, when the latched entity has left the world, or when it is dead
 * (the kill is the cue to drop the bar — MISSION COMPLETE takes the screen).
 *
 * `name` is passed in rather than resolved here so this module stays free of
 * the render/theme layer (see overlay.ts, which threads `themeDisplayName` the
 * same way).
 */
export const bossBar = (view: BossViewLike, bossId: number | undefined, name: string): BossBar | null => {
  // The player is down / dead / the run is over: the restart overlay owns the
  // screen now. The bar is not merely redundant here, it is a rendering fault —
  // the HUD carries `z-index:66` and the overlay carries none, so the bar paints
  // ON TOP of the YOU DIED scrim instead of behind it (screens.ts).
  if (playerOutOfFight(view)) return null
  if (bossId === undefined) return null
  const boss = view.entities.find((e) => e.id === bossId)
  if (!boss || boss.dead || !boss.health || boss.health.max <= 0) return null
  const hp = Math.max(0, boss.health.hp)
  if (hp <= 0) return null
  const hpFrac = Math.min(1, hp / boss.health.max)
  const phase = bossPhase(hpFrac)
  return { name, hpFrac, hp, maxHp: boss.health.max, phase, phaseLabel: PHASE_LABEL[phase] }
}
