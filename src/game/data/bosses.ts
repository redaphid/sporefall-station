// THE BOSS REGISTRY — one data row per boss, and the single place a boss is
// declared to the rest of the game.
//
// WHY THIS EXISTS. Before it, "a boss" was three hardcoded facts scattered
// across three layers, and every one of them said "Mireclaw Alpha":
//
//   - `systems/missions.ts` spawned the literal archetype `'boss'` in both
//     mission generators, and wrote "Purge the Mireclaw Alpha" into the
//     description as a string literal;
//   - `ui/bossModel.ts` imported Mireclaw's two HP fractions from
//     `systems/behaviors` and mapped them onto three hardcoded phase labels;
//   - `ui/screens.ts` named the boss by calling `themeDisplayName('boss')` —
//     the archetype id, spelled out, twice.
//
// So a second boss would have spawned as a Mireclaw, been described as a
// Mireclaw, and shown Mireclaw's phase text over its own health bar. The
// 2026-08-23 playtest recorded the other half of the cost: six runs produced
// "Purge the Mireclaw Alpha" four times, because there was nothing else to draw.
//
// Everything needed to SELECT, NAME and DISPLAY a boss now lives in one row
// here. Adding a boss is: a row in this file, a row in `data/npcs.ts`, its own
// system, and a themed name in the manifests. No edits to missions.ts,
// bossModel.ts or screens.ts — which is the point, so parallel boss work does
// not collide in the shared files.
//
// LAYERING. This module is deliberately LEAF data: it imports nothing from
// `systems/`, so the sim and the DOM-free UI model can both read it with no
// cycle and without the UI reaching into game systems (eslint enforces that the
// sim never imports UI; this keeps the reverse dependency clean too). The two
// Mireclaw HP fractions live here now and `systems/behaviors.ts` re-exports
// them, so every existing importer is unchanged.

/**
 * One phase band of a boss fight, as DATA rather than an `if` ladder in the HUD.
 *
 * Rows are ordered MOST-WOUNDED FIRST and resolved by taking the first row whose
 * `atOrBelow` the current hp fraction has reached (see `bossPhaseAt`). The final
 * row must cover 1 so the table is total — a boss at full health always has a
 * phase, and the HUD can never render an empty label.
 */
export interface BossPhase {
  /** This phase applies while `hpFrac <= atOrBelow`. */
  atOrBelow: number
  /** Short, all-caps read-out. It should TEACH the counterplay, not just name
   * the state: Mireclaw's phase 2 says "BURN THE SPORES" because the regen it
   * describes was otherwise invisible. */
  label: string
  /** The bar recolours to red here — the "it is going badly" band. Data, so a
   * boss whose dangerous phase is not its last one can still say so. */
  danger?: boolean
}

export interface BossDef {
  /** The `data/npcs.ts` archetype this boss spawns as, and the key the theme
   * packs name it under. */
  archetype: string
  /** Canonical display name. The UI prefers the theme pack's name for the same
   * archetype (`themeDisplayName`); this is the fallback. */
  name: string
  /**
   * The name as it reads MID-SENTENCE in mission text, article included.
   *
   * Separate from `name` because the two genuinely differ: the mission line is
   * `Purge ${missionName} in the cargo hold`, and a display name of "The Vigil"
   * substituted there would read "Purge the The Vigil". Carrying the prose form
   * as its own field also keeps the shipped Mireclaw description BYTE-IDENTICAL
   * ("Purge the Mireclaw Alpha in the …"), so generalising the mission text
   * changed no existing string.
   */
  missionName: string
  /** Ordered most-wounded-first; the last row must cover 1. */
  phases: readonly BossPhase[]
  /** Shallowest floor this boss may be drawn on. Floor 1 is the tutorial city
   * and is byte-frozen (levelgen/floor1.frozen.test.ts), so anything new starts
   * at 2 — that keeps the first floor a fixed, teachable encounter as well. */
  minFloor: number
}

