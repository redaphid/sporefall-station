import { Container, Sprite, type Texture } from 'pixi.js'
import type { Entity, Fx } from '../game/entity'
import { ROLL_TICKS } from '../game/systems/roll'
import { SIM_DT } from '../game/types'
import { burnPulse, charFootPx, cycleFrame, depthKey, entityMoving, facingDir } from './anim'
import {
  animFrame,
  effectiveClips,
  resolveAnimState,
  resolveClip,
  sceneContinuous,
  STATE_TICKS,
  type ResolvedAnim,
} from './animState'
import { composeMotion, IDENTITY_POSE, type MotionPose } from './motion'
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
  /** Key of the texture currently shown (state/dir/frame), to skip redundant writes. */
  texKey: string
  /** combat.cooldown last frame — the sim only DECREMENTS it, so an increase
   * means "an attack fired this tick" (the render-derived attack signal). */
  prevCooldown?: number
  /** Tick the last observed attack started (drives the attack state window). */
  attackStart?: number
  /** Last drawn facing/feet position — a death ghost freezes these. */
  facing: number
  flip: boolean
  footX: number
  footY: number
}

/** A character that just died: the entity is swept from the snapshot the same
 * tick, so the renderer keeps its last sprite as a short-lived ghost playing
 * the death state (frames if the theme ships them + procedural topple/fade). */
interface Ghost {
  sprite: Sprite
  artKey: string
  start: number
  facing: number
  flip: boolean
  id: number
  texKey: string
}

/** Ghost cap — a massacre never accumulates unbounded sprites (mobile-cheap). */
const MAX_GHOSTS = 24

/** Flame flicker cadence, in sim ticks per frame. */
const FIRE_TPF = 4

/** Does this pose have a usable idle (legacy frame or idle clip)? */
const hasIdle = (pose: DirPose | undefined): boolean =>
  pose !== undefined && (pose.idle !== undefined || (pose.clips?.idle?.length ?? 0) > 0)

/** First pose in the facing's DIR_FALLBACK chain that has an idle, so a
 * partial file set (e.g. a 3-direction theme) still covers all five drawn
 * facings by borrowing a neighbor. */
const poseFor = (set: CharSet, dir: Dir5): DirPose | undefined => {
  for (const d of DIR_FALLBACK[dir]) {
    const pose = set[d]
    if (hasIdle(pose)) return pose
  }
  return undefined
}

/** Pick the texture a CHARACTER shows for a resolved animation state: state
 * clip (with per-state fallback chains) → legacy idle/step synthesis →
 * non-directional entity art. Returns the change-detection key alongside. */
const pickCharTexture = (
  art: ArtRegistry,
  artKey: string,
  dir: Dir5,
  id: number,
  anim: ResolvedAnim,
  tick: number,
): { texture: Texture; key: string } => {
  const set = art.characterSet(artKey)
  const pose = set ? poseFor(set, dir) : undefined
  if (pose) {
    const clips = effectiveClips<Texture>({ idle: pose.idle, step: pose.step }, pose.clips)
    const rc = resolveClip(clips, anim.state)
    if (rc) {
      const frame = animFrame(anim.state, rc.frames.length, tick, anim.start, art.animTpf(anim.state), id)
      return { texture: rc.frames[frame], key: `${anim.state}:${rc.source}:${dir}:${frame}` }
    }
  }
  return { texture: art.entity(artKey), key: `flat:${artKey}` }
}

/** Pick which texture a view should show this frame, folding in hit-flash,
 * fire flicker, directional facing, and the animation state machine. */
const pickTexture = (
  art: ArtRegistry,
  e: Entity,
  artKey: string,
  tick: number,
  flashing: boolean,
  anim: ResolvedAnim,
): { texture: Texture; key: string; flip: boolean } => {
  if (flashing) {
    // Characters keep their facing (and mirror) through the flash so the
    // silhouette matches the pose it interrupts.
    if (art.isCharacterSprite(artKey)) {
      const { dir, flip } = facingDir(e.facing)
      return { texture: art.entityFlash(artKey, dir), key: 'flash', flip }
    }
    return { texture: art.entityFlash(artKey), key: 'flash', flip: false }
  }
  if (e.kind === 'fire') {
    const flames = art.flameFrames()
    if (flames.length > 0) {
      const frame = cycleFrame(tick, flames.length, FIRE_TPF)
      return { texture: flames[frame], key: `fire:${frame}`, flip: false }
    }
    return { texture: art.entity(artKey), key: 'fire:flat', flip: false }
  }

  // Directional character: 8-way heading rendered from 5 drawn directions
  // (s/se/e/ne/n; west half mirrored) + the resolved animation state.
  if (art.isCharacterSprite(artKey)) {
    const { dir, flip } = facingDir(e.facing)
    const picked = pickCharTexture(art, artKey, dir, e.id, anim, tick)
    return { ...picked, flip }
  }

  // Single-sprite walker with an optional step frame (legacy unit.* path).
  const step = art.walkStep(artKey)
  if (step && anim.state === 'walk') {
    const frame = animFrame('walk', 2, tick, 0, art.animTpf('walk'), e.id)
    return { texture: frame === 0 ? art.entity(artKey) : step, key: `walk:${frame}`, flip: false }
  }
  return { texture: art.entity(artKey), key: 'flat', flip: false }
}

