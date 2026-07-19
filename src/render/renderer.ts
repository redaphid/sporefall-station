import { Application, Assets, ColorMatrixFilter, Container, Sprite, Texture, type Renderer } from 'pixi.js'
import { Capacitor } from '@capacitor/core'
import type { Level } from '../game/levelgen/level'
import type { RenderView } from '../app/session'
import { CHAR_PX, createArt, FACINGS, TILE_PX, type ArtRegistry, type DirSet, type Facing, type SpriteTextures } from './art'
import { Camera } from './camera'
import { EffectsLayer } from './effects'
import { createHaptics } from './haptics'
import { nativeHapticDriver } from './hapticsDriver'
import {
  addHitstop,
  decayTint,
  decayVignette,
  hitstopForEvent,
  lowHealthVignette,
  shakeForEvent,
  tickHitstop,
  tintForEvent,
  VIGNETTE_MAX,
} from './juice'
import { createSettingsPanel } from './settingsPanel'
import { Sound } from './sound'
import { EntityViews } from './sprites'
import { TilemapView } from './tilemap'

/** Cold blue used to recolour frost (shatter/shock) sparks. */
const FROST_TINT = 0x8fd0ff

export interface GameRenderer {
  app: Application
  camera: Camera
  setLevel(level: Level): void
  draw(view: RenderView, alpha: number, dt: number): void
}

const ITEM_PX = Math.round(TILE_PX * 0.6)
const FLAME_PX = Math.round(TILE_PX * 1.4)
const FX_PX = Math.round(TILE_PX * 1.7)

/** Bake a source PNG to a fixed-size, renderer-friendly texture. Returns
 * undefined on failure so every sprite is optional and the procedural art in
 * art.ts fills any gap — a missing asset can never blank the screen. */
