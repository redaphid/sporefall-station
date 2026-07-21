/**
 * Theme schema + pure resolution logic. A theme is a declarative package
 * (public/themes/<id>/manifest.json + asset files) that reskins the game —
 * sprites, palette, entity display names — without touching the sim. This
 * module is deliberately DOM/pixi-free so every rule (validation, fallback
 * order, name lookup, palette merging) is unit-testable; the async loading
 * lives in themeLoader.ts. Schema doc: docs/themes.md (the contract the
 * asset-generation pipeline targets — keep them in sync).
 */

import { ANIM_STATES, DEFAULT_TPF, MAX_ANIM_FRAMES, type AnimStateName } from './animState'

// Sporefall Station is the one shipped theme (the old city/test packs are no
// longer supported). It is also the fallback base of the resolution chain, so
// any un-mapped sprite falls through to procedural art rather than another pack.
export const DEFAULT_THEME_ID = 'swampspace'

/** Theme ids are folder names under public/themes/ — keep them URL/path safe. */
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]*$/
export const isValidThemeId = (id: unknown): id is string =>
  typeof id === 'string' && id.length <= 64 && THEME_ID_RE.test(id)

/** Pick the boot theme: dev URL param (session-only) beats the persisted
 * setting; anything invalid falls through to the default. */
export const resolveThemeId = (urlParam: string | null | undefined, setting: string | undefined): string => {
  if (isValidThemeId(urlParam)) return urlParam
  if (isValidThemeId(setting)) return setting
  return DEFAULT_THEME_ID
}

// ---------------------------------------------------------------------------
// Canonical sprite keys — the complete set a theme may map. Everything else in
// a manifest is a typo and gets warned + dropped so bad packs fail loud (in the
// console and in validateManifest tests), never silently.

/** Characters draw 5 directions; the west half is the east half mirrored. */
export type Dir5 = 's' | 'se' | 'e' | 'ne' | 'n'
export const DIRS5: readonly Dir5[] = ['s', 'se', 'e', 'ne', 'n']
/** Per-direction art fallback: a missing direction borrows a neighbor before
 * giving up (docs/themes.md "Character art convention"). Each list starts with
 * the direction itself. */
export const DIR_FALLBACK: Record<Dir5, readonly Dir5[]> = {
  s: ['s'],
  se: ['se', 's'],
  e: ['e', 's'],
  ne: ['ne', 'e', 's'],
  n: ['n', 's'],
}

export const CHAR_NAMES = ['player', 'cop', 'thug', 'civilian', 'scientist', 'gangster', 'robot'] as const
export const ITEM_IDS = ['pistol', 'bat', 'knife', 'medkit', 'cash', 'shotgun', 'molotov', 'grenade-item'] as const
export const PROP_NAMES = ['barrel', 'atm', 'vending-machine', 'tv', 'toilet', 'locker', 'cabinet', 'desk'] as const
const UNIT_SINGLES = ['player', 'cop'] as const
const UNIT_WALKERS = ['thug', 'scientist', 'robot'] as const

/** Keys whose value is an animation-frame ARRAY (everything else is a single path). */
export const FX_KEYS: ReadonlySet<string> = new Set(['fx.flame', 'fx.hit', 'fx.explosion', 'fx.pickup', 'fx.blood'])

/** Tile names addressable from palette.tiles and tile.* sprite keys (mirrors the
 * Tile enum by name — the render layer maps them back to ids; the pure layer
 * stays game-free). */
export const TILE_NAMES = ['street', 'sidewalk', 'floor', 'wall', 'grass', 'exit'] as const

/** tile.* sprite keys accept a single path OR an array: the array's entries are
 * VARIANTS the tilemap alternates deterministically by tile coordinate, so big
 * surfaces read as texture instead of one repeated stamp. `tile.<name>.accent`
 * is an optional rare-detail pool (root clusters, grates, spore patches…)
 * sprinkled at low frequency on the same hash. `tile.<name>.overlay` is an
 * optional pool of RGBA decals the tilemap places by CONTEXT (wall bases,
 * door thresholds, plate seams — see tileSelect.planTileOverlays); decals are
 * authored with their mass biased toward the tile's TOP edge and rotated
 * toward whichever edge earned them. */
const isTileKey = (k: string): boolean => k.startsWith('tile.')

