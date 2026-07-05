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
        view = { sprite, archetype: artKey, seen: true, flashing: false }
        this.views.set(e.id, view)
      }
      view.seen = true
      const flashing = e.status !== undefined && e.status.hitFlashUntil > tick
      if (flashing !== view.flashing) {
        view.flashing = flashing
        view.sprite.texture = flashing ? this.art.entityFlash(artKey) : this.art.entity(artKey)
      }
      // Downed players faded hard; cloaked thieves shimmer translucent
      const cloaked = e.status !== undefined && e.status.cloakUntil > tick
      view.sprite.alpha = e.playerCtl?.downed ? 0.45 : cloaked ? 0.55 : 1
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
