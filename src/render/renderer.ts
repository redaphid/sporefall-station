import { Application, Container } from 'pixi.js'
import type { Level } from '../game/levelgen/level'
import type { RenderView } from '../app/session'
import { createArt, type ArtRegistry } from './art'
import { Camera } from './camera'
import { EntityViews } from './sprites'
import { TilemapView } from './tilemap'

export interface GameRenderer {
  app: Application
  camera: Camera
  setLevel(level: Level): void
  draw(view: RenderView, alpha: number, dt: number): void
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

  const art: ArtRegistry = createArt(app.renderer)
  const world = new Container()
  const tilemap = new TilemapView()
  const entities = new EntityViews(art)
  world.addChild(tilemap.root, entities.root)
  app.stage.addChild(world)

  const camera = new Camera()
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
      }
      camera.update(dt)
      entities.update(view.entities, alpha, view.tick)
      camera.apply(world, app.screen.width, app.screen.height, levelW, levelH)
      camera.viewRect(app.screen.width, app.screen.height, viewRect)
      tilemap.cull(viewRect.x, viewRect.y, viewRect.w, viewRect.h)
    },
  }
}
