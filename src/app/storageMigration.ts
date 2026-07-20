/**
 * One-time localStorage key migration for the Backseat → Sporefall Station
 * rebrand. The rebrand renamed every persisted key (`sor.*` → `sporefall.*`).
 * Without this, the FIRST reload after the rename would orphan a live player's
 * in-progress run, feel settings, and pad remap under the now-unread old keys —
 * a player mid-floor would silently lose their run.
 *
 * The rule, applied once before each new key is first read: if the new key is
 * absent but the legacy key still holds a value, copy the value across and drop
 * the legacy key (so the migration happens exactly once and the old slot is
 * reclaimed). Best-effort and NEVER throws — a private-mode/quota failure just
 * leaves the legacy value in place, where the caller's own read path can still
 * find it on a later boot.
 *
 * `window.localStorage` satisfies `LocalStorageLike` structurally, as does the
 * in-memory `KeyValueStore` seam in persistence.ts — so this is a pure,
 * DOM-free, unit-testable function.
 */
export interface LocalStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Copy `legacyKey`'s value to `newKey` (and remove the legacy key) iff `newKey`
 * is currently absent and `legacyKey` is present. No-op otherwise. Swallows any
 * storage error so a failed migration can never wedge a boot. */
export const migrateLegacyKey = (store: LocalStorageLike, newKey: string, legacyKey: string): void => {
  try {
    if (store.getItem(newKey) !== null) return // the new key already owns the slot
    const legacy = store.getItem(legacyKey)
    if (legacy === null) return // nothing to migrate
    store.setItem(newKey, legacy)
    store.removeItem(legacyKey)
  } catch {
    // Best-effort: on quota/private-mode failure, leave the legacy value in place
    // so the caller's direct read (or a later boot) can still recover it.
  }
}