const buildSpriteKeys = (): Set<string> => {
  const keys = new Set<string>(['item.default', 'prop.default', 'projectile', 'grenade'])
  for (const t of TILE_NAMES) {
    keys.add(`tile.${t}`)
    keys.add(`tile.${t}.accent`)
    keys.add(`tile.${t}.overlay`)
  }
  for (const c of CHAR_NAMES) for (const d of DIRS5) for (const f of ['idle', 'step']) keys.add(`char.${c}.${d}-${f}`)
  // Animation-state frames (docs/themes.md "Animation states"):
  // char.<kind>.<dir>-<state>-<n>, n contiguous from 0.
  for (const c of CHAR_NAMES)
    for (const d of DIRS5)
      for (const s of ANIM_STATES)
        for (let n = 0; n < MAX_ANIM_FRAMES; n++) keys.add(`char.${c}.${d}-${s}-${n}`)
  for (const u of UNIT_SINGLES) keys.add(`unit.${u}`)
  for (const u of UNIT_WALKERS) for (const f of ['idle', 'step']) keys.add(`unit.${u}.${f}`)
  for (const i of ITEM_IDS) keys.add(`item.${i}`)
  for (const p of PROP_NAMES) keys.add(`prop.${p}`)
  for (const k of FX_KEYS) keys.add(k)
  return keys
}

/** Every sprite key the engine will ever look up. */
export const SPRITE_KEYS: ReadonlySet<string> = buildSpriteKeys()

// ---------------------------------------------------------------------------
// Manifest shape (post-validation: everything normalized + safe).

export interface ThemePalette {
  background?: number
  uiAccent?: number
  floorTint?: number
  tiles: Record<string, number>
  entities: Record<string, number>
}

export interface ThemeManifest {
  name: string
  version: number
  palette: ThemePalette
  names: Record<string, string>
  /** key → frame paths (single sprites normalized to a 1-element array), or
   * null = "force procedural art, do not fall back to the default theme". */
  sprites: Record<string, readonly string[] | null>
  /** Per-animation-state cadence override, in sim ticks per frame (1..30).
   * States a theme omits use the engine default (animState.DEFAULT_TPF). */
  anim: Partial<Record<AnimStateName, number>>
  /** Tile surfaces whose variant pool is sliced from N×N-tile macro images
   * (tile name → N, 2..4). The tilemap then picks variants by position within
   * the macro cell so adjacent slices land adjacently (plate seams and large
   * features span tiles); pools without an entry keep the pure-hash pick. */
  macroTiles: Record<string, number>
  /** Texture DENSITY multiplier (1..4, default 1). Sprites keep the same
   * logical/world footprint, but their source art is authored at this multiple
   * and baked at `resolution: artScale`, so a hi-res pack (artScale 2 → 96px
   * chars / 64px tiles) reads crisp — especially zoomed in — with no change to
   * layout, camera, or the sim. The sole knob that distinguishes the hi-res
   * theme from the base one. */
  artScale: number
}

/** A manifest bound to the folder it loaded from (dir is app-root-relative,
 * with trailing slash, e.g. "themes/city/"). */
export interface LoadedTheme {
  id: string
  dir: string
  manifest: ThemeManifest
}

/** Resolution order: active theme first, default (city) last. May be empty —
 * everything then falls back to built-in procedural art + built-in names. */
export type ThemeChain = readonly LoadedTheme[]

export const emptyManifest = (): ThemeManifest => ({
  name: '',
  version: 1,
  palette: { tiles: {}, entities: {} },
  names: {},
  sprites: {},
  anim: {},
  macroTiles: {},
  artScale: 1,
})

// ---------------------------------------------------------------------------
// Validation. Never throws: coerces what it can, drops what it can't, and
// reports every drop as a warning line — a broken manifest degrades, a typo'd
// key is visible in the console, and the game always boots.

/** Keys that would mutate Object prototypes if merged verbatim. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** #rrggbb → number. Anything else → undefined. */
export const parseColor = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) return undefined
  return parseInt(v.slice(1), 16)
}

/** A safe theme-relative (or app-root-relative, leading "/") asset path: no
 * URL schemes, no traversal, no backslashes. */
const isSafePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length <= 256 &&
  !p.includes(':') &&
  !p.includes('\\') &&
  !p.split('/').some((seg) => seg === '..')

export interface ValidatedManifest {
  manifest: ThemeManifest
  warnings: string[]
}

