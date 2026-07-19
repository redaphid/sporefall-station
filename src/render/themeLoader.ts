/**
 * Async half of the theme system: fetch + validate manifests into a theme
 * chain, and bake the chain's sprite files into the SpriteTextures record the
 * ArtRegistry consumes. Every failure here degrades (manifest fetch → shorter
 * chain; file load → procedural art for that key) and logs a warning — a
 * broken theme can never crash or blank the game.
 */

import { Assets, Container, Sprite, Texture, type Renderer } from 'pixi.js'
import {
  CHAR_NAMES,
  DEFAULT_THEME_ID,
  DIRS5,
  ITEM_IDS,
  isValidThemeId,
  PROP_NAMES,
  resolveMacroTiles,
  resolveSpritePaths,
  TILE_NAMES,
  validateManifest,
  type LoadedTheme,
  type ThemeChain,
} from './theme'
import { CHAR_PX, TILE_PX, type CharSet, type DirPose, type SpriteTextures } from './art'
import { ANIM_STATES, MAX_ANIM_FRAMES, type AnimStateName } from './animState'

const BASE = import.meta.env.BASE_URL

// Bake sizes per slot. Characters follow the 48×48 authoring canvas
// (docs/themes.md "Character art convention" — CHAR_PX in art.ts) —
// deliberately larger than the 32px tile so bodies overhang their tile.
export const CHAR_CANVAS_PX = CHAR_PX
const ITEM_PX = Math.round(TILE_PX * 0.6)
const FLAME_PX = Math.round(TILE_PX * 1.4)
const FX_PX = Math.round(TILE_PX * 1.7)
const PROJECTILE_PX = 12
const GRENADE_PX = 14

/** Bake a source PNG to a fixed-size, renderer-friendly texture. Returns
 * undefined on failure so every sprite stays optional and the procedural art
 * in art.ts fills the gap — a missing asset can never blank the screen. */
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
    console.warn(`[theme] failed to load ${url}, using procedural fallback`, err)
    return undefined
  }
}

