// The procedural bullet layer — every 'projectile'-archetype entity draws here
// (EntityViews skips them), composed from its mod provenance via bulletVisuals:
//   core   — one shared white disc sprite, tinted + elongated per traits (always
//            drawn, so bullets stay legible even if the shader path is out);
//   energy — glow/trail/chroma quads pushed into the batched EnergyFieldMesh
//            (one draw call for everything), with a tinted-sprite fallback when
//            the shader can't compile;
//   flecks — tiny orbiting shards for splinter builds.
//
// Determinism: all animation runs off sim view-time (tick + alpha) and a hash
// of the ENTITY ID — no Math.random, no world RNG — so the same shot renders
// identically on host, client and replay. NPC bullets carry no mods and render
// exactly the vanilla gold tracer, so enemy fire is never confusable with a
// modded player build.

import { Container, Sprite } from 'pixi.js'
import type { Entity } from '../game/entity'
import { TILE_PX, type ArtRegistry } from './art'
import { EnergyFieldMesh } from './bulletShader'
import { composeBulletTraits, TRAIL_CAP, type BulletTraits } from './bulletVisuals'

/** Vanilla core radius in px (matches the pre-feature 4px tracer disc). */
const CORE_PX = 4
/** Core texture radius (art.bulletCore) — scale = wanted/CORE_TEX_R. */
const CORE_TEX_R = 8
const GLOW_TEX_R = 24
/** Trail ghost spacing in position-history frames. */
const TRAIL_STEP = 3
const HISTORY_MAX = (TRAIL_CAP + 1) * TRAIL_STEP

