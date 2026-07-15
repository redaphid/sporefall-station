import { Application, Assets, Container, Sprite, Texture, type Renderer } from 'pixi.js'
import type { Level } from '../game/levelgen/level'
import type { RenderView } from '../app/session'
import { createArt, TILE_PX, type ArtRegistry, type SpriteTextures } from './art'
import { Camera } from './camera'
import { Sound } from './sound'
import { EntityViews } from './sprites'
import { TilemapView } from './tilemap'

export interface GameRenderer {
  app: Application
  camera: Camera
  setLevel(level: Level): void
  draw(view: RenderView, alpha: number, dt: number): void
}

const CHAR_PX = Math.round(TILE_PX * 0.95)
const ITEM_PX = Math.round(TILE_PX * 0.6)

const loadSprites = async (renderer: Renderer): Promise<SpriteTextures> => {
  const base = import.meta.env.BASE_URL
  const specs: { key: keyof SpriteTextures; url: string; size: number }[] = [
    { key: 'floor', url: `${base}sprites/concrete-floor.png`, size: TILE_PX },
    { key: 'wall', url: `${base}sprites/brick-wall.png`, size: TILE_PX },
    { key: 'player', url: `${base}sprites/player.png`, size: CHAR_PX },
    { key: 'cop', url: `${base}sprites/cop.png`, size: CHAR_PX },
    { key: 'item', url: `${base}sprites/pistol.png`, size: ITEM_PX },
    { key: 'prop', url: `${base}sprites/wooden-crate.png`, size: TILE_PX },
  ]
  const out: SpriteTextures = {}
  for (const { key, url, size } of specs) {
    try {
      const src: Texture = await Assets.load(url)
      const sprite = new Sprite(src)
      sprite.width = size
      sprite.height = size
      const holder = new Container()
      holder.addChild(sprite)
      out[key] = renderer.generateTexture(holder)
      holder.destroy({ children: true })
    } catch (err) {
      console.warn(`[sprites] failed to load ${url}, using procedural fallback`, err)
    }
  }
  return out
}

export const createRenderer = async (mount: HTMLElement): Promise<GameRenderer> => {
  const app = new Application()
  await app.init({
    resizeTo: mount,
    background: 0x0b0b12,
    // Fill-rate is the mid-range phone bottleneck — cap DPR at 2.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    antialias: false,
  })
  mount.appendChild(app.canvas)

  const spriteTextures = await loadSprites(app.renderer)
  const art: ArtRegistry = createArt(app.renderer, spriteTextures)
  const world = new Container()
  const tilemap = new TilemapView()
  const entities = new EntityViews(art)
  world.addChild(tilemap.root, entities.root)
  app.stage.addChild(world)

  const camera = new Camera()
  const sound = new Sound()
  const viewRect = { x: 0, y: 0, w: 0, h: 0 }
  let levelW = 0
  let levelH = 0
  let lastEventTick = -1

  return {
    app,
    camera,
    setLevel(level: Level): void {
      tilemap.build(level, art)
      levelW = level.w
      levelH = level.h
      camera.snapTo(level.spawn.x, level.spawn.y)
    },
    draw(view: RenderView, alpha: number, dt: number): void {
      // Event-driven juice: shake hard when our player is hit, lightly on deaths.
      // Events live for one sim tick but draw runs every frame — process once per tick.
      if (view.tick !== lastEventTick) {
        lastEventTick = view.tick
        for (const ev of view.events) {
          if (ev.type === 'hit' && view.self && ev.targetId === view.self.id) camera.shake(0.12)
          else if (ev.type === 'death') camera.shake(0.05)
          else if (ev.type === 'explosion') camera.shake(0.2)
        }
        sound.handle(view.events)
      }
      camera.update(dt)
      entities.update(view.entities, alpha, view.tick)
      camera.apply(world, app.screen.width, app.screen.height, levelW, levelH)
      camera.viewRect(app.screen.width, app.screen.height, viewRect)
      tilemap.cull(viewRect.x, viewRect.y, viewRect.w, viewRect.h)
    },
  }
}
