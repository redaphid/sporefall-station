// Draws groupFxModel's output: the sapper's planted charge (blinking light,
// blast ring, countdown), the breach shockwave, the medic's heal beam, the
// green cross over a raider falling back to be healed, and the ring under the
// Bog Mender. World-space, so it rides the camera like the effects layer it
// is mounted inside. Presentational only.

import { Container, Graphics, Text } from 'pixi.js'
import type { RenderView } from '../app/session'
import { TILE_PX } from './art'
import { createGroupFxTracker, type GroupFxUi } from './groupFxModel'

const CHARGE_RED = 0xff3b2f
const CHARGE_AMBER = 0xffb02e
const HEAL_GREEN = 0x6dff8a

export class GroupFxLayer {
  readonly root = new Container()
  private g = new Graphics()
  private labels: Text[] = []
  private tracker = createGroupFxTracker()

  constructor() {
    this.root.eventMode = 'none'
    // Mounted inside the y-sorted effects container: paint over every sprite.
    this.root.zIndex = 1e7
    this.root.addChild(this.g)
  }

  /** The current model output (also handy for inspection from the console). */
  last: GroupFxUi = { charges: [], blasts: [], beams: [], retreaters: [], medics: [] }

  update(view: Pick<RenderView, 'tick' | 'events' | 'entities'>, elapsed: number): void {
    const ui = this.tracker.update(view)
    this.last = ui
    const g = this.g
    g.clear()
    const T = TILE_PX

    for (const m of ui.medics) {
      g.ellipse(m.x * T, (m.y + 0.35) * T, T * 0.55, T * 0.22).stroke({ color: HEAL_GREEN, width: 2, alpha: 0.55 })
    }
    for (const b of ui.beams) {
      g.moveTo(b.x1 * T, b.y1 * T)
        .lineTo(b.x2 * T, b.y2 * T)
        .stroke({ color: HEAL_GREEN, width: 7, alpha: 0.25 * b.alpha })
      g.moveTo(b.x1 * T, b.y1 * T)
        .lineTo(b.x2 * T, b.y2 * T)
        .stroke({ color: 0xeaffef, width: 2.5, alpha: 0.9 * b.alpha })
      g.circle(b.x2 * T, b.y2 * T, T * (0.3 + 0.35 * (1 - b.alpha))).stroke({ color: HEAL_GREEN, width: 3, alpha: b.alpha })
    }
    // A bobbing green cross over each raider running back to be patched.
    const bob = Math.sin(elapsed * 6) * 2
    for (const r of ui.retreaters) {
      const cx = r.x * T
      const cy = (r.y - 0.95) * T + bob
      const a = T * 0.2
      const t = T * 0.07
      g.rect(cx - a, cy - t, 2 * a, 2 * t).fill({ color: HEAL_GREEN, alpha: 0.95 })
      g.rect(cx - t, cy - a, 2 * t, 2 * a).fill({ color: HEAL_GREEN, alpha: 0.95 })
    }

    let used = 0
    for (const c of ui.charges) {
      const cx = c.x * T
      const cy = c.y * T
      // Danger zone: the blast radius, filling in as the fuse burns down.
      const burnt = 1 - c.ticksLeft / Math.max(1, c.fuse)
      g.circle(cx, cy, c.radius * T).fill({ color: CHARGE_RED, alpha: 0.08 + 0.17 * burnt })
      g.circle(cx, cy, c.radius * T).stroke({ color: CHARGE_RED, width: 2, alpha: 0.8 })
      // The charge itself, and its blinking light.
      g.rect(cx - T * 0.18, cy - T * 0.12, T * 0.36, T * 0.24).fill({ color: 0x2a2320 }).stroke({ color: CHARGE_AMBER, width: 1.5 })
      if (c.lit) {
        g.circle(cx, cy, T * 0.34).fill({ color: CHARGE_RED, alpha: 0.35 })
        g.circle(cx, cy, T * 0.12).fill({ color: 0xffe0d0 })
      }
      const label = this.label(used++)
      label.text = c.label
      label.position.set(cx, cy - c.radius * T - 2)
      label.style.fill = c.lit ? 0xffffff : CHARGE_AMBER
    }
    for (let i = used; i < this.labels.length; i++) this.labels[i].visible = false

    for (const b of ui.blasts) {
      g.circle(b.x * T, b.y * T, b.radius * T).stroke({ color: CHARGE_AMBER, width: 5, alpha: b.alpha })
      g.circle(b.x * T, b.y * T, b.radius * T * 0.7).stroke({ color: 0xffffff, width: 2, alpha: b.alpha * 0.8 })
    }
  }

  private label(i: number): Text {
    let t = this.labels[i]
    if (!t) {
      t = new Text({
        text: '',
        style: { fontFamily: 'monospace', fontSize: 14, fontWeight: 'bold', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
      })
      t.anchor.set(0.5, 1)
      this.labels[i] = t
      this.root.addChild(t)
    }
    t.visible = true
    return t
  }
}
