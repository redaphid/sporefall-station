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
 *    ONE SANCTIONED EXCEPTION, and it keeps the rule intact: a flag may choose a
 *    RUN RULE. The app layer reads the flag once, when a host BUILDS a run, and
 *    writes a plain sim value into the new World (`sequencedMods` ->
 *    `World.modCasting`), exactly as the difficulty `mode` is chosen. From then
 *    on the rule is world state: it serializes with the save, replays with a
 *    recording, and reaches clients in GameStart. The sim and the protocol still
 *    never read a flag (the grep test still holds), a client's own setting has
 *    no effect on the host's run, and toggling mid-run changes nothing until the
 *    next run is built.
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
    // FLIPPED TO ON (owner's call). The trigger was a bug report — "the enemies
    // the boss spawns are white circles" — which was this flag being off: with
    // it off, `sporeling` is absent from CHARSET_ALIAS, so the boss's brood
    // misses the character path entirely and falls to the generic blob draw,
    // tinted `entityColors.default` (0xcccccc). The art was shipping the whole
    // time; only the switch was down. Off-by-default was the right ship state
    // for unreviewed art and the wrong one for art that had been reviewed.
    defaultOn: true,
    retire:
      'Default flipped ON. Remaining step: delete the flag and fold the six into CHARSET_ALIAS_BASE once the colour pass lands and each of the six has more than the single south-facing idle frame it reuses for all five facings.',
    since: 400,
  },
  {
    key: 'sequencedMods',
    label: 'Sequenced mods (prototype)',
    description:
      'Your gun fires its mods one at a time, in the order you set, instead of all at once. Tap two mods in the sequence strip to swap them. Applies to the next run you start or host.',
    defaultOn: false,
    retire:
      'Prototype. Delete the flag (and World.modCasting) once the owner has played it side by side with the default fold and picked one: either promote sequencing to the only mode or remove modSequence.ts.',
    since: 567,
  },
  {
    key: 'primerStrikerGuns',
    label: 'Primer + Striker (prototype)',
    description:
      'Solo only. A second gun on its own trigger (I on a keyboard; no pad button yet) splashes goo that your main gun reacts with: water + spark arcs, oil + fire spreads, ice + bullets cracks. Turns on sequenced mods too. Applies to the next solo run.',
    defaultOn: false,
    retire:
      'Prototype for loadout design A (Primer and Striker). Delete the flag, World.primerStriker, systems/primer.ts and systems/reactions.ts if playtests reject it; otherwise promote it to the run rule and give it the bench UI, the wire trailer and co-op.',
    since: 600,
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