const bake = async (
  renderer: Renderer,
  url: string,
  size: number,
  quiet = false,
): Promise<Texture | undefined> => {
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
    // Probe loads (a fallback exists) fail silently; real gaps still warn.
    if (!quiet) console.warn(`[sprites] failed to load ${url}, using procedural fallback`, err)
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

  // Directional set: s/se/e/ne/n × idle/step, under sprites/chars/<name>/
  // (files named `<dir>-<frame>.png`). Legacy 3-direction packs still load:
  // front→s, side→e, back→n; missing diagonals fall back per-facing at render
  // time (FACING_FALLBACK), so old themes keep working untouched.
  const LEGACY_DIR: Partial<Record<Facing, string>> = { s: 'front', e: 'side', n: 'back' }
  const dirSet = async (name: string): Promise<DirSet> => {
    // Every pose is optional (render-time fallback covers gaps), so probes are
    // quiet — a theme missing some directions is normal, not an error.
    const pose = async (d: Facing, frame: 'idle' | 'step'): Promise<Texture | undefined> => {
      const tex = await bake(renderer, url(`chars/${name}/${d}-${frame}`), CHAR_PX, true)
      const legacy = LEGACY_DIR[d]
      if (tex || !legacy) return tex
      return bake(renderer, url(`chars/${name}/${legacy}-${frame}`), CHAR_PX, true)
    }
    const poses = await Promise.all(
      FACINGS.map(async (d) => ({ d, idle: await pose(d, 'idle'), step: await pose(d, 'step') })),
    )
    return poses.reduce((set, p) => ({ ...set, [p.d]: { idle: p.idle, step: p.step } }), {} as DirSet)
  }
  const dirSetIfAny = async (name: string): Promise<DirSet | undefined> => {
    const set = await dirSet(name)
    return FACINGS.some((d) => set[d].idle) ? set : undefined
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

  // --- Screen-space post overlays (drawn on the stage, above the shaken world).
  // Cheap full-screen tints: red damage/low-health vignette + warm/cold element
  // wash. A single ColorMatrixFilter adds a bloom-ish grade only on 'high'.
  const overlay = (blend: 'normal' | 'add', tint: number): Sprite => {
    const s = new Sprite(Texture.WHITE)
    s.tint = tint
    s.alpha = 0
    s.blendMode = blend
    s.eventMode = 'none'
    app.stage.addChild(s)
    return s
  }
  const damageOverlay = overlay('normal', 0xd11a1a)
  const warmOverlay = overlay('add', 0xff7a1a)
  const coldOverlay = overlay('add', 0x3aa0ff)
  const grade = new ColorMatrixFilter()

  const native = Capacitor.isNativePlatform()
  // The panel reports live changes through the callback; hold the latest here so
  // haptics + the effects-quality gate pick them up without a reload.
  let settings = createSettingsPanel(mount, native, (s) => (settings = s)).settings()
  const haptics = createHaptics(nativeHapticDriver(), () => settings)

  const viewRect = { x: 0, y: 0, w: 0, h: 0 }
  let levelW = 0
  let levelH = 0
  let lastEventTick = -1
  // Juice state carried across frames.
  let hitstop = 0
  let vignette = 0
  let warm = 0
  let cold = 0
  let elapsed = 0
  let graded = false

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
      elapsed += dt
      const fx = settings.effectsQuality
      const juicing = fx !== 'off'
      // Event-driven juice: sparks/gibs, camera shake, hitstop, element tint, and
      // haptics. Events live for one sim tick but draw runs every frame — process
      // once per tick.
      if (view.tick !== lastEventTick) {
        lastEventTick = view.tick
        for (const ev of view.events) {
          const isSelf =
            view.self != null &&
            (('targetId' in ev && ev.targetId === view.self.id) ||
              ('entityId' in ev && ev.entityId === view.self.id))
          // A red vignette flash only when it's the local player getting hurt.
          const selfHurt = isSelf && (ev.type === 'hit' || ev.type === 'death')
          // Spark/gib layer + element-flavoured recolour.
          if (ev.type === 'hit') {
            effects.spawn('hit', ev.x, ev.y, view.tick)
          } else if (ev.type === 'death') {
            effects.spawn('blood', ev.x, ev.y, view.tick)
          } else if (ev.type === 'explosion') {
            effects.spawn('explosion', ev.x, ev.y, view.tick)
          } else if (ev.type === 'shatter') {
            effects.spawn('hit', ev.x, ev.y, view.tick, FROST_TINT)
          } else if (ev.type === 'shock') {
            effects.spawn('hit', ev.x, ev.y, view.tick, FROST_TINT)
          } else if (ev.type === 'pickup' || ev.type === 'modPickup') {
            const by = view.entities.find((e) => e.id === ev.byId)
            if (by) effects.spawn('pickup', by.pos.x, by.pos.y, view.tick)
          }
          if (juicing) {
            camera.shake(shakeForEvent(ev, isSelf))
            hitstop = addHitstop(hitstop, hitstopForEvent(ev, isSelf))
            const t = tintForEvent(ev)
            warm = Math.min(1, warm + t.warm)
            cold = Math.min(1, cold + t.cold)
            if (selfHurt) vignette = Math.min(VIGNETTE_MAX, vignette + 0.35)
          }
        }
        sound.handle(view.events)
        haptics.handle(view.events, view.self)
      }

      // Hitstop: hold the actors still for a few frames on a weighty impact for a
      // sense of weight; the shake keeps jittering (dt=0 freezes its decay).
      const frozen = hitstop > 0
      if (frozen) hitstop = tickHitstop(hitstop)
      camera.update(frozen ? 0 : dt)
      if (!frozen) {
        entities.update(view.entities, alpha, view.tick)
        effects.update(view.tick, alpha)
      }
      camera.apply(world, app.screen.width, app.screen.height, levelW, levelH)
      camera.viewRect(app.screen.width, app.screen.height, viewRect)
      tilemap.cull(viewRect.x, viewRect.y, viewRect.w, viewRect.h)

      // --- Screen post: damage/low-health vignette + element wash + grade.
      vignette = decayVignette(vignette, dt)
      warm = juicing ? decayTint(warm, dt) : 0
      cold = juicing ? decayTint(cold, dt) : 0
      // Sustained low-health pulse — gated OFF while the local player is downed/
      // dead or the run is over, so a 0-hp body never sticks the screen red under
      // the (missing) restart overlay. The one-shot damage flash (`vignette`)
      // still lands on the killing blow, then decays. See juice.lowHealthVignette.
      const self = view.self
      const vitals =
        self?.health && self.health.max > 0
          ? {
              hpFrac: Math.max(0, self.health.hp) / self.health.max,
              downed: self.playerCtl?.downed != null,
              dead: !!self.dead,
            }
          : null
      const red = juicing ? Math.max(vignette, lowHealthVignette(vitals, view.gameOver, elapsed)) : 0
      const sw = app.screen.width
      const sh = app.screen.height
      for (const [ov, a] of [
        [damageOverlay, red],
        [warmOverlay, warm * 0.35],
        [coldOverlay, cold * 0.3],
      ] as const) {
        ov.alpha = a
        if (a > 0) ov.setSize(sw, sh)
      }
      // Warm bloom / cold desaturation grade only on 'high' (a real GPU filter).
      const wantGrade = fx === 'high' && (warm > 0 || cold > 0)
      if (wantGrade) {
        grade.reset()
        if (warm > 0) {
          grade.brightness(1 + warm * 0.2, true)
          grade.saturate(warm * 0.4, true)
        }
        if (cold > 0) grade.saturate(-cold * 0.5, true)
      }
      if (wantGrade !== graded) {
        graded = wantGrade
        world.filters = wantGrade ? [grade] : []
      }
    },
  }
}
