/**
 * How healthy the link to the other side is, and what the player is told about
 * it. Pure: the sessions feed in a clock reading and their own counters.
 *
 * A WebSocket can go silent with the socket still open (wifi to cell handoff,
 * a phone walking out of range of the router), and nothing below the game
 * notices for minutes. The online sessions therefore watch for SILENCE: the
 * host streams snapshots at 10 Hz and answers a ping every second, so two
 * seconds without a byte is already unusual and five is a dead link.
 */

import type { LinkMedium } from '../net/types'

export const PING_INTERVAL_MS = 1000
export const DEGRADED_AFTER_MS = 2000
export const STALLED_AFTER_MS = 5000

export type LinkHealth = 'good' | 'degraded' | 'stalled'

export const linkHealth = (silentMs: number): LinkHealth =>
  silentMs >= STALLED_AFTER_MS ? 'stalled' : silentMs >= DEGRADED_AFTER_MS ? 'degraded' : 'good'

export interface LinkStatus {
  health: LinkHealth
  /** Newest measured round trip, or null before the first pong. */
  rttMs: number | null
  /** `reconnecting`: re-establishing the link now. `ended`: it is over. */
  session: 'live' | 'reconnecting' | 'ended'
}

/** Round trips above this read as laggy even while bytes keep flowing. */
export const LAGGY_RTT_MS = 250

export type ChipTone = 'good' | 'fair' | 'bad'

/** The HUD chip for an online session: a tone and a few words. */
export const linkChip = (s: LinkStatus): { tone: ChipTone; text: string } => {
  if (s.session === 'ended') return { tone: 'bad', text: 'Disconnected' }
  if (s.session === 'reconnecting' || s.health === 'stalled') return { tone: 'bad', text: 'Reconnecting…' }
  if (s.health === 'degraded') return { tone: 'bad', text: 'Weak connection' }
  if (s.rttMs === null) return { tone: 'fair', text: 'Online' }
  const ms = Math.round(s.rttMs)
  return { tone: ms > LAGGY_RTT_MS ? 'fair' : 'good', text: `${ms} ms` }
}

/** Status lines a joining player sees, per medium. Online play never says
 * Bluetooth, and Bluetooth play keeps the advice that fits a radio. */
export const LINK_COPY: Record<LinkMedium, { reconnecting: string; lost: string; unreachable: string }> = {
  bluetooth: {
    reconnecting: 'Bluetooth dropped — reconnecting…',
    lost: 'Bluetooth connection lost',
    unreachable: 'Host never answered — move closer and reload to retry',
  },
  online: {
    reconnecting: 'Connection lost — reconnecting…',
    lost: 'Lost the connection to the host',
    unreachable: 'Host never answered — check the code and your connection',
  },
  local: {
    reconnecting: 'Host tab went quiet — reconnecting…',
    lost: 'Lost the host tab',
    unreachable: 'Host tab never answered — reload to retry',
  },
}
