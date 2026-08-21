/** Bindings the Worker entry (index.ts) receives. Kept in its own module so
 * both the entry and the OTA handler can import it without a circular ref. */
export interface Env {
  /** Static assets (the built `dist/` game) — see wrangler.jsonc `assets`. */
  ASSETS: Fetcher
  /** One Durable Object instance per multiplayer room (RoomDO). */
  ROOM: DurableObjectNamespace
  /** Review-only before/after images served at /review/* — see reviewImages.ts.
   * Kept OUT of the game bundle on purpose: they are PR artefacts, not assets. */
  REVIEW_IMAGES: KVNamespace
  /** Serialized worlds served at /state/* — see worldStore.ts. Shareable debug
   * links today (`?state=<id>`); the store is deliberately not narrower than
   * that, since a saved game or a hand-built level is the same kind of blob.
   * A separate namespace from REVIEW_IMAGES on purpose: different lifetime
   * (30-day TTL vs permanent), different writer (the running game vs a local
   * script), and different blast radius if one ever needs purging. */
  WORLDS: KVNamespace
}
