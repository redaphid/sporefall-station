import { Container, Sprite, type Texture } from 'pixi.js'
import type { Entity, Fx } from '../game/entity'
import { ROLL_TICKS } from '../game/systems/roll'
import { burnPulse, charFootPx, cycleFrame, depthKey, facingDir, isMoving, walkBob } from './anim'
import { TILE_PX, type ArtRegistry, type CharSet, type DirPose } from './art'
import { DIR_FALLBACK, type Dir5 } from './theme'

const elementTint = (fx: Fx | undefined): number => {
  if (!fx) return 0xffffff
  if (fx.frozen) return 0x8fd4ff
  if (fx.electrified) return 0xfff27a
  if (fx.burning) return 0xff7a2a
  if (fx.wet) return 0x7aa8ff
  return 0xffffff
}

interface View {
  sprite: Sprite
  archetype: string
  seen: boolean
  flashing: boolean
  /** Animation frame currently shown, to avoid churning the texture each frame. */
  frame: number
}

/** Flame flicker cadence and walk-cycle cadence, in sim ticks per frame. */
const FIRE_TPF = 4
const WALK_TPF = 6

const DIR_INDEX: Record<Dir5, number> = { s: 0, se: 1, e: 2, ne: 3, n: 4 }

/** First pose in the facing's DIR_FALLBACK chain that has an idle texture, so
 * a partial file set (e.g. a 3-direction theme) still covers all five drawn
 * facings by borrowing a neighbor. */
const poseFor = (set: CharSet, dir: Dir5): DirPose | undefined => {
  for (const d of DIR_FALLBACK[dir]) {
    const pose = set[d]
    if (pose?.idle) return pose
  }
  return undefined
}

/** Pick which texture a view should show this frame, folding in hit-flash,
 * fire flicker, directional facing, and the walk-cycle step pose. Returns the
 * frame index (to skip redundant texture writes) and whether to flip on X. */
const pickTexture = (
  art: ArtRegistry,
  e: Entity,
  artKey: string,
  tick: number,
  flashing: boolean,
): { texture: Texture; frame: number; flip: boolean } => {
  if (flashing) {
    // Characters keep their facing (and mirror) through the flash so the
    // silhouette matches the pose it interrupts.
    if (art.isCharacterSprite(artKey)) {
      const { dir, flip } = facingDir(e.facing)
      return { texture: art.entityFlash(artKey, dir), frame: -1, flip }
    }
    return { texture: art.entityFlash(artKey), frame: -1, flip: false }
  }
  if (e.kind === 'fire') {
    const flames = art.flameFrames()
    if (flames.length > 0) {
      const frame = cycleFrame(tick, flames.length, FIRE_TPF)
      return { texture: flames[frame], frame, flip: false }
    }
    return { texture: art.entity(artKey), frame: 0, flip: false }
  }
  const moving = isMoving(e.vel.x, e.vel.y)
  const walk = moving ? cycleFrame(tick, 2, WALK_TPF) : 0

  // Directional character: 8-way heading rendered from 5 drawn directions
  // (s/se/e/ne/n; west half mirrored) + walk pose.
  const set = art.characterSet(artKey)
  if (set) {
    const { dir, flip } = facingDir(e.facing)
    const pose = poseFor(set, dir)
    const texture =
      pose === undefined ? art.entity(artKey) : walk === 1 && pose.step ? pose.step : (pose.idle ?? art.entity(artKey))
    return { texture, frame: DIR_INDEX[dir] * 2 + walk, flip }
  }

  // Single-sprite character with an optional step frame.
  const step = art.walkStep(artKey)
  if (step && moving) return { texture: walk === 0 ? art.entity(artKey) : step, frame: walk, flip: false }
  return { texture: art.entity(artKey), frame: 0, flip: false }
}

/** Pool of entity sprites keyed by entity id, diffed against the sim each frame. */
export class EntityViews {
  readonly root = new Container()
  private views = new Map<number, View>()

  constructor(private art: ArtRegistry) {
    this.root.sortableChildren = true
  }

  /** Drop every pooled sprite so the next update() rebuilds them against the
   * (possibly hot-swapped) art registry — used on runtime theme change. */
  refresh(): void {
    for (const view of this.views.values()) {
      this.root.removeChild(view.sprite)
      view.sprite.destroy()
    }
    this.views.clear()
  }