// ── Mireclaw Alpha (#69) — the reference fight ──────────────────────────────
// These two fractions were previously defined in `systems/behaviors.ts` and
// imported by the sim (systems/mireclaw.ts) AND the HUD (ui/bossModel.ts). They
// move here so the phase table and the thresholds the sim actually runs on are
// one declaration instead of two that must be kept in step by hand.
// `systems/behaviors.ts` re-exports both, so no existing importer changed.

/** Below this hp fraction the Alpha retreats to a spore cloud to regenerate. */
export const MIRECLAW_RETREAT_FRAC = 0.5
/** Below this hp fraction it enrages: a one-time speed burst, and it never flees. */
export const MIRECLAW_ENRAGE_FRAC = 0.2

const MIRECLAW: BossDef = {
  archetype: 'boss',
  name: 'Mireclaw Alpha',
  missionName: 'the Mireclaw Alpha',
  minFloor: 1,
  // Identical copy to the labels `bossModel.PHASE_LABEL` hardcoded, at the same
  // thresholds the sim runs on — the Alpha's on-screen behaviour is unchanged
  // by the generalisation, which is the whole contract of this refactor.
  phases: [
    { atOrBelow: MIRECLAW_ENRAGE_FRAC, label: 'ENRAGED', danger: true },
    { atOrBelow: MIRECLAW_RETREAT_FRAC, label: 'REGENERATING — BURN THE SPORES' },
    { atOrBelow: 1, label: 'SUMMONING BROOD' },
  ],
}

// ── The Vigil (§4.1) — the boss you are trying not to fight ─────────────────
// Player verb: BE QUIET. It is vulnerable only while dormant; every loud tool
// wakes it, and awake it is near-immune. The phase labels are the noise meter's
// honest channel — stealth without feedback is unfair, so the bar states plainly
// which of the two states it is in and what that costs.
//
// Its labels TEACH THE VERB rather than narrate its hp, because for this boss
// the health bar is not the interesting number — the noise meter is. Both labels
// are therefore true whatever the Vigil is doing, and the live dormant/awake
// state is surfaced separately, on the annotation `systems/vigil.ts` maintains.
//
// It deliberately has NO `danger` band. A red bar means "this is going badly",
// and for the Vigil a low health bar is the opposite of that — it means you have
// been quiet enough for long enough. Its danger is the meter, not its hp. This
// is exactly what the old hardcoded `phase === 3` could not express.
const VIGIL: BossDef = {
  archetype: 'vigil',
  name: 'The Vigil',
  missionName: 'the Vigil',
  minFloor: 2,
  phases: [
    { atOrBelow: 0.3, label: 'NEARLY SILENCED — FINISH IT' },
    { atOrBelow: 1, label: 'VULNERABLE ONLY ASLEEP — BE QUIET' },
  ],
}

// ── The Sealkeeper (§4.3) — the boss that fights the architecture ───────────
// Player verb: DEMOLISH. It barely engages; it retreats, shuts and re-locks
// doors behind it, plugs the chokepoints with barricades, and finally kills the
// wing's grid. Your grenades stop being a weapon and become a TOOL.
//
// The labels name the COUNTERPLAY rather than the monster's mood, because this
// is the one fight where the obvious action is the losing one: standing still
// and shooting is how you end up sealed in a dead room. "BLOW THE DOORS" has to
// be on screen before the player has worked that out for themselves.
//
// The `danger` band is the LAST one, and it is earned: by then the grid is cut,
// the wing's sleepers are awake, and the party is fighting through its own
// exits. Contrast the Vigil, which deliberately has no danger band at all.
const SEALKEEPER: BossDef = {
  archetype: 'sealkeeper',
  name: 'The Sealkeeper',
  missionName: 'the Sealkeeper',
  minFloor: 2,
  phases: [
    { atOrBelow: 0.25, label: 'LAST BULKHEAD — BREACH AND FINISH IT', danger: true },
    { atOrBelow: 0.5, label: 'GRID CUT — THE WING IS AWAKE' },
    { atOrBelow: 1, label: 'SEALING THE WING — BLOW THE DOORS' },
  ],
}

