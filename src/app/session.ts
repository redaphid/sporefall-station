import type { Entity } from '../game/entity'
import type { Level } from '../game/levelgen/level'
import type { SimEvent } from '../game/types'
import type { RunMode } from '../game/world'

/** What the render layer consumes each frame. */
export interface RenderView {
  entities: readonly Entity[]
  events: readonly SimEvent[]
  tick: number
  level: Level
  floor: number
  missionText: string
  missionComplete: boolean
  gameOver: boolean
  /** Difficulty rules in force (host truth; clients mirror it from the host). */
  mode?: RunMode
  /** Party-shared comebacks left this run (only meaningful in `normal`). */
  revivesLeft?: number
  /** The entity this device's player controls (camera target, HUD). */
  self?: Entity
}

/**
 * The solo/host/client seam. HostSession runs the authoritative sim
 * (solo = host with no remote peers); ClientSession (M5) syncs from the net.
 */
export interface Session {
  /** Advance one fixed sim step. */
  tick(): void
  renderView(): RenderView
  /** Local co-op pause (host-only); other sessions leave it undefined. */
  isPaused?: boolean
  /**
   * Reset to a fresh run in place, WITHOUT touching the transport — the BLE
   * connection and joined peers survive, so co-op can play again after a
   * game-over with no reconnect or app restart. Authoritative sessions
   * (solo/host) implement it; a client leaves it undefined and waits for the
   * host's restart to arrive over the existing link.
   */
  restart?(): void
}
