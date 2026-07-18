import { Container, Sprite, type Texture } from 'pixi.js'
import type { Entity, Fx } from '../game/entity'
import { ROLL_TICKS } from '../game/systems/roll'
import { burnPulse, cycleFrame, facingDir, isMoving, walkBob } from './anim'
import { TILE_PX, type ArtRegistry } from './art'

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

const DIR_INDEX = { front: 0, side: 1, back: 2 } as const

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
  if (flashing) return { texture: art.entityFlash(artKey), frame: -1, flip: false }
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

  // Directional character: swap sprite by heading (front/side/back) + walk pose.
  const set = art.characterSet(artKey)
  if (set) {
    const { dir, flip } = facingDir(e.facing)
    const pose = set[dir].idle ? set[dir] : set.front
    const texture = walk === 1 && pose.step ? pose.step : (pose.idle ?? art.entity(artKey))
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

  update(entities: readonly Entity[], alpha: number, tick: number): void {
    for (const view of this.views.values()) view.seen = false
    const t = tick + alpha // continuous view-time for smooth procedural juice

    for (const e of entities) {
      if (e.dead) continue
      // Doors render differently open vs closed; treat state as part of identity.
      const artKey = e.door ? (e.door.open ? 'door.open' : 'door') : e.archetype
      let view = this.views.get(e.id)
      if (!view || view.archetype !== artKey) {
        if (view) {
          this.root.removeChild(view.sprite)
          view.sprite.destroy()
        }
        const sprite = new Sprite(this.art.entity(artKey))
        sprite.anchor.set(0.5)
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
      view.sprite.position.set(x * TILE_PX, y * TILE_PX + bob)
      const scale =
        e.kind === 'fire' ? 1 + Math.sin(t * 0.9) * 0.08 : burning ? 1 + burnPulse(t) * 0.08 : 1
      // Billboarded characters flip to face left/right (directional sets already
      // pick front/side/back); top-down blobs rotate to their heading;
      // pickups/doors/fire stay upright.
      if (character) {
        // Dodge-roll: spin the billboard a full tumble over the roll window and
        // squash it a touch — the whole-body "roll THROUGH it" read.
        const roll = e.playerCtl?.roll
        if (roll !== undefined && tick < roll.untilTick) {
          const p = Math.min(1, Math.max(0, (t - (roll.untilTick - ROLL_TICKS)) / ROLL_TICKS))
          const dir = roll.dirX < 0 || flip ? -1 : 1
          view.sprite.rotation = dir * p * Math.PI * 2
          const squash = 1 - Math.sin(p * Math.PI) * 0.25
          view.sprite.scale.set((flip ? -scale : scale) * squash, scale * squash)
        } else {
          view.sprite.rotation = 0
          view.sprite.scale.set(flip ? -scale : scale, scale)
        }
      } else {
        view.sprite.rotation = e.kind === 'pickup' || e.kind === 'door' || e.kind === 'fire' ? 0 : e.facing
        view.sprite.scale.set(scale)
      }
      // Flames draw above whatever they're consuming.
      view.sprite.zIndex = e.kind === 'fire' ? y + 1000 : y
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
