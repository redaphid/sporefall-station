/**
 * Save-game persistence for the in-progress run. A full-page reload otherwise
 * loses the world; this module serializes the AUTHORITATIVE world to
 * localStorage and rebuilds it on the next boot so the player seamlessly rejoins.
 *
 * It leans entirely on `serializeWorld`/`deserializeWorld` (src/game/serialize.ts),
 * which round-trip the whole world INCLUDING the PRNG stream position — so a
 * restored world continues BIT-EXACT (same seed + same inputs → identical ticks).
 *
 * Layer boundary: localStorage is a DOM API, so all of this lives in `src/app/`;
 * the sim (`src/game/`) stays pure. `Date.now()` is used only for the envelope's
 * informational `savedAt` stamp — the app layer, not the sim, so determinism is
 * untouched. The store is injected (`KeyValueStore`) so the logic is unit-testable
 * without a real browser.
 */

import { deserializeWorld, serializeWorld, type WorldJson } from '../game/serialize'
import type { World } from '../game/world'

/** Minimal localStorage-shaped seam so the pure logic can be tested against an
 * in-memory map. `window.localStorage` satisfies this interface as-is. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The single slot an in-progress run occupies. */
export const SAVE_KEY = 'sor.savegame'

/**
 * Envelope schema version — bump to invalidate ALL prior saves whenever a
 * breaking change lands in the envelope shape or in how a WorldJson must be
 * interpreted. Independent of `WorldJson.v` (which serialize.ts owns): a version
 * mismatch here discards the save and starts a fresh run rather than crashing.
 */
export const SAVE_VERSION = 1

/** Versioned on-disk wrapper around a WorldJson snapshot. */
export interface SaveEnvelope {
  v: number
  /** Wall-clock ms when written (informational — app layer, never the sim). */
  savedAt: number
  world: WorldJson
}

/** Serialize + wrap a live world into the versioned envelope. Pure. */
export const makeEnvelope = (world: World, now: number): SaveEnvelope => ({
  v: SAVE_VERSION,
  savedAt: now,
  world: serializeWorld(world),
})

/**
 * Validate an already-parsed value as a save envelope and rebuild the World, or
 * return `null` if it is the wrong version, malformed, or fails to deserialize
 * (e.g. level-checksum drift). NEVER throws — a bad save must fall back to a
 * fresh game, not crash the boot.
 */
export const restoreEnvelope = (raw: unknown): World | null => {
  try {
    if (typeof raw !== 'object' || raw === null) return null
    const env = raw as Partial<SaveEnvelope>
    if (env.v !== SAVE_VERSION) return null // schema drift → discard
    if (typeof env.world !== 'object' || env.world === null) return null
    return deserializeWorld(env.world as WorldJson)
  } catch {
    return null // corrupt snapshot / checksum drift / any deserialize failure
  }
}

/** Wipe the save slot. Quota/private-mode failures are non-fatal. */
export const clearSave = (store: KeyValueStore): void => {
  try {
    store.removeItem(SAVE_KEY)
  } catch {
    // ignore
  }
}

/** Serialize + write the world to the save slot. Non-fatal on quota/private-mode
 * failure — the run simply won't persist. */
export const writeSave = (store: KeyValueStore, world: World, now: number): void => {
  try {
    store.setItem(SAVE_KEY, JSON.stringify(makeEnvelope(world, now)))
  } catch {
    // Private-mode / quota failures are non-fatal; the run just won't persist.
  }
}

/**
 * Read + validate the save slot into a live World, or `null` when there is no
 * save / it is corrupt / the version mismatches. A save that fails to parse or
 * restore is DROPPED here so a broken blob can't wedge every subsequent boot.
 */
export const readSave = (store: KeyValueStore): World | null => {
  let raw: string | null
  try {
    raw = store.getItem(SAVE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearSave(store) // garbage JSON — drop it so we don't choke on every boot
    return null
  }
  const world = restoreEnvelope(parsed)
  if (!world) clearSave(store) // version drift / bad snapshot — discard
  return world
}

/** ~1.5 s of sim time at SIM_RATE=30. Throttle cadence: JSON-serializing the
 * world every tick would be wasteful, so we save at most once per this many
 * ADVANCED sim ticks (and only when the world actually moved). */
export const DEFAULT_SAVE_INTERVAL_TICKS = 45

/** A throttled, world-aware save driver. `maybeSave` is cheap to call every
 * frame; `flush` forces a write on unload. */
export interface Persister {
  /** Write at most once per `intervalTicks` of advanced sim time, and only when
   * the world has moved since the last save (a paused/idle world is a no-op). */
  maybeSave(world: World): void
  /** Force an immediate write iff the world advanced since the last save. Use on
   * pagehide / visibility-hidden / beforeunload. */
  flush(world: World): void
  /** Discard the save and reset the throttle (new run / game-over overwrite). */
  clear(): void
}

export const createPersister = (
  store: KeyValueStore,
  opts: { intervalTicks?: number; now?: () => number } = {},
): Persister => {
  const intervalTicks = opts.intervalTicks ?? DEFAULT_SAVE_INTERVAL_TICKS
  const now = opts.now ?? (() => Date.now())
  // -Infinity so the first eligible call saves promptly, then cadence takes over.
  let lastSavedTick = -Infinity
  const save = (world: World): void => {
    writeSave(store, world, now())
    lastSavedTick = world.tick
  }
  return {
    maybeSave(world) {
      if (world.tick - lastSavedTick >= intervalTicks) save(world)
    },
    flush(world) {
      // Only when the world advanced — a hidden/shown flap with no ticks between
      // shouldn't re-serialize identical state.
      if (world.tick !== lastSavedTick) save(world)
    },
    clear() {
      clearSave(store)
      lastSavedTick = -Infinity
    },
  }
}
