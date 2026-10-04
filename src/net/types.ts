export type PeerId = string

/**
 * The wire contract between two peers. The host refuses any `Hello` whose `v`
 * differs (see netHost.ts), and the client surfaces that as the `rejected`
 * phase — so a mismatch is a clean, explained refusal.
 *
 * **Bump this whenever the wire format changes, and appending to `ARCHETYPES`
 * counts.** That list is an append-only `u8` index, and an index the receiver
 * does not know decodes as `ARCHETYPES[i] ?? 'player'` (messages.ts). So two
 * builds that disagree about the table both claim the same version, sail
 * through the gate, and then the older peer quietly renders every new object
 * as another copy of the player. Nothing errors; the game just lies.
 *
 * 13 — online play goes peer to peer over WebRTC, with the relay as fallback.
 *     Input carries a bundle of the last few records instead of one command,
 *     snapshots and GameStart carry the host's run epoch, and every relay frame
 *     from an online peer starts with a lane tag (rtcTransport.ts).
 * 12 — Ping/Pong (21/22) for online link health, and Bye (20). A peer that
 *     does not know a message type reads it as a framing desync.
 * 11 — `StateMsg.extraction` is gone with the extraction mission, and the cash
 *     terminal's archetype is a tombstone in `ARCHETYPES` (indices unchanged).
 * 10 — `ARCHETYPES` strings and the `Faction` ids renamed in place by the
 *     lore-rename codemod (mutant, warden, acolyte, lockkeeper, pickup.wrench,
 *     pickup.canister; rootcult). Indices are unchanged, but an old peer would
 *     decode them as archetypes this build no longer defines.
 * 9 — snapshots gain a sparse activity trailer after the status one: which
 *     settlers sit at a card table, bench or bunk, and whether play is on, so
 *     a client draws the card game. An old peer would never see it.
 * 8 — reserved for #156 while 9 was assigned; #156 landed as 12.
 * 7 — no wire change, but floor 2 now draws its district (slums, Still Row
 *     or the Culture Beds) from the seed, and the two reworked districts lay
 *     out differently. Layout is regenerated locally, as in 6.
 * 6 — no wire change, but every floor from 3 now builds as the indoor complex
 *     (4, 6, 8… were city) with a seeded biome order. Layout never crosses the
 *     wire (a client regenerates it from seed+floor), so an old client would
 *     walk a different map from its host on those floors with nothing on
 *     screen saying so.
 * 5 — snapshots gain a sparse element-status trailer (frozen/burning/wet/...),
 *     so a client draws statused enemies. An old peer would ignore it silently.
 * 4 — the group roster appended (88 -> 95): drowner, bellwether, mender,
 *     breacher, lobber, gloamhound, hivespire — raids, hound packs and hive
 *     spires now spawn in play, so an old peer would draw them as Rangers.
 * 3 — `chair` appended (87 -> 88): the interior layout pass seats chairs at
 *     desks, round tables and facing screens, so a chair is now spawnable.
 * 2 — 59 archetypes appended (28 -> 87), so every spawnable object is
 *     registered rather than only the enemies.
 * 1 — initial.
 */
export const PROTOCOL_VERSION = 13

/** GATT service/characteristic UUIDs (BLE transport). */
export const BLE_SERVICE_UUID = '5f47a3c0-9b1e-4a52-8f6d-2c3e4b5a6d70'
export const BLE_DATA_H2C_UUID = '5f47a3c1-9b1e-4a52-8f6d-2c3e4b5a6d70'
export const BLE_DATA_C2H_UUID = '5f47a3c2-9b1e-4a52-8f6d-2c3e4b5a6d70'
/**
 * Reserved: ...a3c3 is the fourth UUID in this allocated block; the other three
 * are live. It is CLAIMED, not unused — it records that this value is spoken for
 * in the same address space as the three above it. Deleting it because nothing
 * calls it would silently hand the value back to the pool, and a later feature
 * could then allocate ...a3c3 for something else and collide with a meaning
 * already shipped to peers in the field. A dead-code tool can't see any of this:
 * for a UUID the VALUE is the whole point and the call sites are irrelevant, so
 * "no references" carries none of its usual meaning.
 *
 * @protocolReservation
 */
export const BLE_LOBBY_INFO_UUID = '5f47a3c3-9b1e-4a52-8f6d-2c3e4b5a6d70'

