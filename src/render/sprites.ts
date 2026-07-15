import { Container, Sprite } from 'pixi.js'
import type { Entity, Fx } from '../game/entity'
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
      // Element tints read the status at a glance: frozen ice-blue, electrified
      // shock-yellow, burning ember-orange, wet a cool slick. Hit-flash wins.
      view.sprite.tint = flashing ? 0xffffff : elementTint(e.fx)
      // Pickups don't rotate; actors face their heading.
      const x = e.prevPos.x + (e.pos.x - e.prevPos.x) * alpha
      const y = e.prevPos.y + (e.pos.y - e.prevPos.y) * alpha
      view.sprite.position.set(x * TILE_PX, y * TILE_PX)
      view.sprite.rotation = e.kind === 'pickup' || e.kind === 'door' || e.kind === 'fire' ? 0 : e.facing
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
