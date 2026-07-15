import { Container, Sprite } from 'pixi.js'
import { onceFrame } from './anim'
import { TILE_PX, type ArtRegistry, type EffectKey } from './art'

interface Active {
  sprite: Sprite
  key: EffectKey
  startTick: number
}

/** Ticks-per-frame per effect. Single-frame clips (hit/pickup) just hold their
 * one frame for this many ticks while the pop/fade juice plays; the 3-frame
 * explosion advances through its frames. */
const EFFECT_TPF: Record<EffectKey, number> = { hit: 6, explosion: 5, pickup: 10, blood: 12 }

/** A layer of short-lived, view-only effect sprites (hit sparks, explosions,
 * pickup sparkles). Spawned from sim events, played once off the tick, then
 * dropped. Never touches sim state; a missing asset makes spawn a no-op. */
export class EffectsLayer {
  readonly root = new Container()
  private active: Active[] = []

  constructor(private art: ArtRegistry) {
    this.root.sortableChildren = true
  }

  /** Start an effect at a world position (tiles). No-op if its art is missing. */
  spawn(key: EffectKey, x: number, y: number, tick: number): void {
    const frames = this.art.effectFrames(key)
    if (frames.length === 0) return
    const sprite = new Sprite(frames[0])
    sprite.anchor.set(0.5)
    // Glows pop with additive blend; blood is opaque and sits under the actors.
    sprite.blendMode = key === 'blood' ? 'normal' : 'add'
    sprite.position.set(x * TILE_PX, y * TILE_PX)
    sprite.zIndex = key === 'blood' ? y - 1000 : y + 2000
    this.root.addChild(sprite)
    this.active.push({ sprite, key, startTick: tick })
  }

  /** Advance every live effect; retire the finished ones. */
  update(tick: number, alpha: number): void {
    const t = tick + alpha
    const kept: Active[] = []
    for (const a of this.active) {
      const frames = this.art.effectFrames(a.key)
      const tpf = EFFECT_TPF[a.key]
      const frame = onceFrame(tick, a.startTick, frames.length, tpf)
      if (frame < 0) {
        this.root.removeChild(a.sprite)
        a.sprite.destroy()
        continue
      }
      a.sprite.texture = frames[frame]
      // Pop in and fade out across the clip's life for a punchy one-shot.
      const life = frames.length * tpf
      const p = Math.min(1, (t - a.startTick) / life)
      a.sprite.scale.set(0.6 + p * 0.9)
      a.sprite.alpha = 1 - p * p
      kept.push(a)
    }
    this.active = kept
  }
}