  update(entities: readonly Entity[], alpha: number, tick: number): void {
    for (const view of this.views.values()) view.seen = false
    const t = tick + alpha // continuous view-time for smooth procedural juice

    for (const e of entities) {
      if (e.dead) continue
      // Bullets ('projectile' archetype) draw in the procedural BulletLayer,
      // composed from their weapon-mod provenance. Grenades/thrown items keep
      // their entity sprite here.
      if (e.kind === 'projectile' && e.archetype === 'projectile') continue
      // Doors render differently open vs closed; treat state as part of identity.
      const artKey = e.door ? (e.door.open ? 'door.open' : 'door') : e.archetype
      let view = this.views.get(e.id)
      if (!view || view.archetype !== artKey) {
        if (view) {
          this.root.removeChild(view.sprite)
          view.sprite.destroy()
        }
        const sprite = new Sprite(this.art.entity(artKey))
        // Characters anchor bottom-centre at their FEET (they stand 48px tall on
        // 32px tiles and overlap the tile behind them); everything else stays
        // centre-anchored on its tile.
        if (this.art.isCharacterSprite(artKey)) sprite.anchor.set(0.5, 1)
        else sprite.anchor.set(0.5)
        this.root.addChild(sprite)
        view = { sprite, archetype: artKey, seen: true, flashing: false, frame: -2 }
        this.views.set(e.id, view)
      }
      view.seen = true

      const flashing = e.status !== undefined && e.status.hitFlashUntil > tick
      view.flashing = flashing
      const { texture, frame, flip } = pickTexture(this.art, e, artKey, tick, flashing)
      if (frame !== view.frame || flashing) {
        view.sprite.texture = texture
        view.frame = frame
      }

      // Downed players faded hard; cloaked players shimmer translucent
      const cloaked = e.status !== undefined && e.status.cloakUntil > tick
      view.sprite.alpha = e.playerCtl?.downed ? 0.45 : cloaked ? 0.55 : 1
      // Element tints read status at a glance: frozen ice-blue, electrified
      // shock-yellow, wet a cool slick, asleep/stunned dim lavender; burning
      // glows ember-orange and PULSES. Hit-flash wins.
      const burning = e.fx !== undefined && e.fx.burning !== undefined
      const drowsy = e.status !== undefined && (e.status.sleep > 0 || e.status.stun > 0)
      view.sprite.tint = flashing
        ? 0xffffff
        : burning
          ? burnPulse(t) > 0.5
            ? 0xff9a3a
            : 0xff5a1a
          : drowsy && !e.fx
            ? 0xb9a8e0
            : elementTint(e.fx)
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha
      const moving = isMoving(e.vel.x, e.vel.y)
      const character = this.art.isCharacterSprite(artKey)
      // Bob a walking character; breathe a flame; pulse a burning body.
      const bob = character && moving ? walkBob(t) : 0
      // Characters sit their feet half a tile below their centre (feet-anchored
      // 48px canvas); everything else centres on its position.
      view.sprite.position.set(x * TILE_PX, (character ? charFootPx(y, TILE_PX) : y * TILE_PX) + bob)
      const scale =
        e.kind === 'fire' ? 1 + Math.sin(t * 0.9) * 0.08 : burning ? 1 + burnPulse(t) * 0.08 : 1
      // Billboarded characters flip to mirror the west-half facings (directional
      // sets draw s/se/e/ne/n); top-down blobs rotate to their heading;
      // pickups/doors/fire stay upright.
      if (character) {
        // Dodge-roll: spin the billboard a full tumble over the roll window and
        // squash it a touch — the whole-body "roll THROUGH it" read. Pivot at
        // the body centre (not the feet anchor) so the tumble stays in place.
        const roll = e.playerCtl?.roll
        if (roll !== undefined && tick < roll.untilTick) {
          const p = Math.min(1, Math.max(0, (t - (roll.untilTick - ROLL_TICKS)) / ROLL_TICKS))
          const dir = roll.dirX < 0 || flip ? -1 : 1
          view.sprite.anchor.set(0.5, 0.5)
          view.sprite.position.y -= view.sprite.texture.height / 2
          view.sprite.rotation = dir * p * Math.PI * 2
          const squash = 1 - Math.sin(p * Math.PI) * 0.25
          view.sprite.scale.set((flip ? -scale : scale) * squash, scale * squash)
        } else {
          view.sprite.anchor.set(0.5, 1)
          view.sprite.rotation = 0
          view.sprite.scale.set(flip ? -scale : scale, scale)
        }
      } else {
        view.sprite.rotation = e.kind === 'pickup' || e.kind === 'door' || e.kind === 'fire' ? 0 : e.facing
        view.sprite.scale.set(scale)
      }
      // y-sort: grounded entities stack by world y (feet), flames float above
      // whatever they're consuming.
      view.sprite.zIndex = depthKey(e.kind, y)
    }

    for (const [id, view] of this.views) {
      if (!view.seen) {
        this.root.removeChild(view.sprite)
        view.sprite.destroy()
        this.views.delete(id)
      }
    }
  }
}
