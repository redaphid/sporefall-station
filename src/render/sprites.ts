import { Container, Graphics, Sprite, type Texture } from 'pixi.js'
import type { Entity, Fx } from '../game/entity'
import { ROLL_TICKS } from '../game/systems/roll'
import { SIM_DT } from '../game/types'
import { isSolidTile, type Level } from '../game/levelgen/level'
import { isObject } from '../game/systems/objects'
import { burnPulse, charFootPx, cycleFrame, depthKey, entityMoving, facingDir, type Dir } from './anim'
import {
  animFrame,
  effectiveClips,
  MEASURED_STATES,
  onceEnd,
  resolveClip,
  sceneContinuous,
  stowsWeapon,
  STATE_TICKS,
  type AnimStateName,
  type ResolvedAnim,
} from './animState'
import { eventStarts, trackAnim, type AnimMemory } from './animTracker'
import type { TickEvents } from '../app/eventLog'
import { composeMotion, IDENTITY_POSE, locomotionFor, type MotionPose } from './motion'
import { deriveThrow, poseAt, restLift, simulateBody, TUMBLE, type BodyTrack, type DeathFacts, type IsSolid } from './displayBody'
import { drawSkidDust, skidDust } from './skidDust'
import {
  ARCHETYPE_SCALE,
  CHAR_PX,
  ROTATES_WITH_FACING,
  TILE_PX,
  WALL_MOUNT_NUDGE,
  type ArtRegistry,
  type CharSet,
  type DirPose,
  type FistBox,
  type HeldWeaponArt,
  type HeldWeaponView,
} from './art'
import { DIR_FALLBACK, WEAPON_VIEW_FALLBACK, type Dir5, type WeaponView } from './theme'
import { weaponStack } from '../game/systems/inventory'
import { hasHeldWeapon, isMeleeWeapon } from './weaponArt'
import { HAND_RIG, heldPose, isAiming, recoilKick } from './weaponPose'
import { composeWeaponSkin } from './weaponSkin'

/** Held-weapon idle loop cadence (sim ticks per frame). */
export const WEAPON_IDLE_TPF = 6

/** Draw order of mod attachment layers, bottom to top: what hangs under the
 * barrel first, what wraps it next, what sits on top, the muzzle piece last.
 * A mod not listed draws after these, in id order. */
export const MOD_LAYER_ORDER: readonly string[] = [
  'explosive', 'detonator', 'bulk', 'rapid', 'heavy', 'frost', 'velocity', 'shock', 'homing', 'incendiary', 'choke',
]

/** The attachment layers a view draws for these mods, bottom to top. */
export const modLayers = (layers: Readonly<Record<string, readonly unknown[]>> | undefined, mods: readonly { id: string; stacks: number }[] | undefined): string[] => {
  if (!layers || !mods) return []
  const rank = (id: string): number => {
    const i = MOD_LAYER_ORDER.indexOf(id)
    return i < 0 ? MOD_LAYER_ORDER.length : i
  }
  return [...new Set(mods.filter((m) => m.stacks > 0 && (layers[m.id]?.length ?? 0) > 0).map((m) => m.id))].sort(
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  )
}

/** Z offsets around the body: the depth key is world y in TILES, so these must
 * stay far below any gap between two bodies. */
const Z_BEHIND = -0.001
const Z_FRONT = 0.001
const Z_CAP = 0.002

/** The drawn view a weapon shows for a wanted view: the view itself, else the
 * nearest one the pack draws (theme.WEAPON_VIEW_FALLBACK). */
export const resolveWeaponView = (art: HeldWeaponArt, view: WeaponView): HeldWeaponView | undefined => {
  for (const v of WEAPON_VIEW_FALLBACK[view]) {
    const got = art[v]
    if (got) return got
  }
  return undefined
}

/** Where the weapon hand is in a body frame, in logical units from the feet
 * anchor (the top-left corner of the grip pixel), plus the frame's pixel size.
 * A measured fist when the frame has one, else the per-facing rig. */