/**
 * Max simultaneous players in one run (host + clients). Slots run 0..MAX_PLAYERS-1;
 * the host always owns slot 0, so up to MAX_PLAYERS-1 remote clients may join.
 * Raised from 4→8 for large local groups (stress/8-players). NOTE: over BLE the
 * host peripheral's radio caps concurrent centrals well below this (commonly ~7,
 * device-specific) — this constant is the protocol/sim ceiling, not a promise the
 * transport can carry it. The BroadcastChannel/web path has no such radio limit.
 * The online relay (src/worker/roomRelay.ts) caps a room's clients from it too.
 */
export const MAX_PLAYERS = 8

export const SNAPSHOT_INTERVAL_TICKS = 3 // 10Hz at 30Hz sim

/** First byte of every message. */
export const MsgType = {
  // Binary hot path
  Snapshot: 1,
  Input: 2,
  // JSON cold path (lobby/control/events)
  Hello: 10,
  Welcome: 11,
  Reject: 12,
  LobbyState: 13,
  GameStart: 14,
  Ready: 15,
  Go: 16,
  Events: 17,
  State: 18,
  /** Host → one client: that client's OWN full authoritative inventory
   * (slots/activeSlot/mods/ammo). Reliable, sent only on change. */
  Inventory: 19,
  /** Host → every client: the host left on purpose (Main menu). The client
   * ends the run and does not try to reconnect. An older client that does not
   * know it simply sees the link drop. */
  Bye: 20,
  /** Client → host, once a second in online play: `{ t }`, the client's clock,
   * plus `rtt`, its newest measured round trip, so the host can show it too. */
  Ping: 21,
  /** Host → that client, at once: the Ping's `t` echoed back. */
  Pong: 22,
} as const

const KNOWN_MSG_TYPES: ReadonlySet<number> = new Set(Object.values(MsgType))

/** Does this first byte name a real message? The framing layer uses it to tell
 * a genuine message start from payload bytes that merely parse as a header. */
export const isKnownMsgType = (t: number): boolean => KNOWN_MSG_TYPES.has(t)

/** What carries a session. It decides what the player is told about the link,
 * and whether silence on it is treated as a dead connection (online only). */
export type LinkMedium = 'bluetooth' | 'online' | 'local'

/** `left`: the peer is gone for good, as the relay reports when the host's
 * socket closes. Nothing will answer a reconnect. */
export type DropReason = 'remote' | 'local' | 'error' | 'left'

/** What carries an online peer right now: a direct WebRTC link, or the relay. */
export type LinkPath = 'p2p' | 'relay'

export type TransportEvent =
  | { type: 'peerConnected'; peer: PeerId }
  | { type: 'peerDisconnected'; peer: PeerId; reason: DropReason }
  /** `datagram`: `bytes` is one whole message from the unreliable lane, not a
   * packet of the framed stream. */
  | { type: 'data'; peer: PeerId; bytes: Uint8Array; datagram?: boolean }
  /** The peer moved to another path mid-session. Reliable messages in flight on
   * the old path may be lost. */
  | { type: 'pathChanged'; peer: PeerId; path: LinkPath }

export interface Transport {
  readonly role: 'host' | 'client'
  readonly medium: LinkMedium
  /** Max bytes per sendPacket call (BLE: MTU-3 clamped to 244; dev: 4096). */
  readonly maxPacket: number
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Ordered, reliable-while-connected delivery of one packet.
   * Resolves when the underlying stack accepts it — this paces the send queue.
   */
  sendPacket(peer: PeerId, bytes: Uint8Array): Promise<void>
  on(handler: (e: TransportEvent) => void): () => void
  peers(): PeerId[]
  /**
   * Send one whole message on an unreliable, unordered lane, if one is open to
   * `peer` right now. Returns false when there is none, or the message would not
   * fit one datagram, and the caller falls back to `sendPacket`.
   */
  sendDatagram?(peer: PeerId, msg: Uint8Array): boolean
  /** Which path carries `peer`, for transports that have more than one. */
  pathOf?(peer: PeerId): LinkPath | undefined
  /** Client transports: re-establish the link to the same host after a drop. */
  reconnect?(): Promise<void>
  /** Host transports that can: hang up on one peer the host refused, so it
   * stops holding a seat. Called after the Reject has gone out. */
  drop?(peer: PeerId): Promise<void>
}
