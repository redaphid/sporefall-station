/**
 * Opt-in feature flags.
 *
 * The owner's instruction: "Let's treat these like feature flags that the user
 * opts in to." New, risky or taste-dependent work ships DARK behind a flag and
 * he switches it on when he wants to look. This is the registry that makes that
 * a system rather than a drawer of unrelated switches.
 *
 * Four rules hold this together:
 *
 * 1. ONE PLACE. Every flag is declared here and the settings panel renders the
 *    list automatically. A flag he cannot find may as well not exist.
 *
 * 2. OFF IS THE UNTOUCHED PATH. A flag ADDS behaviour; it never subtracts. A
 *    player who never opens the panel must be provably unaffected, so the
 *    default path stays the original code rather than a new branch that
 *    reconstructs it.
 *
 * 3. PRESENTATION ONLY — NEVER THE WIRE. Flags are local, persisted, and
 *    offline-safe. Two peers on different settings must stay in perfect sync and
 *    merely see different things. `src/game/` (the deterministic sim) and
 *    `src/net/` (the protocol) may NEVER read a flag; a unit test enforces this
 *    by grep, because a leak here surfaces as a rare unreproducible desync
 *    rather than as an obvious failure. The `ARCHETYPES` bug already proved
 *    rendering and the wire are entangled in this codebase.
 *
 * 4. EVERY FLAG HAS A WAY TO DIE. `retire` states the condition under which the
 *    flag is deleted or its default flips. This is not bureaucracy: this repo
 *    already carries `INFECTION_ENABLED = false`, hiding an entire unfinished
 *    system whose enemy type has never once been instantiated. A flag is a
 *    deferred decision, and undated deferred decisions become a codebase nobody
 *    can reason about.
 */

export interface FeatureFlag {
  /** Stable storage key. Never reused or repurposed once shipped. */
  key: string
  /** Plain-English name. What he is choosing, not what the code does. */
  label: string
  /** One line: what actually changes when this is on. */
  description: string
  /** Almost always false — the point of the pattern is opt-in. */
  defaultOn: boolean
  /** The condition under which this flag is REMOVED or its default flips.
   * Required. A flag with no exit condition is permanent scaffolding. */
  retire: string
  /** Build number this became available, so "what is newly switchable" is
   * derivable rather than remembered. `git rev-list --count HEAD`. */
  since: number
}

export const FEATURE_FLAGS: readonly FeatureFlag[] = [
  {
    key: 'newEnemyArt',
    label: 'New creature art',
    description:
      'Draws bespoke sprites for the six Sporefall threats (brute, cinder, sporeling, stalker, lurker, pod) instead of the generic blobs.',
    defaultOn: false,
    retire:
      'Delete the flag and fold the six into CHARSET_ALIAS_BASE once the colour pass lands and the sprites no longer read grey beside the existing cast.',
    since: 400,
  },
]

const BY_KEY: ReadonlyMap<string, FeatureFlag> = new Map(FEATURE_FLAGS.map((f) => [f.key, f]))

/** Every flag at its default. The shape stored in settings. */
export const defaultFlags = (): Record<string, boolean> =>
  Object.fromEntries(FEATURE_FLAGS.map((f) => [f.key, f.defaultOn]))

/**
 * Coerce arbitrary stored input into a valid flag map.
 *
 * Deliberately strict: only booleans are honoured, and only for keys that are
 * still registered. A stored `'true'` STRING must not switch a flag on — a
 * truthiness bug here would silently opt people into work that ships dark,
 * which is the single outcome the off-by-default pattern exists to prevent.
 * Unknown keys (a retired flag) are dropped rather than carried forever.
 */
export const clampFlags = (raw: unknown): Record<string, boolean> => {
  const out = defaultFlags()
  if (typeof raw !== 'object' || raw === null) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean' && BY_KEY.has(k)) out[k] = v
  }
  return out
}

/** Is `key` switched on? Unknown keys are OFF — a typo disables, never enables. */
export const flagOn = (flags: Record<string, boolean> | undefined, key: string): boolean =>
  flags?.[key] === true

/** Flags introduced after `build`, for telling him what is newly switchable.
 * Off-by-default means "shipped" no longer means "he has seen it", so this is
 * how new work avoids sitting dark the way the checklists did. */
export const flagsSince = (build: number): readonly FeatureFlag[] => FEATURE_FLAGS.filter((f) => f.since > build)
