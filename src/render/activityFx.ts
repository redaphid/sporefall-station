// Draws activityFxModel's output: the hand of cards each card player holds,
// the card laid on the table each beat (turning face-up halfway), a
// tinkerer's work light, and the "z" over a resting settler. World-space,
// mounted inside the effects layer so it rides the camera. Presentational only.

import { Container, Graphics } from 'pixi.js'
import type { Entity } from '../game/entity'
import { TILE_PX } from './art'
import { activityFx, type ActivityFxUi } from './activityFxModel'

const CARD_BACK = 0x2f6fd6
const CARD_FACE = 0xf4efe2
const CARD_EDGE = 0xffffff
const PIP = 0xc8202a
const SPARK = 0xffe08a
const SNORE = 0xcfe3ff

export class ActivityFxLayer {
  readonly root = new Container()
  private g = new Graphics()

  /** The current model output (also handy for inspection from the console). */
  last: ActivityFxUi = { fans: [], flips: [], piles: [], badges: [], sparks: [], snores: [] }

  constructor() {
    this.root.eventMode = 'none'
    this.root.zIndex = 1e7
    this.root.addChild(this.g)
  }

  update(entities: readonly Entity[], tick: number): void {
    const ui = activityFx(entities, tick)
    this.last = ui
    const g = this.g
    g.clear()
    const T = TILE_PX
    const cw = T * 0.26
    const ch = T * 0.36

    for (const p of ui.piles) {
      card(g, p.x * T, p.y * T, p.angle, cw, ch, CARD_FACE, 1)
      g.circle(p.x * T, p.y * T, cw * 0.2).fill({ color: PIP })
    }

    for (const f of ui.fans) {
      // Three cards fanned across the facing, backs out.
      for (let k = -1; k <= 1; k++) {
        const a = f.angle + Math.PI / 2 + k * 0.35
        const cx = f.x * T + Math.cos(f.angle + Math.PI / 2) * k * cw * 0.6
        const cy = f.y * T + Math.sin(f.angle + Math.PI / 2) * k * cw * 0.6
        card(g, cx, cy, a, cw, ch, CARD_BACK, 1)
      }
    }
    for (const f of ui.flips) {
      card(g, f.x * T, f.y * T, f.angle + Math.PI / 2, cw * Math.max(0.08, f.width), ch, f.faceUp ? CARD_FACE : CARD_BACK, f.alpha)
      if (f.faceUp && f.width > 0.4) g.circle(f.x * T, f.y * T, cw * 0.2 * f.width).fill({ color: PIP, alpha: f.alpha })
    }
    for (const b of ui.badges) {
      const bw = cw * 1.5 * Math.max(0.08, b.width)
      card(g, b.x * T, b.y * T, Math.PI / 2, bw, ch * 1.5, b.faceUp ? CARD_FACE : CARD_BACK, 1)
      if (b.faceUp && b.width > 0.4) g.circle(b.x * T, b.y * T, cw * 0.3 * b.width).fill({ color: PIP })
    }
    for (const s of ui.sparks) {
      g.circle(s.x * T, s.y * T, T * 0.16).fill({ color: SPARK, alpha: 0.3 * s.alpha })
      g.circle(s.x * T, s.y * T, T * 0.06).fill({ color: 0xffffff, alpha: s.alpha })
    }
    for (const z of ui.snores) {
      const x = z.x * T
      const y = z.y * T
      const r = T * 0.12
      g.moveTo(x - r, y - r)
        .lineTo(x + r, y - r)
        .lineTo(x - r, y + r)
        .lineTo(x + r, y + r)
        .stroke({ color: SNORE, width: 2.5, alpha: z.alpha })
    }
  }
}

/** A card centred on (cx, cy), long side along `angle`. */
const card = (g: Graphics, cx: number, cy: number, angle: number, w: number, h: number, color: number, alpha: number): void => {
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const vx = -uy
  const vy = ux
  const hw = w / 2
  const hh = h / 2
  g.poly([
    cx - vx * hw - ux * hh,
    cy - vy * hw - uy * hh,
    cx + vx * hw - ux * hh,
    cy + vy * hw - uy * hh,
    cx + vx * hw + ux * hh,
    cy + vy * hw + uy * hh,
    cx - vx * hw + ux * hh,
    cy - vy * hw + uy * hh,
  ])
    .fill({ color, alpha })
    .stroke({ color: CARD_EDGE, width: 1, alpha })
}
