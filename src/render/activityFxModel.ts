// Pure view-model for settlers at their activities: WHAT to draw, decided
// from the entities alone. The pixi layer (activityFx.ts) only draws it.
//
//   fans    a hand of cards held in front of every seated card player
//   flips   once play is on, each player lays a card on the table every beat:
//           it slides from hand to table, turning face-up halfway
//   piles   the cards already down, in the middle of the table
//   badges  a card over each card player's head: face-down while it waits
//           for the table to fill, flipping face-up on its own beat in play
//   sparks  a tinkerer's work light flickering at the bench
//   snores  a rising "z" over a settler resting in a bunk
//
// Ticks, not wall-clock, and only `pos`, `facing` and the shown activity are
// read, so a host and a client (which sees the activity through the snapshot)
// draw the same thing, and a replay draws it again.

import type { Entity } from '../game/entity'
import { shownActivity } from '../game/systems/activities'

/** A card in flight from a player's hand to the table. */
export interface FlipFx {
  x: number
  y: number
  /** Card heading, radians (the player's facing). */
  angle: number
  /** Horizontal squash, 0..1: the card is edge-on at 0 mid-turn. */
  width: number
  faceUp: boolean
  alpha: number
}

export interface ActivityFxUi {
  fans: { x: number; y: number; angle: number }[]
  flips: FlipFx[]
  piles: { x: number; y: number; angle: number }[]
  badges: { x: number; y: number; width: number; faceUp: boolean }[]
  sparks: { x: number; y: number; alpha: number }[]
  snores: { x: number; y: number; alpha: number }[]
}

/** Ticks between one player's cards. */
export const CARD_BEAT = 40
/** Ticks a laid card takes from hand to table. */
const FLIGHT = 16
const HAND = 0.35
/** A seat is a chair one tile from its table, so the table is 1 tile ahead. */
const TABLE = 0.95
/** How far above a body's feet its head badge floats, tiles. */
const BADGE_RISE = 1.75

export const activityFx = (entities: readonly Entity[], tick: number): ActivityFxUi => {
  const ui: ActivityFxUi = { fans: [], flips: [], piles: [], badges: [], sparks: [], snores: [] }
  for (const e of entities) {
    if (e.dead) continue
    const shown = shownActivity(e)
    if (!shown) continue
    const fx = Math.cos(e.facing)
    const fy = Math.sin(e.facing)
    // Players at one table lay their cards in turn rather than all at once.
    const t = (tick + e.id * 13) % CARD_BEAT
    if (shown.kind === 'cards') {
      ui.fans.push({ x: e.pos.x + fx * HAND, y: e.pos.y + fy * HAND, angle: e.facing })
      if (!shown.playing) {
        ui.badges.push({ x: e.pos.x, y: e.pos.y - BADGE_RISE, width: 1, faceUp: false })
        continue
      }
      ui.piles.push({ x: e.pos.x + fx * TABLE, y: e.pos.y + fy * TABLE, angle: e.facing + (e.id % 5) * 0.4 })
      const turn = Math.min(1, t / FLIGHT)
      ui.badges.push({ x: e.pos.x, y: e.pos.y - BADGE_RISE, width: Math.abs(Math.cos(Math.PI * turn)), faceUp: turn >= 0.5 })
      if (t < FLIGHT + 10) {
        const d = HAND + (TABLE - HAND) * turn
        ui.flips.push({
          x: e.pos.x + fx * d,
          y: e.pos.y + fy * d,
          angle: e.facing,
          width: Math.abs(Math.cos(Math.PI * turn)),
          faceUp: turn >= 0.5,
          alpha: t < FLIGHT ? 1 : 1 - (t - FLIGHT) / 10,
        })
      }
    } else if (shown.kind === 'tinker' && shown.playing) {
      if (t % 6 < 3) ui.sparks.push({ x: e.pos.x + fx * 0.6, y: e.pos.y + fy * 0.6, alpha: t % 12 < 6 ? 1 : 0.6 })
    } else if (shown.kind === 'rest' && shown.playing) {
      const p = t / CARD_BEAT
      ui.snores.push({ x: e.pos.x + 0.2 + p * 0.3, y: e.pos.y - BADGE_RISE + 0.4 - p * 0.6, alpha: 1 - p })
    }
  }
  return ui
}
