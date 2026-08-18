/**
 * Durable storage for a joiner's REJOIN CLAIM — the seat + secret the host needs
 * to recognise a returning player instead of treating them as a newcomer.
 *
 * Why this exists: the host mints a rejoin token per admitted peer and parks the
 * dropped player's avatar as a "ghost" for 90 s. `NetClientSession` used to hold
 * that token only in memory, so an app restart or a webview kill lost it. The
 * host then had nothing to match on, and every reconnect became a FRESH
 * late-join: a new slot, a new avatar, while the previous ghost still reserved
 * the old seat for the rest of the grace window. One flaky phone measurably ate
 * slots 1→7 by itself and then got `lobby full` — locking its own owner out —
 * and left seven un-driven bodies standing in the level.
 *
 * Mechanism, deliberately: the SAME one `persistence.ts` uses for the save game —
 * the injected `KeyValueStore` seam over `localStorage`, a `sporefall.*` key, a
 * versioned JSON envelope, and reads/writes that NEVER throw. Separate key,
 * separate concern (settings.ts and input/remap.ts split the same way); no
 * second storage mechanism.
 *
 * Layer boundary: `localStorage` is a DOM API and `Date.now()` is wall clock, so
 * all of this lives in `src/app/`. The sim (`src/game/`) never sees either.
 *
 * SCOPING is the load-bearing property. A persisted token outlives the run that
 * issued it, so it WILL be presented to some later run — the host's own next
 * session, a friend's phone, a "New Seed". Every record therefore carries the
 * `runId` of the host session that minted it, and the host ignores a claim
 * stamped with anyone else's (netHost.ts). The ghost table remains the real
 * gate; `runId` makes a cross-run match impossible rather than merely unlikely,
 * and the TTL below stops an ancient record being offered at all.
 */

import type { KeyValueStore } from './persistence'

/** The single slot a rejoin claim occupies. Brand-new key — nothing to migrate. */
export const REJOIN_KEY = 'sporefall.rejoin'

/** Envelope schema version. Bump to invalidate every stored claim at once; a
 * mismatch discards the record and the player simply late-joins as before. */
export const REJOIN_VERSION = 1

/**
 * How long a stored claim may be offered to a host, in wall-clock ms.
 *
 * The host's ghost window is 90 s of SIM time (`REJOIN_GRACE_TICKS`), so a claim
 * older than that can no longer match anything. This is deliberately several
 * times larger: the host only advances sim ticks while it is running, the record
 * is refreshed on a cadence rather than continuously, and a phone's relaunch is
 * not instant — expiring too eagerly would throw away a seat the host would
 * still have handed back. It is hygiene, not security: the authority on whether
 * a claim is good is the host's ghost table, never this clock.
 */
export const REJOIN_TTL_MS = 5 * 60_000

/** Everything the host needs to hand a returning player their own seat back. */
export interface RejoinRecord {
  v: number
  /** Identity of the HOST SESSION that issued the token. A claim carrying anyone
   * else's is a token from a different run and is ignored by the host. */
  runId: string
  /** The seat we were admitted to. Never 0 — that is the host's own. */
  slot: number
  /** The secret the host matches against its ghost table. */
  token: string
  /** Wall-clock ms when last refreshed (app layer, never the sim). Drives the TTL. */
  savedAt: number
}

/** Longest token we will keep. The host mints 10 chars; anything wildly longer
 * is a corrupted or hostile blob and is not worth putting on a BLE link. */
const MAX_TOKEN_LEN = 64

/**
 * Validate an already-parsed value as a rejoin record. Every field is checked:
 * a truncated write, a half-overwritten blob or a hand-edited one must be
 * REFUSED rather than turned into a malformed Hello on the wire.
 */
export const isRejoinRecord = (raw: unknown): raw is RejoinRecord => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const r = raw as Partial<RejoinRecord>
  if (r.v !== REJOIN_VERSION) return false
  if (typeof r.runId !== 'string' || r.runId.length === 0) return false
  if (typeof r.token !== 'string' || r.token.length === 0 || r.token.length > MAX_TOKEN_LEN) return false
  // Slot 0 is the host's own seat and is never issued to a client, so a record
  // claiming it cannot be genuine — and must never be offered to a host.
  if (typeof r.slot !== 'number' || !Number.isInteger(r.slot) || r.slot < 1) return false
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return false
  return true
}

/** Wipe the claim. Quota/private-mode failures are non-fatal. */
export const clearRejoin = (store: KeyValueStore): void => {
  try {
    store.removeItem(REJOIN_KEY)
  } catch {
    // ignore — a claim we cannot delete is one the host will simply refuse
  }
}

/** Persist the claim. Non-fatal on quota/private-mode failure: the player just
 * loses the ability to rejoin after an app restart, exactly as before this
 * feature existed. */
export const writeRejoin = (store: KeyValueStore, rec: RejoinRecord): void => {
  try {
    store.setItem(REJOIN_KEY, JSON.stringify(rec))
  } catch {
    // Private-mode / quota failures are non-fatal; degrade to in-memory only.
  }
}

/**
 * Read + validate the stored claim, or `null` when there is none / it is
 * corrupt / the version drifted / it aged out. Anything unusable is DROPPED from
 * storage on the way out so a bad blob cannot wedge every subsequent boot —
 * the same discipline `readSave` applies to the save game.
 *
 * `now` is injected (wall-clock ms) so the TTL is unit-testable.
 */
export const readRejoin = (store: KeyValueStore, now: number): RejoinRecord | null => {
  let raw: string | null
  try {
    raw = store.getItem(REJOIN_KEY)
  } catch {
    return null // storage itself is unavailable — behave as if there is no claim
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearRejoin(store)
    return null
  }
  if (!isRejoinRecord(parsed)) {
    clearRejoin(store)
    return null
  }
  // A NEGATIVE age is a clock that stepped backwards (NTP, DST, manual change),
  // not a stale record — keep it and let the host's ghost table decide.
  if (now - parsed.savedAt > REJOIN_TTL_MS) {
    clearRejoin(store)
    return null
  }
  return parsed
}