export const handInFrame = (
  fist: FistBox | undefined,
  dir: Dir,
  frame: { width: number; height: number; resolution: number },
): { hx: number; hy: number; unit: number } => {
  const unit = 1 / (frame.resolution || 1)
  if (fist) return { hx: fist.gx - frame.width / 2, hy: fist.gy - frame.height, unit }
  const rig = HAND_RIG[dir]
  const hs = CHAR_PX / 48
  // Snap the rig onto the frame's pixel grid.
  const snap = (v: number): number => Math.round(v / unit) * unit
  return { hx: snap(rig.hx * hs), hy: snap(rig.hy * hs), unit }
}

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
  /** Render-derived one-shot starts (attack, draw, fidget …): animTracker.ts. */
  anim: AnimMemory
  /** Last drawn facing/feet position — a death ghost freezes these. */
  facing: number
  flip: boolean
  footX: number
  footY: number
  /** Held-weapon sprite (melee/ranged), pinned to the hand and swung on attack.
   * Absent for bare fists / non-characters. A separate sibling sprite (not a
   * child of the body) so it keeps its own grip anchor and mirror-free rotation. */
  weapon?: Sprite
  /** Additive glow halo behind a MOD-lit weapon (absent when unmodded). */
  weaponGlow?: Sprite
  /** The wielder's own fist redrawn over the weapon's grip (art.fistCap). */
  weaponCap?: Sprite
  /** The pack's essence-accent layer, coloured by the weapon's mods. */
  weaponAccent?: Sprite
  /** Generated mod attachments over the weapon, in MOD_LAYER_ORDER. */
  weaponMods?: Sprite[]
  /** Last measured fist per drawn facing, held through a hit-flash frame (whose
   * white silhouette carries no measurement). */
  lastFist?: { dir: Dir; fist: FistBox }
  /** What a death tumble needs from the last sighting (tumble on only). */
  last?: { x: number; y: number; vx: number; vy: number; maxHp: number; tumbles: boolean }
  /** The dust a skid kicked up, while it is in the air (skidDust.ts). */
  dust?: Graphics
}

/** A projectile at its latest sighting, kept a while after it vanished: the
 * round that killed a body is gone by the time the body is. */
interface SeenRound {
  x: number
  y: number
  vx: number
  vy: number
  tick: number
  ownerId: number
  damage: number
}

/** Ticks a vanished round stays in memory. */
const ROUND_MEMORY_TICKS = 30

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
  /** The thrown body's track, when the kill tumbles it (displayBody.ts). */
  body?: BodyTrack
  /** Its blob on the floor while it flies (thrown bodies only). */
  shadow?: Graphics
}

/** The thrown body's floor shadow: a dark blob that stays on the floor while
 * the hop lifts the sprite, so a hop up or down the screen reads as a hop. */
const SHADOW = { alpha: 0.35, rx: 7, ry: 3 } as const

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

/** How many frames of its OWN the facing's pose has for a state
 * (`char.<name>.<dir>-<state>-<n>`; borrowed stand-ins do not count). */
const ownFrames = (set: CharSet | undefined, dir: Dir5, state: AnimStateName): number =>
  set ? (poseFor(set, dir)?.clips?.[state]?.length ?? 0) : 0

/** Does the pack draw this state itself (2+ frames)? Then the frames carry the
 * motion and motion.ts drops its procedural twin (MotionInput.drawn). The
 * legacy idle/step pair is not a drawn loop: the procedural cycle exists for
 * exactly that art. */
const drawsState = (set: CharSet | undefined, dir: Dir5, state: AnimStateName): boolean =>
  ownFrames(set, dir, state) > 1

/** Length in ticks (frames × tpf) of the facing's own clip for each measured
 * state (animState.MEASURED_STATES); a state the pack does not draw is left
 * out: a drawn-only state then never plays, and attack/hurt/death keep their
 * fixed window. */
