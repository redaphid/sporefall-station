import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js'
import type { Entity } from '../game/entity'
import { charFootPx } from './anim'
import { TILE_PX } from './art'
import {
  GROUND_SQUASH,
  labelRisePx,
  labelScale,
  markerOrder,
  markerStyle,
  reticleTicks,
  type MarkerSubject,
} from './playerMarkers'

/**
 * Draws the "who is who / which one is me" markers: a ring on the floor at each
 * player's feet plus their name above their head. World-space, so it rides the
 * camera exactly like the sprites do and needs no projection maths of its own.
 *
 * MOUNTING MATTERS. renderer.ts adds this layer directly BELOW the entity layer
 * and BELOW status-fx / bullets / explosions:
 *
 *   - below entities → a marker is a floor decal, not a sticker on the body: the
 *     character's own sprite always paints over its ring and name, so the thing
 *     the marker is labelling stays fully visible instead of getting obscured by
 *     its own label. A ring that hides the character it marks has failed at the
 *     one job it has;
 *   - below the combat layers → bullets, blood, fire and hit flashes all paint
 *     over it, so the markers cannot out-shout the things trying to kill you.
 *
 * All the styling decisions live in the pure `playerMarkers.ts` model; this file
 * only turns them into pixi calls, pools the label Text objects, and keeps the
 * labels at a CONSTANT ON-SCREEN SIZE by cancelling the camera zoom — a name you
 * cannot read when zoomed out is not a name.
 */

const labelStyle = (fill: number): TextStyleOptions => ({
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 'bold',
  fill,
  // A black outline is what keeps a name readable over both a dark floor and a
  // pale one, without turning the fill into a brighter colour — kept thin so
  // the name doesn't outweigh the character it labels.
  stroke: { color: 0x000000, width: 2.5 },
})

/** A dark backing stroke under every ring: contrast from VALUE, not saturation. */
const SHADOW = { color: 0x000000, alpha: 0.4 } as const

interface LabelView {
  text: Text
  fill: number
}

export class PlayerMarkerLayer {
  readonly root = new Container()
  private readonly g = new Graphics()
  private readonly labels = new Map<number, LabelView>()

  constructor() {
    this.root.eventMode = 'none'
    this.root.addChild(this.g)
  }

  /** Drop pooled text (theme swap / renderer refresh). */
  refresh(): void {
    for (const l of this.labels.values()) {
      this.root.removeChild(l.text)
      l.text.destroy()
    }
    this.labels.clear()
    this.g.clear()
  }

  /**
   * @param entities live snapshot entities
   * @param selfId   the local player's entity id (undefined ⇒ spectating: every
   *                 player is then drawn as a teammate, nobody gets the YOU ring)
   * @param alpha    sim-tick interpolation, so markers track the sprites exactly
   * @param tick     sim tick, drives the local player's breathe (never wall-clock)
   * @param zoom     live camera zoom, cancelled out of the label scale
   */
  update(entities: readonly Entity[], selfId: number | undefined, alpha: number, tick: number, zoom: number): void {
    this.g.clear()
    const t = tick + alpha

    const subjects: (MarkerSubject & { e: Entity })[] = []
    for (const e of entities) {
      if (!e.playerCtl || e.dead) continue
      subjects.push({ slot: e.playerCtl.playerId, self: e.id === selfId, downed: e.playerCtl.downed != null, e })
    }

    const live = new Set<number>()
    for (const s of markerOrder(subjects)) {
      const e = s.e
      live.add(e.id)
      const style = markerStyle(s, t)
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha
      const cx = x * TILE_PX
      // Rings sit on the FEET, the same anchor the character sprite uses, so the
      // marker and the body can never drift apart.
      const cy = charFootPx(y, TILE_PX)
      // A cloaked player has deliberately gone quiet; their marker goes with them
      // rather than advertising the position the cloak just hid.
      const cloaked = e.status !== undefined && e.status.cloakUntil > tick
      const a = style.alpha * (cloaked ? 0.45 : 1)

      const rx = style.radius * TILE_PX
      const ry = rx * GROUND_SQUASH
      this.g.ellipse(cx, cy, rx, ry).stroke({ ...SHADOW, width: style.width + 1.5, alpha: SHADOW.alpha * a })
      this.g.ellipse(cx, cy, rx, ry).stroke({ color: style.color, width: style.width, alpha: a })

      if (style.reticle) {
        const irx = style.innerRadius * TILE_PX
        this.g.ellipse(cx, cy, irx, irx * GROUND_SQUASH).stroke({ color: style.innerColor, width: 2, alpha: a })
        for (const s2 of reticleTicks(cx, cy, style.radius, TILE_PX)) {
          this.g.moveTo(s2.x1, s2.y1).lineTo(s2.x2, s2.y2).stroke({ ...SHADOW, width: style.width + 1.5, alpha: SHADOW.alpha * a })
          this.g.moveTo(s2.x1, s2.y1).lineTo(s2.x2, s2.y2).stroke({ color: style.color, width: style.width, alpha: a })
        }
      }

      if (style.cross) {
        // The downed cue is a SHAPE as well as a colour: an X you can read with
        // no colour vision at all.
        const k = 0.72
        this.g
          .moveTo(cx - rx * k, cy - ry * k)
          .lineTo(cx + rx * k, cy + ry * k)
          .moveTo(cx + rx * k, cy - ry * k)
          .lineTo(cx - rx * k, cy + ry * k)
          .stroke({ color: style.color, width: style.width, alpha: a })
      }

      // --- Name above the head, at constant on-screen size.
      let label = this.labels.get(e.id)
      if (!label || label.fill !== style.labelColor) {
        if (label) {
          this.root.removeChild(label.text)
          label.text.destroy()
        }
        const text = new Text({ text: style.label, style: labelStyle(style.labelColor) })
        text.anchor.set(0.5, 1)
        this.root.addChild(text)
        label = { text, fill: style.labelColor }
        this.labels.set(e.id, label)
      }
      if (label.text.text !== style.label) label.text.text = style.label
      label.text.visible = true
      label.text.alpha = a
      // Cancel the camera scale so the name stays the same readable size on
      // screen whether the camera is zoomed in or out — a name you cannot read
      // zoomed out is not a name. Its ANCHOR stays in world pixels, so it tracks
      // the top of its own ring (which does scale) at every zoom level.
      label.text.scale.set(labelScale(zoom))
      label.text.position.set(cx, cy - labelRisePx(style, TILE_PX))
    }

    for (const [id, l] of this.labels) {
      if (live.has(id)) continue
      this.root.removeChild(l.text)
      l.text.destroy()
      this.labels.delete(id)
    }
  }
}