/** Pool of entity sprites keyed by entity id, diffed against the sim each frame. */
export class EntityViews {
  readonly root = new Container()
  private views = new Map<number, View>()
  private ghosts: Ghost[] = []

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
    this.clearGhosts()
  }

  private clearGhosts(): void {
    for (const g of this.ghosts) {
      this.root.removeChild(g.sprite)
      g.sprite.destroy()
    }
    this.ghosts.length = 0
  }

  private expireGhost(i: number): void {
    const g = this.ghosts[i]
    this.root.removeChild(g.sprite)
    g.sprite.destroy()
    this.ghosts.splice(i, 1)
  }

  /**
   * Convert a vanished character view into a death ghost. Corpses are swept
   * from the snapshot the SAME tick they die, and the one-tick `death` event
   * is unreliable render-side (a slow frame can run 2+ sim ticks and the event
   * list is cleared each tick) — so death is DERIVED from observed change:
   * a character that was here last frame and is gone now, while tick/floor
   * advanced continuously, died. Floor changes / restarts (floor switch, tick
   * jump or regression) destroy views normally — no ghost burst on a new level.
   */
  private toGhost(view: View, id: number, tick: number): void {
    // Reset any mid-roll anchor/rotation so the fall pivots on the feet.
    view.sprite.anchor.set(0.5, 1)
    view.sprite.position.set(view.footX, view.footY)
    view.sprite.rotation = 0
    view.sprite.scale.set(view.flip ? -1 : 1, 1)
    this.ghosts.push({
      sprite: view.sprite,
      artKey: view.archetype,
      start: tick,
      facing: view.facing,
      flip: view.flip,
      id,
      texKey: view.texKey,
    })
    if (this.ghosts.length > MAX_GHOSTS) this.expireGhost(0)
  }

  private prevTick = -1
  private prevFloor = -1

  update(entities: readonly Entity[], alpha: number, tick: number, floor = 0): void {
    for (const view of this.views.values()) view.seen = false
    const t = tick + alpha // continuous view-time for smooth procedural juice

    for (const e of entities) {
      if (e.dead) continue
      // Bullets ('projectile' archetype) draw in the procedural BulletLayer,
      // composed from their weapon-mod provenance. Grenades/thrown items keep
      // their entity sprite here.
      if (e.kind === 'projectile' && e.archetype === 'projectile') continue
      // Doors render differently open vs closed vs LOCKED (padlock art) —
      // treat state as part of identity so unlocking swaps the sprite.
      const artKey = e.door ? (e.door.open ? 'door.open' : e.door.locked ? 'door.locked' : 'door') : e.archetype
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
        view = {
          sprite,
          archetype: artKey,
          seen: true,
          flashing: false,
          texKey: '',
          facing: e.facing,
          flip: false,
          footX: 0,
          footY: 0,
        }
        this.views.set(e.id, view)
      }
      view.seen = true

      // --- Render-derived attack signal: the sim only ever decrements
      // combat.cooldown (statusSystem), so an INCREASE between observed frames
      // marks the tick an attack/throw fired. No sim change needed.
      const cd = e.combat?.cooldown
      if (cd !== undefined && view.prevCooldown !== undefined && cd > view.prevCooldown) view.attackStart = tick
      view.prevCooldown = cd

      const character = this.art.isCharacterSprite(artKey)
      const moving = entityMoving(e, SIM_DT)
      const roll = e.playerCtl?.roll
      const rolling = roll !== undefined && tick < roll.untilTick

      // --- Layer 1: resolve the animation state (priority: death > roll >
      // hurt > attack > walk > idle). Death never appears here — corpses are
      // swept the same tick and continue as ghosts (noteEvents).
      const anim: ResolvedAnim = character
        ? resolveAnimState({
            tick,
            moving,
            rollUntil: rolling ? roll.untilTick : undefined,
            rollStart: rolling ? roll.untilTick - ROLL_TICKS : undefined,
            hitFlashUntil: e.status?.hitFlashUntil,
            attackStart: view.attackStart,
          })
        : { state: moving ? 'walk' : 'idle', start: 0 }

      const flashing = e.status !== undefined && e.status.hitFlashUntil > tick
      view.flashing = flashing
      const { texture, key, flip } = pickTexture(this.art, e, artKey, tick, flashing, anim)
      if (key !== view.texKey || flashing) {
        view.sprite.texture = texture
        view.texKey = key
      }

      // --- Layer 2: procedural motion offsets (lean/bob/lunge/flinch/squash),
      // composed around the feet anchor. The roll tumble is whole-body and
      // keeps its dedicated branch below.
      const motion: MotionPose =
        character && !rolling
          ? composeMotion({
              state: anim.state,
              start: anim.start,
              tick,
              t,
              id: e.id,
              facing: e.facing,
              vx: e.vel.x,
              moving,
              rollUntil: roll?.untilTick,
            })
          : IDENTITY_POSE

      // Downed players faded hard; cloaked players shimmer translucent
      const cloaked = e.status !== undefined && e.status.cloakUntil > tick
      view.sprite.alpha = (e.playerCtl?.downed ? 0.45 : cloaked ? 0.55 : 1) * motion.alpha
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
      // Characters sit their feet half a tile below their centre (feet-anchored
      // 48px canvas); everything else centres on its position.
      const footX = x * TILE_PX
      const footY = character ? charFootPx(y, TILE_PX) : y * TILE_PX
      view.sprite.position.set(footX + motion.dx, footY + motion.dy)
      view.facing = e.facing
      view.footX = footX
      view.footY = footY
      const scale =
        e.kind === 'fire' ? 1 + Math.sin(t * 0.9) * 0.08 : burning ? 1 + burnPulse(t) * 0.08 : 1
      // Billboarded characters flip to mirror the west-half facings (directional
      // sets draw s/se/e/ne/n); top-down blobs rotate to their heading;
      // pickups/doors/fire stay upright.
      if (character) {
        view.flip = flip
        if (rolling && roll !== undefined) {
          // Dodge-roll: spin the billboard a full tumble over the roll window and
          // squash it a touch — the whole-body "roll THROUGH it" read. Pivot at
          // the body centre (not the feet anchor) so the tumble stays in place.
          const p = Math.min(1, Math.max(0, (t - (roll.untilTick - ROLL_TICKS)) / ROLL_TICKS))
          const dir = roll.dirX < 0 || flip ? -1 : 1
          view.sprite.anchor.set(0.5, 0.5)
          view.sprite.position.y -= view.sprite.texture.height / 2
          view.sprite.rotation = dir * p * Math.PI * 2
          const squash = 1 - Math.sin(p * Math.PI) * 0.25
          view.sprite.scale.set((flip ? -scale : scale) * squash, scale * squash)
        } else {
          view.sprite.anchor.set(0.5, 1)
          view.sprite.rotation = motion.rot
          view.sprite.scale.set((flip ? -scale : scale) * motion.sx, scale * motion.sy)
        }
      } else {
        view.sprite.rotation = e.kind === 'pickup' || e.kind === 'door' || e.kind === 'fire' ? 0 : e.facing
        view.sprite.scale.set(scale)
      }
      // y-sort: grounded entities stack by world y (feet), flames float above
      // whatever they're consuming.
      view.sprite.zIndex = depthKey(e.kind, y)
    }

    // Scene continuity: same floor, tick moving forward by a frame-plausible
    // step. A floor switch or restart (tick regression / big jump) is a scene
    // CUT — vanished views are dropped, never ghosted, and ghosts cleared.
    const continuous = sceneContinuous(this.prevTick, this.prevFloor, tick, floor)
    if (!continuous && this.prevFloor !== -1) this.clearGhosts()
    this.prevTick = tick
    this.prevFloor = floor

    for (const [id, view] of this.views) {
      if (!view.seen) {
        this.views.delete(id)
        if (continuous && this.art.isCharacterSprite(view.archetype)) {
          this.toGhost(view, id, tick) // died this tick — the sprite lives on briefly
        } else {
          this.root.removeChild(view.sprite)
          view.sprite.destroy()
        }
      }
    }

    this.updateGhosts(tick, t)
  }

  /** Advance death ghosts: play the death clip (theme frames or the held last
   * pose) under the procedural topple/fade, then free the sprite. */
  private updateGhosts(tick: number, t: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i]
      if (tick >= g.start + STATE_TICKS.death) {
        this.expireGhost(i)
        continue
      }
      const { dir } = facingDir(g.facing)
      const set = this.art.characterSet(g.artKey)
      const pose = set ? poseFor(set, dir) : undefined
      if (pose) {
        const clips = effectiveClips<Texture>({ idle: pose.idle, step: pose.step }, pose.clips)
        const rc = resolveClip(clips, 'death')
        if (rc) {
          const frame = animFrame('death', rc.frames.length, tick, g.start, this.art.animTpf('death'), g.id)
          const key = `ghost:${rc.source}:${dir}:${frame}`
          if (key !== g.texKey) {
            g.sprite.texture = rc.frames[frame]
            g.texKey = key
          }
        }
      }
      const motion = composeMotion({
        state: 'death',
        start: g.start,
        tick,
        t,
        id: g.id,
        facing: g.facing,
        vx: 0,
        moving: false,
      })
      g.sprite.rotation = motion.rot
      g.sprite.alpha = motion.alpha
      g.sprite.scale.set((g.flip ? -1 : 1) * motion.sx, motion.sy)
    }
  }
}
