import { Application, ColorMatrixFilter, Container, Sprite, Texture } from 'pixi.js'
import { Capacitor } from '@capacitor/core'
import type { Level } from '../game/levelgen/level'
import type { RenderView } from '../app/session'
import { loadSettings } from '../app/settings'
import { createArt, type ArtRegistry } from './art'
import { BulletLayer } from './bullets'
import { resolvePalette, resolveThemeId, type ThemeChain } from './theme'
import { loadSpriteTextures, loadThemeChain, listThemes } from './themeLoader'
import { setActiveThemeChain } from './themeState'
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
  /** Hot-swap the active visual theme (presentation only — never touches the
   * sim). Resolves when the new assets are baked and applied. */
  setTheme(id: string): Promise<void>
  /** Sprite thumbnail for an art key ('cop', 'medkit', 'door', …) as a PNG data
   * URL — the inspect card's picture of the thing tapped. Extracted from the
   * live art registry (so it matches the active theme exactly), cached per key,
   * cache dropped on theme swap. Undefined when extraction isn't possible. */
  entityThumb(artKey: string): string | undefined
}

/** Canvas clear color when no theme palette provides one. */
const DEFAULT_BACKGROUND = 0x0b0b12

export const createRenderer = async (mount: HTMLElement): Promise<GameRenderer> => {
  const app = new Application()
  await app.init({
    resizeTo: mount,
    background: DEFAULT_BACKGROUND,
    // Fill-rate is the mid-range phone bottleneck — cap DPR at 2.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    antialias: false,
  })
  mount.appendChild(app.canvas)

  // --- Theme: `?theme=` (dev, session-only) beats the persisted setting. The
  // chain is [active, city]; every miss falls through to procedural art.
  const themeParam = new URLSearchParams(location.search).get('theme')
  let chain: ThemeChain = await loadThemeChain(resolveThemeId(themeParam, loadSettings().theme))
  setActiveThemeChain(chain)
  const buildArt = async (c: ThemeChain): Promise<ArtRegistry> => {
    const p = resolvePalette(c)
    return createArt(app.renderer, await loadSpriteTextures(app.renderer, c), { tiles: p.tiles, entities: p.entities })
  }
  // Facade over the swappable registry so the tilemap/entity/effect layers keep
  // a stable reference across runtime theme changes.
  let inner: ArtRegistry = await buildArt(chain)
  const art: ArtRegistry = {
    tile: (id, v) => inner.tile(id, v),
    entity: (a) => inner.entity(a),
    entityFlash: (a, d) => inner.entityFlash(a, d),
    isCharacterSprite: (a) => inner.isCharacterSprite(a),
    characterSet: (a) => inner.characterSet(a),
    walkStep: (a) => inner.walkStep(a),
    flameFrames: () => inner.flameFrames(),
    effectFrames: (k) => inner.effectFrames(k),
    bulletCore: () => inner.bulletCore(),
    bulletGlow: () => inner.bulletGlow(),
    themedBullet: () => inner.themedBullet(),
  }
  const world = new Container()
  const tilemap = new TilemapView()
  const entities = new EntityViews(art)
  const bullets = new BulletLayer(art)
  const effects = new EffectsLayer(art)
  world.addChild(tilemap.root, entities.root, bullets.root, effects.root)
  app.stage.addChild(world)

  const applyThemePalette = (c: ThemeChain): void => {
    const p = resolvePalette(c)
    app.renderer.background.color = p.background ?? DEFAULT_BACKGROUND
    tilemap.root.tint = p.floorTint ?? 0xffffff
    if (p.uiAccent !== undefined)
      document.documentElement.style.setProperty('--theme-accent', `#${p.uiAccent.toString(16).padStart(6, '0')}`)
    else document.documentElement.style.removeProperty('--theme-accent')
  }
  applyThemePalette(chain)

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

  let currentLevel: Level | undefined
  // Inspect-card thumbnails: art key → data URL, extracted lazily from the live
  // registry. Theme-keyed implicitly — the cache empties on every theme swap.
  const thumbs = new Map<string, string | undefined>()
  const entityThumb = (artKey: string): string | undefined => {
    if (thumbs.has(artKey)) return thumbs.get(artKey)
    let url: string | undefined
    try {
      const canvas = app.renderer.extract.canvas(inner.entity(artKey)) as HTMLCanvasElement
      url = typeof canvas.toDataURL === 'function' ? canvas.toDataURL() : undefined
    } catch {
      url = undefined // headless/degraded contexts: the card falls back to a glyph
    }
    thumbs.set(artKey, url)
    return url
  }
  const setTheme = async (id: string): Promise<void> => {
    chain = await loadThemeChain(id)
    setActiveThemeChain(chain)
    inner = await buildArt(chain)
    applyThemePalette(chain)
    thumbs.clear() // thumbnails must re-extract from the swapped registry
    // Rebake the static tile layer and drop pooled entity sprites so every
    // layer re-pulls textures from the swapped registry on the next frame.
    if (currentLevel) tilemap.build(currentLevel, art)
    entities.refresh()
    bullets.refresh()
  }

  const native = Capacitor.isNativePlatform()
  // The panel reports live changes through the callback; hold the latest here so
  // haptics + the effects-quality gate pick them up without a reload. A theme
  // change from the panel hot-swaps the renderer's assets.
  const themeList = await listThemes()
  let settings = createSettingsPanel(
    mount,
    native,
    (s) => {
      const prevTheme = settings.theme
      settings = s
      if (s.theme !== prevTheme) void setTheme(s.theme)
    },
    themeList,
  ).settings()
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
    setTheme,
    entityThumb,
    setLevel(level: Level): void {
      currentLevel = level
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
        bullets.update(view.entities, alpha, view.tick)
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
