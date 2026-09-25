// Single source of truth for the brief, player-facing "what's new" notes shown
// under the version number on the start menu.
//
// EACH NOTE IS ITS OWN FILE under `./releaseNotes/`, one per player-facing
// change — deliberately NOT one shared array. A shared array meant every PR
// edited the same handful of lines at the top of the same file, so any two
// PRs open around the same time collided there on nothing but unrelated
// release-note text (#45/#46/#47 all conflicted here the same afternoon, none
// of them touching the same game code). Landing a note is now purely
// additive: drop in a new file, touch nothing that already exists, and a
// sibling PR doing the same thing can never conflict with you.
//
// To add a note for your change, create
// `./releaseNotes/YYYY-MM-DD-short-slug.ts` exporting the one-line string as
// `default`. Notes are loaded with Vite's `import.meta.glob` — the same
// isomorphic, build-time mechanism `game/fixtures.ts` uses for fixture JSON —
// and sorted by filename, newest first, so the date prefix IS the ordering:
// nothing to reorder, nothing to rebase. Keep it short and punchy (~40 chars),
// player-facing only (no internal/tooling churn).
//
// RELEASE_NOTES is capped to the newest few automatically; older files are
// left in place as an inert history rather than deleted, since nothing ever
// needs to touch them again.
//
// The module is pure/DOM-free so the formatting is unit-tested exhaustively and
// the menu just paints the result (see releaseNotes.test.ts).

// Typed as `unknown` on purpose: the glob is a directory contract, not a
// checked one, so a malformed note file must be inert rather than fatal —
// `selectNotes` drops anything that is not a usable string.
const noteModules = import.meta.glob('./releaseNotes/*.ts', { eager: true, import: 'default' }) as Record<
  string,
  unknown
>

/** How many of the newest note files make it into the curated list below. */
const VISIBLE_NOTE_COUNT = 4

/**
 * A note file, and ONLY a note file: `YYYY-MM-DD-slug.ts`.
 *
 * The date prefix is the sort key, so an undated filename is not merely
 * untidy — it sorts above every dated one ('h' > '2') and would pin itself to
 * the top of the menu forever, silently evicting the genuinely newest note.
 * Anything else in the directory (a helper, a stray test) is ignored instead.
 */
const NOTE_FILE = /\/\d{4}-\d{2}-\d{2}-[^/]+\.ts$/

/**
 * The newest `count` notes from a glob result, newest first. Pure, and kept
 * separate from the glob so the ordering and the guards are directly testable.
 *
 * Ordering is by filename descending, which resolves to the date prefix; two
 * notes sharing a date fall back to reverse-alphabetical slug, which is
 * arbitrary but stable. Use the MERGE date, not the authoring date — a
 * stale-dated note lands below newer ones and may never be seen.
 *
 * Unusable entries are dropped BEFORE the cap, so a malformed or empty note
 * costs the player a stale slot rather than a blank bullet or a crash.
 */
export const selectNotes = (modules: Record<string, unknown>, count: number = VISIBLE_NOTE_COUNT): string[] =>
  Object.keys(modules)
    .filter((path) => NOTE_FILE.test(path))
    .sort()
    .reverse()
    .map((path) => modules[path])
    .filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
    .slice(0, Math.max(0, count))

/** The current build's brief highlights, newest first. Keep tiny and punchy. */
export const RELEASE_NOTES: readonly string[] = selectNotes(noteModules)

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
