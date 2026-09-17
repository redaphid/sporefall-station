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
//
// ── Generalised beyond Mireclaw (design/boss-variety.md §3.2) ───────────────
// This module used to import Mireclaw's two HP fractions from
// `game/systems/behaviors` and map them onto three hardcoded labels. A second
// boss would have shown "SUMMONING BROOD" over its own health bar while doing
// nothing of the kind, and `ui/screens.ts` would have NAMED it "Mireclaw Alpha"
// (it called `themeDisplayName('boss')` — the archetype, spelled out).
//
// Both are now resolved from the REVEALED BOSS'S OWN ARCHETYPE: the phase table
// comes from `game/data/bosses.ts`, and the display name from a resolver the
// caller threads in. Mireclaw's on-screen behaviour is unchanged — its registry
// row carries the same three labels at the same thresholds.

import { bossDef, bossPhaseAt, DEFAULT_BOSS, type BossDef } from '../game/data/bosses'
import type { Entity } from '../game/entity'
import type { SimEvent } from '../game/types'

/** The subset of RenderView the boss bar reads. */
export interface BossViewLike {
  entities: readonly Entity[]
  events: readonly SimEvent[]
}

/**
 * Archetype → display name. Threaded in by the caller rather than imported, so
 * this module stays free of the render/theme layer (the same way `overlay.ts`
 * threads `themeDisplayName`). In the app this IS `themeDisplayName`, so a boss
 * is named by the active theme pack; in tests it is a stub.
 */
export type BossNameResolver = (archetype: string) => string

/** What to draw. `null` from `bossBar` means: draw nothing at all. */
export interface BossBar {
  name: string
  /** 0..1, clamped — the bar width. */
  hpFrac: number
  hp: number
  maxHp: number
  /** 1-based, counted from the healthiest band. Mireclaw still reads 1/2/3.
   * A `number`, not a 1|2|3 union: phase COUNT is per-boss data now. */
  phase: number
  /** Short, all-caps phase read-out that also TEACHES the counterplay. */
  phaseLabel: string
  /** This band recolours the bar red. Was `phase === 3`, which silently meant
   * "Mireclaw's enrage"; it is now a per-boss data flag, so a boss whose
   * dangerous band is not its last one can still say so. */
  danger: boolean
}

/**
 * HP fraction → phase number, against a boss's own table.
 *
 * `def` defaults to the Mireclaw registry row, which is exactly the ladder this
 * function hardcoded before — so every existing caller and test is unaffected.
 */
export const bossPhase = (hpFrac: number, def: BossDef = DEFAULT_BOSS): number => bossPhaseAt(def, hpFrac).phase

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
 * The entrance card text for a reveal event, or undefined if this frame has none.
 *
 * Takes the whole view (not just the events) because the name now depends on
 * WHICH boss was revealed: the event carries an `entityId`, and the archetype
 * behind it decides the name. A reveal for an entity the view has not got —
 * possible on a BLE client whose snapshot has not caught up with the event —
 * degrades to the default boss's themed name rather than showing nothing, since
 * an entrance card with no name is worse than a slightly wrong one.
 */
export const bossRevealName = (view: BossViewLike, resolveName: BossNameResolver): string | undefined => {
  for (const ev of view.events) {
    if (ev.type !== 'bossReveal') continue
    const boss = view.entities.find((e) => e.id === ev.entityId)
    return resolveName(boss?.archetype ?? DEFAULT_BOSS.archetype)
  }
  return undefined
}

/**
 * The bar to draw this frame, or `null` for none. Returns null when no boss has
 * been revealed, when the latched entity has left the world, or when it is dead
 * (the kill is the cue to drop the bar — MISSION COMPLETE takes the screen).
 *
 * Both the NAME and the PHASE TABLE are resolved from the latched boss's own
 * archetype, so a second boss can never wear the first one's identity.
 */
export const bossBar = (
  view: BossViewLike,
  bossId: number | undefined,
  resolveName: BossNameResolver,
): BossBar | null => {
  if (bossId === undefined) return null
  const boss = view.entities.find((e) => e.id === bossId)
  if (!boss || boss.dead || !boss.health || boss.health.max <= 0) return null
  const hp = Math.max(0, boss.health.hp)
  if (hp <= 0) return null
  const hpFrac = Math.min(1, hp / boss.health.max)
  // An unregistered archetype falls back to the Mireclaw table rather than
  // throwing: the id came off an event, which on a client is whatever that
  // phone's bundle decoded, and a wrong label beats a crashed HUD.
  const def = bossDef(boss.archetype)
  const { phase, label, danger } = bossPhaseAt(def, hpFrac)
  return {
    name: resolveName(boss.archetype),
    hpFrac,
    hp,
    maxHp: boss.health.max,
    phase,
    phaseLabel: label,
    danger,
  }
}
