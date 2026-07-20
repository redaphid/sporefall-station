// Single source of truth for the brief, player-facing "what's new" notes shown
// under the version number on the start menu. This is a CURATED, maintained
// list — keep it short and punchy (one line each, ~40 chars), player-facing
// only (no internal/tooling churn). Each merge to `main` should prepend a
// one-line summary and trim to the latest few (see CLAUDE.md → Release workflow).
//
// The module is pure/DOM-free so the formatting is unit-tested exhaustively and
// the menu just paints the result (see releaseNotes.test.ts).

/** The current build's brief highlights, newest first. Keep tiny and punchy. */
export const RELEASE_NOTES: readonly string[] = [
  'Testing: infinite ammo',
  'Enemies commit — no fight/flee twitching',
  'Renamed to Sporefall Station — new missions',
  'Aiming fixed — gamepad owns aim',
]

/** Tuning for how many notes show and how long each line may be. */
export interface ReleaseNotesOptions {
  /** Cap on how many lines to show (default 4). Extra lines are dropped. */
  maxLines?: number
  /** Cap on characters per line (default 44). Longer lines are ellipsised. */
  maxLen?: number
}

const DEFAULTS: Required<ReleaseNotesOptions> = { maxLines: 4, maxLen: 44 }

/** Truncate to `maxLen`, appending a single-char ellipsis when it overflows. */
const clamp = (line: string, maxLen: number): string =>
  line.length > maxLen ? `${line.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…` : line

/**
 * The player-facing release notes to render, capped and truncated. Pure: same
 * input → same output. Blank/whitespace-only lines are dropped so the menu
 * never shows an empty bullet; an empty source yields an empty list (the menu
 * then renders nothing at all).
 */
export const formatReleaseNotes = (
  notes: readonly string[] = RELEASE_NOTES,
  opts: ReleaseNotesOptions = {},
): string[] => {
  const { maxLines, maxLen } = { ...DEFAULTS, ...opts }
  return notes
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .slice(0, Math.max(0, maxLines))
    .map((n) => clamp(n, maxLen))
}
