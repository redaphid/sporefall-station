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
  /** Per-branch beta BUILDS served at /betas/<slug>/ — see betas.ts. A whole
   * Vite `dist/` per branch, so this namespace is by far the largest and the
   * most disposable of the three: deleting every key in it costs a re-push of
   * the branch, while the same act on REVIEW_IMAGES breaks published PR bodies
   * and on WORLDS breaks shared `?state=` links. That difference in blast
   * radius is why it is its own namespace and not a key prefix on one of them. */
  BETAS: KVNamespace
}
