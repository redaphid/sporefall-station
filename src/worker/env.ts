/** Bindings the Worker entry (index.ts) receives. Kept in its own module so
 * both the entry and the OTA handler can import it without a circular ref. */
export interface Env {
  /** Static assets (the built `dist/` game) — see wrangler.jsonc `assets`. */
  ASSETS: Fetcher
  /** One Durable Object instance per multiplayer room (RoomDO). */
  ROOM: DurableObjectNamespace
}