/**
 * Every boss the game can field, keyed by archetype.
 *
 * APPEND a row to add a boss. The three still on the design doc's list (Echo,
 * Mirefather, the Hollow Choir) are NOT here yet: a row here
 * makes a boss selectable by `pickBoss`, so registering one before its NPCS row
 * and system exist would spawn an archetype with no definition. Their wire
 * indices are already reserved in `net/protocol/messages.ts` — that list is
 * append-only and must be booked ahead; this one must not be.
 */
export const BOSSES: Record<string, BossDef> = {
  [MIRECLAW.archetype]: MIRECLAW,
  [VIGIL.archetype]: VIGIL,
  [SEALKEEPER.archetype]: SEALKEEPER,
}

/** The reference boss — the fallback whenever an archetype is unknown, so a
 * stale snapshot or a typo degrades to a working health bar instead of crashing
 * the HUD. */
export const DEFAULT_BOSS = MIRECLAW

/** The registry row for an archetype, or the Mireclaw default. Never throws:
 * the HUD calls this on whatever the `bossReveal` event pointed at, which on a
 * BLE client is whatever that phone's bundle decoded. */
export const bossDef = (archetype: string): BossDef => BOSSES[archetype] ?? DEFAULT_BOSS

/** Is this archetype a registered boss? Used by the HUD to decide whether an
 * entity deserves the boss bar at all. */
export const isBoss = (archetype: string): boolean => archetype in BOSSES

/**
 * Resolve an hp fraction onto a boss's phase table.
 *
 * Returns the 1-based phase NUMBER counted from the healthiest band (so
 * Mireclaw still reads 1/2/3 exactly as it did), plus that band's label and
 * danger flag. Total by construction: the last row covers 1, and a table that
 * somehow did not would still fall back to the healthiest row rather than
 * returning undefined into the HUD.
 */
export const bossPhaseAt = (def: BossDef, hpFrac: number): { phase: number; label: string; danger: boolean } => {
  const phases = def.phases
  for (let i = 0; i < phases.length; i++) {
    if (hpFrac <= phases[i].atOrBelow) {
      return { phase: phases.length - i, label: phases[i].label, danger: phases[i].danger === true }
    }
  }
  const last = phases[phases.length - 1]
  return { phase: 1, label: last?.label ?? '', danger: last?.danger === true }
}

/** Bosses eligible to be drawn on `floor`, in registry order (deterministic). */
export const eligibleBosses = (floor: number): BossDef[] =>
  Object.values(BOSSES).filter((b) => floor >= b.minFloor)

/**
 * Choose this floor's boss.
 *
 * ⚠️ DETERMINISM. `rng` MUST be a dedicated fork (`w.rng.fork('boss')`), never
 * the mission stream. `Rng.fork` derives a fresh stream from the parent's SEED
 * and draws nothing from the parent, so selecting a boss consumes ZERO values
 * from the streams that place missions and loot. That is what keeps the frozen
 * floor-1 checksums and the pinned steal/assassinate placement table
 * byte-identical — see the warning at systems/missions.ts.
 *
 * With one eligible boss the draw is SKIPPED entirely rather than made and
 * discarded. On a dedicated fork that is not required for correctness, but it
 * keeps the shallow-floor path free of a draw that did not exist before, which
 * is the property a reviewer of this file will want to check first.
 */
export const pickBoss = (floor: number, rng: { int: (lo: number, hi: number) => number }): BossDef => {
  const pool = eligibleBosses(floor)
  if (pool.length === 0) return DEFAULT_BOSS
  if (pool.length === 1) return pool[0]
  return pool[rng.int(0, pool.length - 1)]
}
