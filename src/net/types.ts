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
 * 3 — `chair` appended (87 -> 88): the interior layout pass seats chairs at
 *     desks, round tables and facing screens, so a chair is now spawnable.
 * 2 — 59 archetypes appended (28 -> 87), so every spawnable object is
 *     registered rather than only the enemies.
 * 1 — initial.
 */
export const PROTOCOL_VERSION = 3

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

export const SNAPSHOT_INTERVAL_TICKS = 3 // 10Hz at 30Hz sim
export const INPUT_SEND_HZ = 20

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
} as const
export type MsgTypeId = (typeof MsgType)[keyof typeof MsgType]

const KNOWN_MSG_TYPES: ReadonlySet<number> = new Set(Object.values(MsgType))

/** Does this first byte name a real message? The framing layer uses it to tell
 * a genuine message start from payload bytes that merely parse as a header. */
export const isKnownMsgType = (t: number): boolean => KNOWN_MSG_TYPES.has(t)

export type TransportEvent =
  | { type: 'peerConnected'; peer: PeerId }
  | { type: 'peerDisconnected'; peer: PeerId; reason: 'remote' | 'local' | 'error' }
  | { type: 'data'; peer: PeerId; bytes: Uint8Array }

export interface Transport {
  readonly role: 'host' | 'client'
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
  /** Client transports: re-establish the link to the same host after a drop. */
  reconnect?(): Promise<void>
}
