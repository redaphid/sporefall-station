// Draws scoutTags' output over each enemy's head, one coloured line per tone,
// above the verb marks. Pooled Text, like groupFx's labels.

import { Container, Text } from 'pixi.js'
import type { Entity } from '../game/entity'
import { TILE_PX } from './art'
import { scoutTags, type ScoutTone } from './scoutTags'

const TONE: Record<ScoutTone, number> = { weak: 0x9cff6a, tough: 0xb8c4d6, immune: 0xff7a6a }

/** Tiles above the body the lowest line sits at: clear of the verb marks. */
const RISE = 1.55
const LINE_PX = 13

export class ScoutTagLayer {
  readonly root = new Container()
  private readonly texts: Text[] = []

  constructor() {
    this.root.eventMode = 'none'
    this.root.zIndex = 1e7
  }

  update(entities: readonly Entity[], self: Entity | undefined, alpha: number): void {
    const byId = new Map<number, Entity>()
    for (const e of entities) byId.set(e.id, e)
    let used = 0
    for (const tag of scoutTags(entities, self)) {
      const e = byId.get(tag.id)!
      const x = (e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha) * TILE_PX
      const y = (e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha - RISE) * TILE_PX
      tag.lines.forEach((line, i) => {
        const t = this.text(used++)
        t.text = line.text
        t.style.fill = TONE[line.tone]
        t.position.set(x, y - (tag.lines.length - 1 - i) * LINE_PX)
      })
    }
    for (let i = used; i < this.texts.length; i++) this.texts[i].visible = false
  }

  private text(i: number): Text {
    let t = this.texts[i]
    if (!t) {
      t = new Text({
        text: '',
        style: { fontFamily: 'monospace', fontSize: 11, fontWeight: 'bold', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
      })
      t.anchor.set(0.5, 1)
      this.texts[i] = t
      this.root.addChild(t)
    }
    t.visible = true
    return t
  }
}
