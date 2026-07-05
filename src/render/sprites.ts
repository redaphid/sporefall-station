import { Container, Sprite } from 'pixi.js'
import type { Entity } from '../game/entity'
import { TILE_PX, type ArtRegistry } from './art'

interface View {
  sprite: Sprite
  archetype: string
  seen: boolean
  flashing: boolean
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

    for (const e of entities) {
      if (e.dead) continue
      let view = this.views.get(e.id)
      if (!view || view.archetype !== e.archetype) {
        if (view) {
          this.root.removeChild(view.sprite)
          view.sprite.destroy()
        }
        const sprite = new Sprite(this.art.entity(e.archetype))
        sprite.anchor.set(0.5)
        this.root.addChild(sprite)
        view = { sprite, archetype: e.archetype, seen: true, flashing: false }
        this.views.set(e.id, view)
      }
      view.seen = true
      const flashing = e.status !== undefined && e.status.hitFlashUntil > tick
      if (flashing !== view.flashing) {
        view.flashing = flashing
        view.sprite.texture = flashing ? this.art.entityFlash(e.archetype) : this.art.entity(e.archetype)
      }
      // Pickups don't rotate; actors face their heading.
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha
      view.sprite.position.set(x * TILE_PX, y * TILE_PX)
      view.sprite.rotation = e.kind === 'pickup' || e.kind === 'door' ? 0 : e.facing
      view.sprite.zIndex = y
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
