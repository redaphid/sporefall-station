import { Application, Assets, Container, Sprite, Texture, type Renderer } from 'pixi.js'
import type { Level } from '../game/levelgen/level'
import type { RenderView } from '../app/session'
import { createArt, TILE_PX, type ArtRegistry, type DirSet, type Facing, type SpriteTextures } from './art'
import { Camera } from './camera'
import { EffectsLayer } from './effects'
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
const FLAME_PX = Math.round(TILE_PX * 1.4)
const FX_PX = Math.round(TILE_PX * 1.7)

/** Bake a source PNG to a fixed-size, renderer-friendly texture. Returns
 * undefined on failure so every sprite is optional and the procedural art in
 * art.ts fills any gap — a missing asset can never blank the screen. */
const bake = async (renderer: Renderer, url: string, size: number): Promise<Texture | undefined> => {
  try {
    const src: Texture = await Assets.load(url)
    const sprite = new Sprite(src)
    sprite.width = size
    sprite.height = size
    const holder = new Container()
    holder.addChild(sprite)
    const tex = renderer.generateTexture(holder)
    holder.destroy({ children: true })
    return tex
  } catch (err) {
    console.warn(`[sprites] failed to load ${url}, using procedural fallback`, err)
    return undefined
  }
}

const loadSprites = async (renderer: Renderer): Promise<SpriteTextures> => {
  const base = import.meta.env.BASE_URL
  const url = (name: string): string => `${base}sprites/${name}.png`
  const one = (name: string, size: number): Promise<Texture | undefined> =>
    bake(renderer, url(name), size)
  // Frame set: bake each frame, keep only the ones that loaded.
  const many = async (names: string[], size: number): Promise<Texture[]> =>
    (await Promise.all(names.map((n) => one(n, size)))).filter((t): t is Texture => t !== undefined)

  // Directional set: front/side/back × idle/step, under sprites/chars/<name>/.
  const DIRS: Facing[] = ['front', 'side', 'back']
  const dirSet = async (name: string): Promise<DirSet> => {
    const poses = await Promise.all(
      DIRS.map(async (d) => ({
        d,
        idle: await one(`chars/${name}/${d}-idle`, CHAR_PX),
        step: await one(`chars/${name}/${d}-step`, CHAR_PX),
      })),
    )
    return poses.reduce((set, p) => ({ ...set, [p.d]: { idle: p.idle, step: p.step } }), {} as DirSet)
  }
  const dirSetIfAny = async (name: string): Promise<DirSet | undefined> => {
    const set = await dirSet(name)
    return DIRS.some((d) => set[d].idle) ? set : undefined
  }

  const CHAR_NAMES = ['player', 'cop', 'thug', 'civilian', 'scientist', 'gangster', 'robot']
  const ITEM_NAMES = ['pistol', 'bat', 'knife', 'medkit', 'cash', 'shotgun', 'molotov', 'grenade-item']
  const PROP_NAMES = ['barrel', 'atm', 'vending-machine', 'tv', 'toilet']

  const record = async (
    names: string[],
    size: number,
    path: (n: string) => string,
  ): Promise<Record<string, Texture>> => {
    const loaded = await Promise.all(names.map((n) => one(path(n), size)))
    const out: Record<string, Texture> = {}
    names.forEach((n, i) => {
      const tex = loaded[i]
      if (tex) out[n] = tex
    })
    return out
  }

  const [
    floor, wall, player, cop, item, prop,
    thug, scientist, robot, thugStep, scientistStep, robotStep,
    flames, hit, explosion, pickup, blood,
    charSets, items, props,
  ] = await Promise.all([
    one('concrete-floor', TILE_PX), one('brick-wall', TILE_PX),
    one('player', CHAR_PX), one('cop', CHAR_PX), one('pistol', ITEM_PX), one('wooden-crate', TILE_PX),
    one('thug-idle', CHAR_PX), one('scientist-idle', CHAR_PX), one('robot-idle', CHAR_PX),
    one('thug-step', CHAR_PX), one('scientist-step', CHAR_PX), one('robot-step', CHAR_PX),
    many(['flame-1', 'flame-2', 'flame-3'], FLAME_PX),
    many(['hit-spark'], FX_PX),
    many(['explosion-1', 'explosion-2', 'explosion-3'], FX_PX),
    many(['pickup-sparkle'], FX_PX),
    many(['blood-splat'], FX_PX),
    Promise.all(CHAR_NAMES.map((n) => dirSetIfAny(n))),
    record(ITEM_NAMES, ITEM_PX, (n) => `items/${n}`),
    record(PROP_NAMES, TILE_PX, (n) => `props/${n}`),
  ])
  const chars: Record<string, DirSet> = {}
  CHAR_NAMES.forEach((n, i) => {
    const set = charSets[i]
    if (set) chars[n] = set
  })
  return {
    floor, wall, player, cop, item, prop,
    thug, scientist, robot, thugStep, scientistStep, robotStep,
    flames, hit, explosion, pickup, blood, chars, items, props,
  }
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
  const effects = new EffectsLayer(art)
  world.addChild(tilemap.root, entities.root, effects.root)
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
          if (ev.type === 'hit') {
            effects.spawn('hit', ev.x, ev.y, view.tick)
            if (view.self && ev.targetId === view.self.id) camera.shake(0.12)
          } else if (ev.type === 'death') {
            effects.spawn('blood', ev.x, ev.y, view.tick)
            camera.shake(0.05)
          }
          else if (ev.type === 'explosion') {
            effects.spawn('explosion', ev.x, ev.y, view.tick)
            camera.shake(0.2)
          } else if (ev.type === 'pickup') {
            const by = view.entities.find((e) => e.id === ev.byId)
            if (by) effects.spawn('pickup', by.pos.x, by.pos.y, view.tick)
          }
        }
        sound.handle(view.events)
      }
      camera.update(dt)
      entities.update(view.entities, alpha, view.tick)
      effects.update(view.tick, alpha)
      camera.apply(world, app.screen.width, app.screen.height, levelW, levelH)
      camera.viewRect(app.screen.width, app.screen.height, viewRect)
      tilemap.cull(viewRect.x, viewRect.y, viewRect.w, viewRect.h)
    },
  }
}
