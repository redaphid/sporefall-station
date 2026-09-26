// Draws verbMarkers' output over each NPC's head: a shaking double "!" for
// burning PANIC and a slashed eye for spore BLINDNESS. Shapes, not text, so
// they read with no colour vision and at any zoom. Mounted inside the y-sorted
// effects container (like groupFx) so no sprite paints over them.

import { Container, Graphics } from 'pixi.js'
import type { Entity } from '../game/entity'
import { TILE_PX } from './art'
import { verbMarks, type Verb } from './verbMarkers'

const PANIC = 0xff5a1f
const BLIND = 0x9cff6a
const INK = { color: 0x000000, alpha: 0.7 } as const

/** Tiles above the entity's position the mark is centred on (over the head). */
const HEAD_RISE = 1.15

export class VerbMarkerLayer {
  readonly root = new Container()
  private readonly g = new Graphics()

  constructor() {
    this.root.eventMode = 'none'
    this.root.zIndex = 1e7
    this.root.addChild(this.g)
  }

  refresh(): void {
    this.g.clear()
  }

  update(entities: readonly Entity[], alpha: number, tick: number): void {
    const g = this.g
    g.clear()
    const byId = new Map<number, Entity>()
    for (const e of entities) byId.set(e.id, e)
    const marks = verbMarks(entities, tick)
    // Two marks on one body sit side by side.
    const count = new Map<number, number>()
    for (const m of marks) count.set(m.id, (count.get(m.id) ?? 0) + 1)
    const drawn = new Map<number, number>()
    for (const m of marks) {
      const e = byId.get(m.id)!
      const n = count.get(m.id)!
      const i = drawn.get(m.id) ?? 0
      drawn.set(m.id, i + 1)
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha
      const cx = (x + (i - (n - 1) / 2) * 0.5) * TILE_PX
      const cy = (y - HEAD_RISE) * TILE_PX
      this.draw(m.verb, cx, cy, tick)
    }
  }

  private draw(verb: Verb, cx: number, cy: number, tick: number): void {
    const g = this.g
    const T = TILE_PX
    if (verb === 'panic') {
      // Two exclamation marks that shake: the body is running, not fighting.
      const jitter = ((tick * 7) % 3) - 1
      for (const dx of [-0.11, 0.11]) {
        const x = cx + dx * T + jitter
        const w = T * 0.09
        g.roundRect(x - w / 2, cy - T * 0.3, w, T * 0.34, w / 2).fill(PANIC).stroke({ ...INK, width: 1.5 })
        g.circle(x, cy + T * 0.16, w * 0.6).fill(PANIC).stroke({ ...INK, width: 1.5 })
      }
      return
    }
    // A slashed eye: it can't see you.
    const rx = T * 0.24
    const ry = T * 0.13
    g.ellipse(cx, cy, rx, ry).fill({ color: 0x0b1a08, alpha: 0.75 }).stroke({ color: BLIND, width: 2 })
    g.circle(cx, cy, ry * 0.55).fill(BLIND)
    g.moveTo(cx - rx, cy + ry * 1.3)
      .lineTo(cx + rx, cy - ry * 1.3)
      .stroke({ ...INK, width: 5 })
    g.moveTo(cx - rx, cy + ry * 1.3)
      .lineTo(cx + rx, cy - ry * 1.3)
      .stroke({ color: BLIND, width: 2.5 })
  }
}