/** Deterministic per-id, per-frame hash in [0,1) — render-local jitter source. */
const hash01 = (id: number, frame: number): number => {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(frame ^ 0xc2b2ae35, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  return ((h >>> 16) & 0xffff) / 0x10000
}

interface BulletView {
  core: Sprite
  traits: BulletTraits
  /** Cache key: the serialized mod list this view was composed from. */
  modsKey: string
  /** Recent render positions (px), newest first: [x0,y0,x1,y1,…]. */
  history: number[]
  /** Sprite-fallback glow + trail ghosts (created lazily, shader-off only). */
  glow?: Sprite
  ghosts?: Sprite[]
  flecks?: Sprite[]
  seen: boolean
}

export class BulletLayer {
  readonly root = new Container()
  private energy = new EnergyFieldMesh()
  private coreLayer = new Container()
  private fallbackLayer = new Container()
  private fleckLayer = new Container()
  private views = new Map<number, BulletView>()

  constructor(private art: ArtRegistry) {
    // Energy under the cores: halo behind, hot disc on top for legibility.
    if (this.energy.ok) this.root.addChild(this.energy.root)
    this.root.addChild(this.fallbackLayer, this.coreLayer, this.fleckLayer)
  }

  private makeView(e: Entity): BulletView {
    const core = new Sprite(this.art.bulletCore())
    core.anchor.set(0.5)
    this.coreLayer.addChild(core)
    const mods = e.projectile?.mods
    return {
      core,
      traits: composeBulletTraits(mods),
      modsKey: JSON.stringify(mods ?? null),
      history: [],
      seen: true,
    }
  }

  update(entities: readonly Entity[], alpha: number, tick: number): void {
    const t = tick + alpha // sim view-time: deterministic on every peer/replay
    for (const v of this.views.values()) v.seen = false
    this.energy.begin()

    for (const e of entities) {
      if (e.dead || e.kind !== 'projectile' || e.archetype !== 'projectile') continue
      let view = this.views.get(e.id)
      if (!view) {
        view = this.makeView(e)
        this.views.set(e.id, view)
      } else {
        // Mods are immutable over a bullet's life, but a client id could in
        // principle be recycled — recompose if the provenance changed.
        const key = JSON.stringify(e.projectile?.mods ?? null)
        if (key !== view.modsKey) {
          view.traits = composeBulletTraits(e.projectile?.mods)
          view.modsKey = key
        }
      }
      view.seen = true
      const tr = view.traits
      const seed = hash01(e.id, 0)

      const wx = (e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha) * TILE_PX
      const wy = (e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha) * TILE_PX
      view.history.unshift(wx, wy)
      if (view.history.length > HISTORY_MAX * 2) view.history.length = HISTORY_MAX * 2

      // --- Core disc: tinted, elongated along heading, throb + arc jitter.
      const pulse = 1 + tr.pulse * 0.22 * Math.sin(t * 0.55 + seed * Math.PI * 2)
      const jx = tr.jitter * 2.2 * (hash01(e.id, Math.floor(t)) - 0.5)
      const jy = tr.jitter * 2.2 * (hash01(e.id ^ 0x5bd1, Math.floor(t)) - 0.5)
      const core = view.core
      core.position.set(wx + jx, wy + jy)
      core.rotation = e.facing
      core.tint = tr.color
      const s = (CORE_PX / CORE_TEX_R) * tr.size * pulse
      core.scale.set(s * tr.length, s)
      core.zIndex = wy

      // --- Energy field: halo + chroma via the batched shader (or sprite fallback).
      const wantGlow = tr.glow > 0 || tr.jitter > 0.05 || tr.chroma > 0
      const glowR = TILE_PX * (0.55 + 0.45 * tr.glow) * tr.size
      if (this.energy.ok) {
        if (wantGlow) {
          this.energy.push({
            x: wx, y: wy, angle: e.facing,
            radiusPx: glowR, stretch: 0.6 + 0.4 * tr.length,
            color: tr.glowColor,
            intensity: 0.25 + tr.glow * 0.9,
            pulse: tr.pulse, jitter: tr.jitter, chroma: tr.chroma,
            seed,
          })
        }
        // Trail ghosts: fading energy motes along the flight history.
        for (let j = 1; j <= tr.trail; j++) {
          const idx = j * TRAIL_STEP * 2
          if (idx + 1 >= view.history.length) break
          const fade = 1 - j / (tr.trail + 1)
          this.energy.push({
            x: view.history[idx], y: view.history[idx + 1], angle: e.facing,
            radiusPx: glowR * 0.55 * (0.4 + 0.6 * fade), stretch: 1,
            color: tr.trailColor,
            intensity: 0.5 * fade * (0.35 + tr.glow * 0.65),
            pulse: 0, jitter: tr.jitter * 0.5, chroma: 0,
            seed: seed + j * 0.173,
          })
        }
      } else {
        this.updateFallback(view, e, wx, wy, glowR, t)
      }

      // --- Splinter flecks: tiny shards orbiting the round.
      this.updateFlecks(view, wx, wy, t, seed)
    }

    for (const [id, view] of this.views) {
      if (!view.seen) {
        this.destroyView(view)
        this.views.delete(id)
      }
    }
    this.energy.end(t)
  }

  /** Sprite path for GPUs where the energy shader is unavailable: one tinted
   * additive halo + tinted ghost discs along the history. Same traits, same
   * positions — just without chroma/arc-warp. */
  private updateFallback(view: BulletView, e: Entity, wx: number, wy: number, glowR: number, t: number): void {
    const tr = view.traits
    if (tr.glow > 0) {
      if (!view.glow) {
        view.glow = new Sprite(this.art.bulletGlow())
        view.glow.anchor.set(0.5)
        view.glow.blendMode = 'add'
        this.fallbackLayer.addChild(view.glow)
      }
      const g = view.glow
      const pulse = 1 + tr.pulse * 0.22 * Math.sin(t * 0.55)
      g.position.set(wx, wy)
      g.tint = tr.glowColor
      g.alpha = 0.35 + tr.glow * 0.55
      g.scale.set((glowR / GLOW_TEX_R) * pulse)
    }
    if (tr.trail > 0) {
      view.ghosts ??= []
      while (view.ghosts.length < tr.trail) {
        const ghost = new Sprite(this.art.bulletCore())
        ghost.anchor.set(0.5)
        ghost.blendMode = 'add'
        this.fallbackLayer.addChild(ghost)
        view.ghosts.push(ghost)
      }
      for (let j = 0; j < view.ghosts.length; j++) {
        const ghost = view.ghosts[j]
        const idx = (j + 1) * TRAIL_STEP * 2
        if (idx + 1 >= view.history.length) {
          ghost.visible = false
          continue
        }
        const fade = 1 - (j + 1) / (tr.trail + 1)
        ghost.visible = true
        ghost.position.set(view.history[idx], view.history[idx + 1])
        ghost.rotation = e.facing
        ghost.tint = tr.trailColor
        ghost.alpha = 0.5 * fade
        const s = (CORE_PX / CORE_TEX_R) * tr.size * 0.8 * (0.4 + 0.6 * fade)
        ghost.scale.set(s * tr.length, s)
      }
    }
  }

  private updateFlecks(view: BulletView, wx: number, wy: number, t: number, seed: number): void {
    const tr = view.traits
    if (tr.flecks <= 0) return
    view.flecks ??= []
    while (view.flecks.length < 2) {
      const f = new Sprite(this.art.bulletCore())
      f.anchor.set(0.5)
      f.blendMode = 'add'
      f.scale.set(0.14 * tr.size)
      this.fleckLayer.addChild(f)
      view.flecks.push(f)
    }
    const orbit = TILE_PX * 0.22 * tr.size
    for (let k = 0; k < view.flecks.length; k++) {
      const f = view.flecks[k]
      const a = t * 0.35 + seed * Math.PI * 2 + k * Math.PI
      f.position.set(wx + Math.cos(a) * orbit, wy + Math.sin(a) * orbit)
      f.tint = tr.trailColor
      f.alpha = tr.flecks
    }
  }

  private destroyView(view: BulletView): void {
    this.coreLayer.removeChild(view.core)
    view.core.destroy()
    if (view.glow) {
      this.fallbackLayer.removeChild(view.glow)
      view.glow.destroy()
    }
    for (const ghost of view.ghosts ?? []) {
      this.fallbackLayer.removeChild(ghost)
      ghost.destroy()
    }
    for (const f of view.flecks ?? []) {
      this.fleckLayer.removeChild(f)
      f.destroy()
    }
  }
}
