// A whole-world fingerprint taken from the LIVE `World` object.
//
// WHY NOT JUST COMPARE `serializeWorld` OUTPUTS (what `expectWorldEqual` does)?
// Because that compares two worlds THROUGH the snapshot schema, so any field the
// schema forgets is invisible on BOTH sides and the comparison passes while the
// worlds genuinely differ. That is not hypothetical: `mode` and `revivesLeft`
// are read by the sim (`combat.kill`, `interaction.recover`) and were missing
// from `WorldJson`, so a restored run quietly got its revives back and the
// existing byte-identical test could not see it.
//
// This digest instead enumerates the world's OWN keys dynamically, so a field
// added to `World` and forgotten in `serialize.ts` shows up as a divergence
// automatically rather than needing someone to remember to assert on it.
//
// Excluded, deliberately:
//   byId       — a derived index into `entities` (comparing it is redundant and
//                would serialize each entity twice).
//   level      — regenerated from seed+floor and never mutated at runtime;
//                represented by its checksum instead, which is what would
//                actually catch drift.
//   rng/baseRng— closures, not data. Their STREAM POSITIONS are what matter and
//                are folded in explicitly below; those positions are the whole
//                determinism story.

import { levelChecksum } from '../game/levelgen/level'
import type { World } from '../game/world'

/** Derived/none-data fields handled explicitly below rather than enumerated. */
const DERIVED = new Set(['byId', 'level', 'rng', 'baseRng'])

/**
 * JSON with every object's keys sorted, recursively.
 *
 * Required for correctness here, not tidiness: a restored entity's key order
 * comes from its JSON clone while the original's comes from however it was
 * constructed. Plain `JSON.stringify` would report two identical entities as
 * different purely because of key order — a false divergence that would make
 * this check cry wolf and get ignored.
 */
export const stableStringify = (v: unknown): string => {
  if (v === undefined) return 'null' // matches how JSON renders an array hole
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const rec = v as Record<string, unknown>
  const entries = Object.keys(rec)
    // A key that is PRESENT with value `undefined` and a key that is ABSENT are
    // the same thing to the sim, but not to a naive stringify — and the two
    // differ across a JSON round-trip every time: a live NPC carries
    // `ai.path === undefined` after a repath, while its restored twin has no
    // `path` key at all because `JSON.stringify` drops undefined values.
    // Without this filter the digest reports a divergence on virtually every
    // world containing an NPC — a check that cries wolf is a check that gets
    // ignored. `null` is deliberately NOT filtered: it is a real value that
    // survives JSON intact, so a genuine value/null change still shows up.
    .filter((k) => rec[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
  return `{${entries.join(',')}}`
}

/**
 * Fingerprint a live world. Two worlds with the same digest are the same world
 * as far as the sim can tell — same entities, same tick, same difficulty, same
 * revive economy, and critically the same PRNG cursor.
 */
export const worldDigest = (w: World): string => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(w)) {
    if (DERIVED.has(key)) continue
    out[key] = (w as unknown as Record<string, unknown>)[key]
  }
  // The determinism keystone: where each PRNG stream is sitting RIGHT NOW. Two
  // worlds identical in every visible way but differing here will behave
  // differently on the very next tick.
  out['__rngState'] = w.rng.state()
  out['__baseRngState'] = w.baseRng.state()
  out['__levelChecksum'] = levelChecksum(w.level)
  return stableStringify(out)
}