const validatePalette = (raw: unknown, warn: (w: string) => void): ThemePalette => {
  const out: ThemePalette = { tiles: {}, entities: {} }
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warn(`palette: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`)
    return out
  }
  for (const scalar of ['background', 'uiAccent', 'floorTint'] as const) {
    if (raw[scalar] === undefined) continue
    const c = parseColor(raw[scalar])
    if (c === undefined) warn(`palette.${scalar}: not a #rrggbb color: ${JSON.stringify(raw[scalar])}`)
    else out[scalar] = c
  }
  for (const group of ['tiles', 'entities'] as const) {
    const g = raw[group]
    if (g === undefined) continue
    if (!isRecord(g)) {
      warn(`palette.${group}: expected an object`)
      continue
    }
    for (const [k, v] of Object.entries(g)) {
      if (FORBIDDEN_KEYS.has(k)) {
        warn(`palette.${group}: forbidden key "${k}" dropped`)
        continue
      }
      if (group === 'tiles' && !(TILE_NAMES as readonly string[]).includes(k)) {
        warn(`palette.tiles: unknown tile "${k}" (known: ${TILE_NAMES.join(' ')})`)
        continue
      }
      const c = parseColor(v)
      if (c === undefined) warn(`palette.${group}.${k}: not a #rrggbb color: ${JSON.stringify(v)}`)
      else out[group][k] = c
    }
  }
  const known = new Set(['background', 'uiAccent', 'floorTint', 'tiles', 'entities'])
  for (const k of Object.keys(raw)) if (!known.has(k)) warn(`palette: unknown key "${k}" dropped`)
  return out
}

const validateNames = (raw: unknown, warn: (w: string) => void): Record<string, string> => {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warn('names: expected an object of archetype → display name')
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(k)) warn(`names: forbidden key "${k}" dropped`)
    else if (typeof v !== 'string' || v.trim() === '' || v.length > 64)
      warn(`names.${k}: expected a short non-empty string`)
    else out[k] = v
  }
  return out
}

const validateSprites = (raw: unknown, warn: (w: string) => void): ThemeManifest['sprites'] => {
  const out: ThemeManifest['sprites'] = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warn('sprites: expected an object of sprite key → path')
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!SPRITE_KEYS.has(k)) {
      warn(`sprites: unknown key "${k}" dropped (see docs/themes.md for the canonical list)`)
      continue
    }
    if (v === null) {
      out[k] = null // explicit "use procedural art" opt-out
      continue
    }
    const paths = Array.isArray(v) ? v : [v]
    if (!FX_KEYS.has(k) && !isTileKey(k) && Array.isArray(v)) {
      warn(`sprites.${k}: arrays are only valid for fx.* (frames) and tile.* (variants) keys`)
      continue
    }
    const bad = paths.find((p) => !isSafePath(p))
    if (bad !== undefined || paths.length === 0) {
      warn(`sprites.${k}: invalid path ${JSON.stringify(bad ?? v)} (relative, no "..", no scheme)`)
      continue
    }
    out[k] = paths as string[]
  }
  return out
}

const validateMacroTiles = (raw: unknown, warn: (w: string) => void): ThemeManifest['macroTiles'] => {
  const out: ThemeManifest['macroTiles'] = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warn('macroTiles: expected an object of tile name → macro side (2..4)')
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!(TILE_NAMES as readonly string[]).includes(k)) {
      warn(`macroTiles: unknown tile "${k}" dropped (known: ${TILE_NAMES.join(' ')})`)
      continue
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 2 || v > 4) {
      warn(`macroTiles.${k}: expected an integer macro side in 2..4, got ${JSON.stringify(v)}`)
      continue
    }
    out[k] = v
  }
  return out
}

const validateAnim = (raw: unknown, warn: (w: string) => void): ThemeManifest['anim'] => {
  const out: ThemeManifest['anim'] = {}
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    warn('anim: expected an object of state → ticks-per-frame')
    return out
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!(ANIM_STATES as readonly string[]).includes(k)) {
      warn(`anim: unknown state "${k}" dropped (known: ${ANIM_STATES.join(' ')})`)
      continue
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 30) {
      warn(`anim.${k}: expected an integer ticks-per-frame in 1..30, got ${JSON.stringify(v)}`)
      continue
    }
    out[k as AnimStateName] = v
  }
  return out
}

/** Coerce arbitrary JSON into a safe, normalized manifest. Collects a warning
 * per dropped/defaulted field; never throws. */