/** Fetch + validate one theme's manifest. Undefined when it can't be loaded. */
export const fetchTheme = async (id: string): Promise<LoadedTheme | undefined> => {
  const dir = `themes/${id}/`
  try {
    const res = await fetch(`${BASE}${dir}manifest.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { manifest, warnings } = validateManifest(await res.json())
    for (const w of warnings) console.warn(`[theme:${id}] ${w}`)
    return { id, dir, manifest }
  } catch (err) {
    console.warn(`[theme] could not load theme "${id}"`, err)
    return undefined
  }
}

/** Build the resolution chain for a theme id: [active, city] (city alone when
 * it IS the active theme; possibly shorter when a fetch fails). */
export const loadThemeChain = async (id: string): Promise<ThemeChain> => {
  const wanted = isValidThemeId(id) ? id : DEFAULT_THEME_ID
  const base = await fetchTheme(DEFAULT_THEME_ID)
  const active = wanted === DEFAULT_THEME_ID ? undefined : await fetchTheme(wanted)
  return [active, base].filter((t): t is LoadedTheme => t !== undefined)
}

export interface ThemeInfo {
  id: string
  name: string
}

/** Themes advertised to the settings picker (public/themes/index.json). Any
 * failure falls back to just the default theme — the picker never breaks. */
export const listThemes = async (): Promise<ThemeInfo[]> => {
  const fallback: ThemeInfo[] = [{ id: DEFAULT_THEME_ID, name: 'City' }]
  try {
    const res = await fetch(`${BASE}themes/index.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw: unknown = await res.json()
    if (!Array.isArray(raw)) throw new Error('index.json: expected an array')
    const themes = raw.filter(
      (t): t is ThemeInfo =>
        typeof t === 'object' && t !== null && isValidThemeId((t as ThemeInfo).id) && typeof (t as ThemeInfo).name === 'string',
    )
    return themes.length > 0 ? themes : fallback
  } catch (err) {
    console.warn('[theme] could not list themes', err)
    return fallback
  }
}

/** Bake every sprite the chain resolves into the ArtRegistry's texture record.
 * Keys nobody maps stay undefined → procedural art. */
export const loadSpriteTextures = async (renderer: Renderer, chain: ThemeChain): Promise<SpriteTextures> => {
  const urls = (key: string): string[] | undefined => resolveSpritePaths(key, chain)?.map((p) => BASE + p)
  const one = async (key: string, size: number): Promise<Texture | undefined> => {
    const u = urls(key)
    return u && u.length > 0 ? bake(renderer, u[0], size) : undefined
  }
  const many = async (key: string, size: number): Promise<Texture[]> => {
    const u = urls(key) ?? []
    return (await Promise.all(u.map((f) => bake(renderer, f, size)))).filter((t): t is Texture => t !== undefined)
  }

  // Animation-state clip: frames n = 0,1,2,… must be CONTIGUOUS from 0 in the
  // manifest — the first unmapped index ends the clip (a bake failure on a
  // mapped frame also truncates there, degrading to a shorter clip).
  const clip = async (name: string, d: string, state: AnimStateName): Promise<Texture[]> => {
    const frames: Texture[] = []
    for (let n = 0; n < MAX_ANIM_FRAMES; n++) {
      const tex = await one(`char.${name}.${d}-${state}-${n}`, CHAR_CANVAS_PX)
      if (!tex) break
      frames.push(tex)
    }
    return frames
  }

  // Directional character set: 5 drawn dirs × (legacy idle/step + named-state
  // clips), west half mirrored at draw time. Kept only when at least one
  // direction has an idle pose (legacy frame or idle clip).
  const charSet = async (name: string): Promise<CharSet | undefined> => {
    const poses = await Promise.all(
      DIRS5.map(async (d): Promise<[typeof d, DirPose]> => {
        const [idle, step] = await Promise.all([
          one(`char.${name}.${d}-idle`, CHAR_CANVAS_PX),
          one(`char.${name}.${d}-step`, CHAR_CANVAS_PX),
        ])
        const stateClips = await Promise.all(ANIM_STATES.map((s) => clip(name, d, s)))
        const clips: DirPose['clips'] = {}
        ANIM_STATES.forEach((s, i) => {
          const frames = stateClips[i]
          if (frames.length > 0) clips[s] = frames
        })
        const pose: DirPose = { idle, step }
        if (Object.keys(clips).length > 0) pose.clips = clips
        return [d, pose]
      }),
    )
    const set: CharSet = {}
    for (const [d, pose] of poses) if (pose.idle || pose.step || pose.clips) set[d] = pose
    return Object.values(set).some((p) => p.idle || p.clips?.idle?.length) ? set : undefined
  }

  const record = async (keys: readonly string[], size: number, prefix: string): Promise<Record<string, Texture>> => {
    const loaded = await Promise.all(keys.map((k) => one(`${prefix}.${k}`, size)))
    const out: Record<string, Texture> = {}
    keys.forEach((k, i) => {
      const tex = loaded[i]
      if (tex) out[k] = tex
    })
    return out
  }

  // Tile variant/accent pools, keyed by tile name. A name with zero loaded
  // frames is dropped so `tiles.grass` is either a non-empty pool or absent
  // (→ procedural art), never a blank tile.
  const tilePools = async (suffix: string): Promise<Record<string, Texture[]>> => {
    const pools = await Promise.all(TILE_NAMES.map((n) => many(`tile.${n}${suffix}`, TILE_PX)))
    const out: Record<string, Texture[]> = {}
    TILE_NAMES.forEach((n, i) => {
      if (pools[i].length > 0) out[n] = pools[i]
    })
    return out
  }

  const [
    tiles, tileAccents, tileOverlays, player, cop, item, prop,
    thug, scientist, robot, thugStep, scientistStep, robotStep,
    projectile, grenade,
    flames, hit, explosion, pickup, blood,
    charSets, items, props,
  ] = await Promise.all([
    tilePools(''), tilePools('.accent'), tilePools('.overlay'),
    one('unit.player', CHAR_CANVAS_PX), one('unit.cop', CHAR_CANVAS_PX),
    one('item.default', ITEM_PX), one('prop.default', TILE_PX),
    one('unit.thug.idle', CHAR_CANVAS_PX), one('unit.scientist.idle', CHAR_CANVAS_PX), one('unit.robot.idle', CHAR_CANVAS_PX),
    one('unit.thug.step', CHAR_CANVAS_PX), one('unit.scientist.step', CHAR_CANVAS_PX), one('unit.robot.step', CHAR_CANVAS_PX),
    one('projectile', PROJECTILE_PX), one('grenade', GRENADE_PX),
    many('fx.flame', FLAME_PX),
    many('fx.hit', FX_PX),
    many('fx.explosion', FX_PX),
    many('fx.pickup', FX_PX),
    many('fx.blood', FX_PX),
    Promise.all(CHAR_NAMES.map((n) => charSet(n))),
    record(ITEM_IDS, ITEM_PX, 'item'),
    record(PROP_NAMES, TILE_PX, 'prop'),
  ])

  const chars: Record<string, CharSet> = {}
  CHAR_NAMES.forEach((n, i) => {
    const set = charSets[i]
    if (set) chars[n] = set
  })

  return {
    tiles, tileAccents, tileOverlays, tileMacro: resolveMacroTiles(chain), player, cop, item, prop,
    thug, scientist, robot, thugStep, scientistStep, robotStep,
    projectile, grenade,
    flames, hit, explosion, pickup, blood, chars, items, props,
  }
}
