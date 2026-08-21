import { Container, Graphics } from 'pixi.js'
import type { Entity } from '../game/entity'
import { charFootPx } from './anim'
import { TILE_PX } from './art'
import { GROUND_SQUASH, markerOrder, markerStyle, type MarkerSubject } from './playerMarkers'

/**
 * Draws the tiny "who is who / which one is me" rings at each player's feet.
 * World-space, so it rides the camera exactly like the sprites do and needs
 * no projection maths of its own.
 *
 * MOUNTING MATTERS. renderer.ts adds this layer directly ABOVE the entity
 * layer and BELOW status-fx / bullets / explosions — see the mount site in
 * renderer.ts and `worldLayers.ts` for why. Kept from covering the character
 * by being tiny, not by being buried under it.
 *
 * All the styling decisions live in the pure `playerMarkers.ts` model; this
 * file only turns them into pixi calls.
 */

/** A dark backing stroke under every ring: contrast from VALUE, not saturation. */
const SHADOW = { color: 0x000000, alpha: 0.5 } as const

/** World-px the backing stroke extends past the ring on each side. */
const SHADOW_OVERHANG = 1

export class PlayerMarkerLayer {
  readonly root = new Container()
  private readonly g = new Graphics()

  constructor() {
    this.root.eventMode = 'none'
    this.root.addChild(this.g)
  }

  /** Drop pooled graphics state (theme swap / renderer refresh). */
  refresh(): void {
    this.g.clear()
  }

  /**
   * @param entities live snapshot entities
   * @param selfId   the local player's entity id (undefined ⇒ spectating: every
   *                 player is then drawn as a teammate, nobody gets the YOU ring)
   * @param alpha    sim-tick interpolation, so markers track the sprites exactly
   * @param tick     sim tick — used only to decide who is cloaked, never for motion
   */
  update(entities: readonly Entity[], selfId: number | undefined, alpha: number, tick: number): void {
    this.g.clear()

    const subjects: (MarkerSubject & { e: Entity })[] = []
    for (const e of entities) {
      if (!e.playerCtl || e.dead) continue
      subjects.push({ slot: e.playerCtl.playerId, self: e.id === selfId, downed: e.playerCtl.downed != null, e })
    }

    for (const s of markerOrder(subjects)) {
      const e = s.e
      const style = markerStyle(s)
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
      this.g.ellipse(cx, cy, rx, ry).stroke({ ...SHADOW, width: style.width + SHADOW_OVERHANG * 2, alpha: SHADOW.alpha * a })
      this.g.ellipse(cx, cy, rx, ry).stroke({ color: style.color, width: style.width, alpha: a })

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
    }
  }
}
