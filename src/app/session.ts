import type { Entity } from '../game/entity'
import type { Level } from '../game/levelgen/level'
import type { SimEvent } from '../game/types'

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
}