const clipTicksFor = (art: ArtRegistry, set: CharSet | undefined, dir: Dir5): Partial<Record<AnimStateName, number>> => {
  const out: Partial<Record<AnimStateName, number>> = {}
  for (const s of MEASURED_STATES) {
    const n = ownFrames(set, dir, s)
    if (n > 0) out[s] = n * Math.max(1, Math.floor(art.animTpf(s)))
  }
  return out
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
  private readonly tumble: boolean
  private solid: IsSolid = () => false
  private rounds = new Map<number, SeenRound>()

  /** Skid to a stop (animTracker.observeSkid): the lean and the dust (the held
   * weapon follows the body's transform, lean included). Off = the motion this
   * renderer drew before skids existed, exactly (the action-anims golden trace
   * pins it). */
  private skid: boolean

  /** `tumble`: a kill throws the body (displayBody.ts); off, the ghost
   * topples where it stood, as it always did. */
  constructor(
    private art: ArtRegistry,
    opts: { tumble?: boolean; skid?: boolean } = {},
  ) {
    this.root.sortableChildren = true
    this.tumble = opts.tumble ?? false
    this.skid = opts.skid ?? true
  }

  /** Switch the skid on or off live (the `skidStop` feature flag). */
  setSkid(on: boolean): void {
    this.skid = on
  }

  /** The level a thrown body must stay out of the walls of. */
  setLevel(level: Level): void {
    this.solid = (tx, ty) => isSolidTile(level, tx, ty)
  }

  /** Drop every pooled sprite so the next update() rebuilds them against the
   * (possibly hot-swapped) art registry — used on runtime theme change. */
  refresh(): void {
    for (const view of this.views.values()) {
      this.hideWeapon(view)
      this.dropDust(view)
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
      g.shadow?.destroy()
    }
    this.ghosts.length = 0
  }

  private expireGhost(i: number): void {
    const g = this.ghosts[i]
    this.root.removeChild(g.sprite)
    g.sprite.destroy()
    g.shadow?.destroy()
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
  private toGhost(view: View, id: number, tick: number, entities: readonly Entity[], eventLog: readonly TickEvents[]): void {
    // Reset any mid-roll anchor/rotation so the fall pivots on the feet.
    view.sprite.anchor.set(0.5, 1)
    view.sprite.position.set(view.footX, view.footY)
    view.sprite.rotation = 0
    view.sprite.scale.set(view.flip ? -1 : 1, 1)
    const thrown = this.tumble && view.last?.tumbles ? this.throwBody(view, id, tick, entities, eventLog) : undefined
    let shadow: Graphics | undefined
    if (thrown) {
      shadow = new Graphics().ellipse(0, 0, SHADOW.rx, SHADOW.ry).fill({ color: 0x000000 })
      this.root.addChild(shadow)
    }
    this.ghosts.push({
      sprite: view.sprite,
      artKey: view.archetype,
      start: thrown?.start ?? tick,
      facing: view.facing,
      flip: view.flip,
      id,
      texKey: view.texKey,
      body: thrown?.body,
      shadow,
    })
    if (this.ghosts.length > MAX_GHOSTS) this.expireGhost(0)
  }

  /** Throw a body that just died: read its death off the event log (the tick
   * and place it died, the damage that tick, any blast) and the rest off what
   * was on screen, and integrate the tumble once. */
  private throwBody(
    view: View,
    id: number,
    tick: number,
    entities: readonly Entity[],
    eventLog: readonly TickEvents[],
  ): { start: number; body: BodyTrack } | undefined {
    const last = view.last!
    let death: { tick: number; x: number; y: number } | undefined
    for (const { tick: t, events } of eventLog) {
      if (t > tick) continue
      for (const ev of events) if (ev.type === 'death' && ev.entityId === id) death = { tick: t, x: ev.x, y: ev.y }
    }
    // No death event (a client whose events lag its snapshots): the last
    // sighting, now.
    const at = death ?? { tick, x: last.x, y: last.y }
    let killDamage = 0
    const explosions: DeathFacts['explosions'][number][] = []
    for (const { tick: t, events } of eventLog) {
      if (t !== at.tick) continue
      for (const ev of events) {
        if (ev.type === 'hit' && ev.targetId === id) killDamage += ev.amount
        if (ev.type === 'explosion') explosions.push(ev)
      }
    }
    const projectiles: DeathFacts['projectiles'][number][] = []
    for (const r of this.rounds.values()) {
      if (r.tick <= at.tick) projectiles.push({ ...r, ticksBefore: at.tick - r.tick })
    }
    const hostiles = entities
      .filter((e) => !e.dead && e.id !== id && (e.playerCtl !== undefined || e.ai?.targetId === id))
      .map((e) => e.pos)
    const th = deriveThrow({
      id,
      x: at.x,
      y: at.y,
      facing: view.facing,
      vel: { x: last.vx, y: last.vy },
      maxHp: last.maxHp,
      killDamage,
      explosions,
      projectiles,
      hostiles,
    })
    return th && { start: at.tick, body: simulateBody(th, this.solid) }
  }

  private prevTick = -1
  private prevFloor = -1

  /** `eventLog` is the RenderView's (app/eventLog.ts): the events of every
   * tick since the last update start one-shots (animTracker.EVENT_STARTS),
   * however many ticks this frame ran or a hitstop skipped. */
  update(entities: readonly Entity[], alpha: number, tick: number, floor = 0, eventLog: readonly TickEvents[] = []): void {
    for (const view of this.views.values()) view.seen = false
    const t = tick + alpha // continuous view-time for smooth procedural juice
    // Ticks not yet read: everything since the last update on this floor; on
    // the first update, a floor change or a rewind, this tick's alone.
    const since = this.prevFloor === floor && this.prevTick >= 0 && tick >= this.prevTick ? this.prevTick : tick - 1
    const fromEvents = eventStarts(eventLog, since, tick)

    if (this.tumble) this.seeRounds(entities, tick)
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
          this.hideWeapon(view)
          this.dropDust(view)
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
          anim: {},
          facing: e.facing,
          flip: false,
          footX: 0,
          footY: 0,
        }
        this.views.set(e.id, view)
      }
      view.seen = true

      const character = this.art.isCharacterSprite(artKey)
      const moving = entityMoving(e, SIM_DT)
      const roll = e.playerCtl?.roll
      const rolling = roll !== undefined && tick < roll.untilTick
      const charSet = character ? this.art.characterSet(artKey) : undefined
      const facing = facingDir(e.facing).dir

      // --- Layer 1: resolve the animation state (animState.ANIM_PRIORITY)
      // from the one-shot starts the tracker derives off observed change.
      // Death never appears here — corpses are swept the same tick and
      // continue as ghosts (toGhost).
      const anim: ResolvedAnim = character
        ? trackAnim(view.anim, e, tick, clipTicksFor(this.art, charSet, facing), fromEvents.get(e.id))
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
      const style = locomotionFor(this.art.artKind(artKey))
      const skid = this.skid && character ? view.anim.skid : undefined
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
              style,
              drawn: drawsState(charSet, facing, anim.state),
              skid,
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
      // A furnishing that stands against a wall is drawn nudged INTO that wall
      // (which lies at `facing + π`), so a rank of shelving kisses the wall
      // instead of hovering a half-tile out in the room. Presentation only — the
      // entity itself never leaves its tile, so collision, tile ownership and
      // every reachability guarantee are untouched.
      const mountX = e.mount === 'wall' ? -Math.cos(e.facing) * WALL_MOUNT_NUDGE * TILE_PX : 0
      const mountY = e.mount === 'wall' ? -Math.sin(e.facing) * WALL_MOUNT_NUDGE * TILE_PX : 0
      view.sprite.position.set(footX + motion.dx + mountX, footY + motion.dy + mountY)
      view.facing = e.facing
      view.footX = footX
      view.footY = footY
      if (this.tumble) {
        view.last = {
          x: e.pos.x,
          y: e.pos.y,
          vx: e.vel.x,
          vy: e.vel.y,
          maxHp: e.health?.max ?? 0,
          // Rooted spires and props do not fly; players go down, not flying.
          tumbles: character && e.hive === undefined && !isObject(e) && e.playerCtl === undefined,
        }
      }
      // Per-archetype BULK multiplies the animation pulse: the Mireclaw Alpha
      // draws at 1.5x so it can never be mistaken for the mutant whose sprite it
      // still borrows (art.ARCHETYPE_SCALE).
      const scale =
        (e.kind === 'fire' ? 1 + Math.sin(t * 0.9) * 0.08 : burning ? 1 + burnPulse(t) * 0.08 : 1) *
        (ARCHETYPE_SCALE[e.archetype] ?? 1)
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
        // Top-down blobs rotate to their heading; pickups/doors/fire stay
        // upright. Furnishings turn ONLY when their art is elongated top-down
        // art that reads correctly turned (art.ROTATES_WITH_FACING) — a vending
        // machine or a TV keeps its feet on the floor whichever wall it backs.
        const upright =
          e.kind === 'pickup' ||
          e.kind === 'door' ||
          e.kind === 'fire' ||
          (e.kind === 'interactable' && !ROTATES_WITH_FACING.has(e.archetype))
        view.sprite.rotation = upright ? 0 : e.facing
        view.sprite.scale.set(scale)
      }
      // y-sort: grounded entities stack by world y (feet), flames float above
      // whatever they're consuming.
      view.sprite.zIndex = depthKey(e.kind, y)

      // The skid's dust, kicked forward from where the feet stopped: in front of
      // the body, or behind it when the run went up-screen (away from us).
      const puffs = skid ? skidDust(skid, e.id, t, style) : []
      if (puffs.length > 0 && skid) {
        view.dust ??= this.root.addChild(new Graphics())
        drawSkidDust(view.dust, puffs)
        view.dust.zIndex = depthKey(e.kind, skid.y) + (skid.dirY < 0 ? -0.01 : 0.01)
      } else this.dropDust(view)

      // --- Layer 3: the held weapon — a hand-anchored sprite that swings on
      // attack (melee) or recoils (ranged) and re-tints from its mods. Rolling
      // is a whole-body tumble, so the weapon is stowed for its duration, and
      // a state whose clip draws the weapon (draw, aim, aimwalk) stows it too.
      if (character && !rolling && !stowsWeapon(anim.state)) this.updateWeapon(view, e, anim, t, tick)
      else this.hideWeapon(view)
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
        this.hideWeapon(view) // a corpse drops its weapon; the ghost is body-only
        this.dropDust(view)
        if (continuous && this.art.isCharacterSprite(view.archetype)) {
          this.toGhost(view, id, tick, entities, eventLog) // died this tick — the sprite lives on briefly
        } else {
          this.root.removeChild(view.sprite)
          view.sprite.destroy()
        }
      }
    }

    this.updateGhosts(tick, t)
  }

  /** Attach/update the wielder's held weapon: pack art only, one drawing per
   * view (weaponPose picks it from the facing, the aim state and the attack
   * window), blitted UNSCALED with its grip pixel on the fist the body frame
   * draws, and the body's own fist redrawn over the grip. Every input is a
   * sim-derived signal, so the frame is deterministic and replay-stable. */
  private updateWeapon(view: View, e: Entity, anim: ResolvedAnim, t: number, tick: number): void {
    const weaponId = e.combat?.weapon
    const art = weaponId !== undefined && hasHeldWeapon(weaponId) ? this.art.heldWeapon(weaponId) : undefined
    if (weaponId === undefined || !art) {
      this.hideWeapon(view)
      return
    }
    const { dir, flip } = facingDir(e.facing)
    const ranged = !isMeleeWeapon(weaponId)
    const p = anim.state === 'attack' ? (t - anim.start) / STATE_TICKS.attack : undefined
    const attacking = p !== undefined && p >= 0 && p < 1
    const stepX = e.pos.x - e.prevPos.x
    const stepY = e.pos.y - e.prevPos.y
    const moving = Math.hypot(stepX, stepY) > 1e-4
    const aiming = isAiming({
      engaged: e.ai?.mode === 'aggro',
      ticksSinceAttack: view.anim.attackStart === undefined ? undefined : tick - view.anim.attackStart,
      // Twin-stick: walking one way while facing another (> 60° apart).
      strafing: e.playerCtl !== undefined && moving && Math.cos(Math.atan2(stepY, stepX) - e.facing) < 0.5,
    })
    // A melee weapon whose pack draws the swing plays it in place; without
    // drawn swing frames it steps through the per-sector drawings instead.
    const rest = heldPose({ dir, flip, ranged, aiming })
    const drawnSwing = (resolveWeaponView(art, rest.view)?.attack.length ?? 0) > 0
    const pose = !ranged && attacking && !drawnSwing ? heldPose({ dir, flip, ranged, aiming, progress: p }) : rest
    const clip = resolveWeaponView(art, pose.view)
    if (!clip) {
      this.hideWeapon(view)
      return
    }
    const frame =
      attacking && clip.attack.length > 0
        ? clip.attack[Math.min(clip.attack.length - 1, Math.floor(p * clip.attack.length))]
        : clip.idle[cycleFrame(tick, clip.idle.length, WEAPON_IDLE_TPF)]

    if (!view.weapon) {
      view.weapon = new Sprite(frame)
      this.root.addChild(view.weapon)
    }
    const weapon = view.weapon
    weapon.texture = frame
    const res = frame.source.resolution || 1
    weapon.anchor.set(clip.grip[0] / frame.source.pixelWidth, clip.grip[1] / frame.source.pixelHeight)

    // The fist: measured on this body frame, else the last one measured for this
    // facing (a hit-flash frame), else the per-facing rig.
    const body = view.sprite
    let fist = this.art.fistOf(body.texture)
    if (fist) view.lastFist = { dir, fist }
    else if (view.lastFist?.dir === dir && body.texture !== undefined) fist = view.lastFist.fist
    const hand = handInFrame(fist, dir, {
      width: body.texture.orig.width,
      height: body.texture.orig.height,
      resolution: body.texture.source.resolution,
    })
    // The grip pixel's corner, in the body's local (unmirrored) frame: the body
    // mirror moves the hand pixel to [-hx-unit, -hx); a mirrored weapon's grip
    // pixel spans [P-unit, P), so its anchor sits one pixel to the right.
    const unit = hand.unit
    const lx = (flip ? -hand.hx - unit : hand.hx) + (pose.mirror ? unit : 0)
    const ly = hand.hy
    // Recoil: a whole-pixel punch back along the facing.
    const kick = ranged ? recoilKick(p) : 0
    const snap = (v: number): number => Math.round(v / unit) * unit
    const kx = snap(Math.cos(e.facing) * kick * (CHAR_PX / 48))
    const ky = snap(Math.sin(e.facing) * kick * (CHAR_PX / 48))
    // Follow the body's own transform (lean, squash) but keep the weapon on the
    // body's pixel grid: the offset from the feet is snapped to whole pixels.
    const sx = Math.abs(body.scale.x)
    const sy = body.scale.y
    const c = Math.cos(body.rotation)
    const s = Math.sin(body.rotation)
    const ox = snap(c * sx * lx - s * sy * ly) + kx
    const oy = snap(s * sx * lx + c * sy * ly) + ky
    weapon.position.set(body.position.x + ox, body.position.y + oy)
    weapon.rotation = 0
    weapon.scale.set(pose.mirror ? -1 : 1, 1)
    const mods = weaponStack(e)?.mods
    const skin = composeWeaponSkin(mods)
    // A pack that draws the essence accent as its own layer gets that layer
    // coloured instead of the whole sprite tinted (a tint muddies pixel art).
    const accented = (clip.glow?.length ?? 0) > 0
    weapon.tint = accented ? 0xffffff : skin.tint
    weapon.alpha = body.alpha
    weapon.zIndex = body.zIndex + (pose.behind ? Z_BEHIND : Z_FRONT)

    // The hand closes over the grip: the body's own fist pixels, drawn again
    // above the weapon with the body's exact transform.
    if (pose.cap && fist) {
      if (!view.weaponCap) {
        view.weaponCap = new Sprite()
        this.root.addChild(view.weaponCap)
      }
      const cap = view.weaponCap
      cap.texture = this.art.fistCap(body.texture, fist)
      cap.anchor.copyFrom(body.anchor)
      cap.position.copyFrom(body.position)
      cap.scale.copyFrom(body.scale)
      cap.rotation = body.rotation
      cap.tint = body.tint
      cap.alpha = body.alpha
      cap.zIndex = body.zIndex + Z_CAP
    } else this.dropCap(view)

    this.updateWeaponLayers(view, clip, weapon, mods, skin.power > 0 ? skin.glowColor : undefined, tick, attacking)

    if (skin.glow > 0) {
      if (!view.weaponGlow) {
        const glow = new Sprite(this.art.bulletGlow())
        glow.anchor.set(0.5)
        glow.blendMode = 'add'
        this.root.addChild(glow)
        view.weaponGlow = glow
      }
      const glow = view.weaponGlow
      const mx = (clip.muzzle[0] - clip.grip[0]) / res
      const my = (clip.muzzle[1] - clip.grip[1]) / res
      glow.position.set(weapon.position.x + (pose.mirror ? -mx : mx), weapon.position.y + my)
      glow.tint = skin.glowColor
      glow.alpha = skin.glow * body.alpha
      glow.scale.set(0.5 * skin.scale)
      glow.zIndex = weapon.zIndex - 0.0005
    } else if (view.weaponGlow) {
      this.root.removeChild(view.weaponGlow)
      view.weaponGlow.destroy()
      view.weaponGlow = undefined
    }
  }

  /** The view's mod attachments, then its essence accent, over the weapon on
   * the same grip anchor (every frame of a view shares one canvas). */
  private updateWeaponLayers(
    view: View,
    clip: HeldWeaponView,
    weapon: Sprite,
    mods: readonly { id: string; stacks: number }[] | undefined,
    accent: number | undefined,
    tick: number,
    attacking: boolean,
  ): void {
    const place = (sp: Sprite, tex: Texture, z: number): void => {
      sp.texture = tex
      sp.anchor.copyFrom(weapon.anchor)
      sp.position.copyFrom(weapon.position)
      sp.scale.copyFrom(weapon.scale)
      sp.alpha = weapon.alpha
      sp.zIndex = weapon.zIndex + z
    }
    const ids = modLayers(clip.mods, mods)
    const pool = (view.weaponMods ??= [])
    while (pool.length > ids.length) {
      const sp = pool.pop()!
      this.root.removeChild(sp)
      sp.destroy()
    }
    ids.forEach((id, i) => {
      if (!pool[i]) {
        pool[i] = new Sprite()
        this.root.addChild(pool[i])
      }
      const frames = clip.mods![id]
      place(pool[i], frames[cycleFrame(tick, frames.length, WEAPON_IDLE_TPF)], 0.0001 * (i + 1))
    })
    if (accent !== undefined && clip.glow && clip.glow.length > 0) {
      if (!view.weaponAccent) {
        view.weaponAccent = new Sprite()
        this.root.addChild(view.weaponAccent)
      }
      const sp = view.weaponAccent
      place(sp, clip.glow[cycleFrame(tick, clip.glow.length, WEAPON_IDLE_TPF)], 0.0001 * (ids.length + 1))
      sp.tint = accent
      // Charged look: a slow breath at rest, full on the shot.
      sp.alpha = weapon.alpha * (attacking ? 1 : 0.7 + 0.3 * Math.sin(tick * 0.2))
    } else this.dropAccent(view)
  }

  private dropAccent(view: View): void {
    if (view.weaponAccent) {
      this.root.removeChild(view.weaponAccent)
      view.weaponAccent.destroy()
      view.weaponAccent = undefined
    }
  }

  private dropCap(view: View): void {
    if (view.weaponCap) {
      this.root.removeChild(view.weaponCap)
      view.weaponCap.destroy()
      view.weaponCap = undefined
    }
  }

  /** Remember every round on screen at its latest sighting; forget the ones
   * gone a while. */
  private seeRounds(entities: readonly Entity[], tick: number): void {
    for (const e of entities) {
      if (e.kind !== 'projectile' || e.dead || !e.projectile) continue
      const p = e.projectile
      this.rounds.set(e.id, { x: e.pos.x, y: e.pos.y, vx: e.vel.x, vy: e.vel.y, tick, ownerId: p.ownerId, damage: p.damage })
    }
    for (const [id, r] of this.rounds) if (tick - r.tick > ROUND_MEMORY_TICKS || r.tick > tick) this.rounds.delete(id)
  }

  /** Drop a view's skid dust. Idempotent. */
  private dropDust(view: View): void {
    if (!view.dust) return
    this.root.removeChild(view.dust)
    view.dust.destroy()
    view.dust = undefined
  }

  /** Drop a view's weapon/cap/glow sprites (bare fists, non-characters, rolling,
   * or on view teardown). Idempotent. */
  private hideWeapon(view: View): void {
    if (view.weapon) {
      this.root.removeChild(view.weapon)
      view.weapon.destroy()
      view.weapon = undefined
    }
    this.dropCap(view)
    this.dropAccent(view)
    for (const sp of view.weaponMods ?? []) {
      this.root.removeChild(sp)
      sp.destroy()
    }
    view.weaponMods = undefined
    if (view.weaponGlow) {
      this.root.removeChild(view.weaponGlow)
      view.weaponGlow.destroy()
      view.weaponGlow = undefined
    }
  }

  /** Advance death ghosts: play the death clip (theme frames or the held last
   * pose) under the procedural topple/fade, then free the sprite. A ghost lasts
   * the death window: its drawn clip, or STATE_TICKS.death without one. */
  private updateGhosts(tick: number, t: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i]
      const { dir } = facingDir(g.facing)
      const set = this.art.characterSet(g.artKey)
      const end = g.body
        ? g.start + g.body.settle + TUMBLE.hold + STATE_TICKS.death
        : onceEnd('death', g.start, { tick, moving: false, clipTicks: clipTicksFor(this.art, set, dir) })!
      if (tick >= end) {
        this.expireGhost(i)
        continue
      }
      const drawn = drawsState(set, dir, 'death')
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
        end,
        tick,
        t,
        id: g.id,
        facing: g.facing,
        vx: 0,
        moving: false,
        drawn,
      })
      if (g.body) {
        // Thrown: spin about the body's middle, which sits half the body's
        // height (standing) to half its thickness (lying) above the floor
        // point, plus the hop. A drawn death clip carries its own fall, so it
        // keeps the flight but not the spin.
        const p = poseAt(g.body, t - g.start)
        const rot = drawn ? 0 : p.rot
        g.sprite.anchor.set(0.5, 0.5)
        g.sprite.position.set(p.x * TILE_PX, charFootPx(p.y, TILE_PX) - restLift(rot, g.sprite.texture.height) - p.z * TILE_PX)
        g.sprite.rotation = rot
        g.sprite.alpha = motion.alpha
        g.sprite.scale.set(g.flip ? -1 : 1, 1)
        g.sprite.zIndex = depthKey('npc', p.y)
        if (g.shadow) {
          // On the floor under the body, fading out once it has landed.
          const since = t - g.start - g.body.landed
          const fade = since <= 0 ? 1 : Math.max(0, 1 - since / TUMBLE.rollTicks)
          g.shadow.position.set(p.x * TILE_PX, charFootPx(p.y, TILE_PX) - SHADOW.ry)
          g.shadow.scale.set(1 + 0.6 * Math.abs(Math.sin(rot)) - 0.25 * Math.min(1, p.z), 1)
          g.shadow.alpha = SHADOW.alpha * fade * motion.alpha
          g.shadow.visible = g.shadow.alpha > 0
          g.shadow.zIndex = g.sprite.zIndex - 0.01
        }
        continue
      }
      g.sprite.rotation = motion.rot
      g.sprite.alpha = motion.alpha
      g.sprite.scale.set((g.flip ? -1 : 1) * motion.sx, motion.sy)
    }
  }
}