export const validateManifest = (raw: unknown): ValidatedManifest => {
  const warnings: string[] = []
  const warn = (w: string): void => void warnings.push(w)
  const manifest = emptyManifest()
  if (!isRecord(raw)) {
    warn(`manifest: expected a JSON object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`)
    return { manifest, warnings }
  }
  if (raw.name !== undefined) {
    if (typeof raw.name === 'string' && raw.name.length <= 64) manifest.name = raw.name
    else warn('name: expected a short string')
  }
  if (raw.version !== undefined) {
    if (raw.version === 1) manifest.version = 1
    else warn(`version: unsupported (${JSON.stringify(raw.version)}); treating as 1`)
  }
  manifest.palette = validatePalette(raw.palette, warn)
  manifest.names = validateNames(raw.names, warn)
  manifest.sprites = validateSprites(raw.sprites, warn)
  manifest.anim = validateAnim(raw.anim, warn)
  manifest.macroTiles = validateMacroTiles(raw.macroTiles, warn)
  if (raw.artScale !== undefined) {
    if (typeof raw.artScale === 'number' && Number.isInteger(raw.artScale) && raw.artScale >= 1 && raw.artScale <= 4)
      manifest.artScale = raw.artScale
    else warn(`artScale: expected an integer 1..4, got ${JSON.stringify(raw.artScale)}; using 1`)
  }
  const known = new Set(['id', 'name', 'version', 'palette', 'names', 'sprites', 'anim', 'macroTiles', 'artScale'])
  for (const k of Object.keys(raw)) if (!known.has(k)) warn(`manifest: unknown key "${k}" dropped`)
  return { manifest, warnings }
}

// ---------------------------------------------------------------------------
// Resolution: walk the theme chain (active → default). First manifest that
// MENTIONS a key wins; null stops the walk (procedural); a chain miss means
// procedural. File-load failures degrade later, in the loader.

/** App-root-relative URLs (no leading slash) for a sprite key's frames, or
 * undefined = use built-in procedural art. */
export const resolveSpritePaths = (key: string, chain: ThemeChain): string[] | undefined => {
  for (const theme of chain) {
    const v = theme.manifest.sprites[key]
    if (v === undefined) continue
    if (v === null) return undefined
    return v.map((p) => (p.startsWith('/') ? p.slice(1) : theme.dir + p))
  }
  return undefined
}

/** Title-case an archetype key like `door.open` → `Door Open` — the last-resort
 * display name when no theme in the chain names the archetype. */
export const prettyArchetype = (s: string): string =>
  s
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')

/** Themed display name for an archetype: active theme → default theme → pretty. */
export const themedName = (archetype: string, chain: ThemeChain): string => {
  for (const theme of chain) {
    const n = theme.manifest.names[archetype]
    if (n !== undefined) return n
  }
  return prettyArchetype(archetype)
}

/** Ticks-per-frame for an animation state: first theme in the chain that sets
 * it wins; otherwise the engine default (animState.DEFAULT_TPF). */
export const resolveAnimTpf = (state: AnimStateName, chain: ThemeChain): number => {
  for (const theme of chain) {
    const v = theme.manifest.anim[state]
    if (v !== undefined) return v
  }
  return DEFAULT_TPF[state]
}

/** The full per-state cadence table for a chain (fed to the ArtRegistry). */
export const resolveAnimTpfs = (chain: ThemeChain): Record<AnimStateName, number> => {
  const out = { ...DEFAULT_TPF }
  for (const s of ANIM_STATES) out[s] = resolveAnimTpf(s, chain)
  return out
}

/** Macro-slicing declarations for tile pools: per tile name, the first theme
 * in the chain that declares it wins. In practice the declaring theme is the
 * one whose `tile.<name>` pool is sliced from macro images — the two travel
 * together in one manifest. */
export const resolveMacroTiles = (chain: ThemeChain): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const theme of [...chain].reverse()) Object.assign(out, theme.manifest.macroTiles)
  return out
}

/** Merge the chain's palettes: per field/key, the first theme that sets it wins. */
export const resolvePalette = (chain: ThemeChain): ThemePalette => {
  const out: ThemePalette = { tiles: {}, entities: {} }
  for (const theme of [...chain].reverse()) {
    const p = theme.manifest.palette
    if (p.background !== undefined) out.background = p.background
    if (p.uiAccent !== undefined) out.uiAccent = p.uiAccent
    if (p.floorTint !== undefined) out.floorTint = p.floorTint
    Object.assign(out.tiles, p.tiles)
    Object.assign(out.entities, p.entities)
  }
  return out
}
