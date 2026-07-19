import { Graphics, Texture, type Renderer } from 'pixi.js'
import { Tile } from '../game/levelgen/level'
import { MODS } from '../game/data/mods'
import type { Dir } from './anim'

export const TILE_PX = 32

/** Character sprite canvas: 48×48 on the 32px tiles. Feet-anchored, so a
 * character stands 1.5 tiles tall and overlaps the tile behind/above it. */
export const CHAR_PX = 48

/**
 * Maps logical art keys to textures. v1 is procedural colored shapes;
 * swapping this file for a real tileset/spritesheet is the upgrade path.
 */
export const TILE_VARIANTS = 3

export interface ArtRegistry {
  /** variant in [0, TILE_VARIANTS) — picked per position for texture variety. */
  tile(tileId: number, variant?: number): Texture
  entity(archetype: string): Texture
  /** White silhouette of the entity texture, swapped in during hit flash. For a
   * character pass its current drawn facing so the flash keeps the pose. */
  entityFlash(archetype: string, dir?: Facing): Texture
  /** True when this archetype draws as a billboarded character sprite (which
   * should flip left/right, not rotate like the top-down procedural blobs). */
  isCharacterSprite(archetype: string): boolean
  /** Directional sprite set (s/se/e/ne/n × idle/step) for an archetype. File art
   * wins when loaded; every character archetype always gets at least the
   * procedural fallback set, so nothing breaks when a theme lacks files. */
  characterSet(archetype: string): DirSet | undefined
  /** The walking (step) pose for an archetype, if a step frame exists. */
  walkStep(archetype: string): Texture | undefined
  /** Fire flicker frames (empty → caller falls back to the procedural flame). */
  flameFrames(): readonly Texture[]
  /** A one-shot effect clip's frames, by effect key. Empty if not loaded. */
  effectFrames(key: EffectKey): readonly Texture[]
}

export type EffectKey = 'hit' | 'explosion' | 'pickup' | 'blood'

/** A billboarded character's DRAWN facings: s, se, e, ne, n. The west half
 * (w/sw/nw) is the east art flipped in the renderer, so five sprites cover all
 * eight compass headings. */
export type Facing = Dir
export const FACINGS: readonly Facing[] = ['s', 'se', 'e', 'ne', 'n']
export interface DirPose {
  idle?: Texture
  step?: Texture
}
export type DirSet = Record<Facing, DirPose>

/** Per-facing fallback chain when a drawn direction is missing from a file set
 * (e.g. a legacy 3-direction theme): diagonals fall back to their nearest
 * cardinal, everything ultimately falls back to south (toward camera). */
export const FACING_FALLBACK: Record<Facing, readonly Facing[]> = {
  s: ['s'],
  se: ['se', 'e', 's'],
  e: ['e', 's'],
  ne: ['ne', 'n', 'e', 's'],
  n: ['n', 's'],
}

export interface SpriteTextures {
  floor?: Texture
  wall?: Texture
  player?: Texture
  cop?: Texture
  item?: Texture
  prop?: Texture
  /** New character idle textures, keyed by archetype. */
  thug?: Texture
  scientist?: Texture
  robot?: Texture
  /** Walk (step) frames, keyed by archetype. */
  thugStep?: Texture
  scientistStep?: Texture
  robotStep?: Texture
  /** Directional character sets, keyed by archetype. */
  chars?: Record<string, DirSet>
  /** Per-item pickup sprites, keyed by item id (bat/knife/medkit/…). */
  items?: Record<string, Texture>
  /** World prop sprites, keyed by archetype (barrel/atm/…). */
  props?: Record<string, Texture>
  /** Fire flicker frames, cycled by the animator. */
  flames?: Texture[]
  /** One-shot effect clips. */
  hit?: Texture[]
  explosion?: Texture[]
  pickup?: Texture[]
  blood?: Texture[]
}

// Archetypes that borrow another archetype's directional set (bouncers use the
// cop body; the boss uses the thug; shopkeepers use the civilian).
const CHARSET_ALIAS: Record<string, string> = {
  player: 'player',
  cop: 'cop',
  gangster: 'gangster',
  bouncer: 'cop',
  thug: 'thug',
  boss: 'thug',
  civilian: 'civilian',
  scientist: 'scientist',
  robot: 'robot',
  shopkeeper: 'civilian',
}

// World props with a bespoke sprite (beyond the wooden crate).
const PROP_SPRITE: Record<string, string> = {
  barrel: 'barrel',
  atm: 'atm',
  vending: 'vending-machine',
  tv: 'tv',
  toilet: 'toilet',
}

// Consumables/weapons that reuse another item's sprite.
const ITEM_ALIAS: Record<string, string> = { bandage: 'medkit' }

// Archetypes with a dedicated character sprite; the rest reuse the cop body.
const SPRITE_ARCHETYPES: Record<string, keyof SpriteTextures> = {
  player: 'player',
  thug: 'thug',
  scientist: 'scientist',
  robot: 'robot',
  cop: 'cop',
  gangster: 'cop',
  bouncer: 'cop',
}
const STEP_ARCHETYPES: Record<string, keyof SpriteTextures> = {
  thug: 'thugStep',
  scientist: 'scientistStep',
  robot: 'robotStep',
}

export interface SpriteTextures {
  floor?: Texture
  wall?: Texture
  player?: Texture
  cop?: Texture
  item?: Texture
  prop?: Texture
}

const TILE_COLORS: Record<number, number> = {
  [Tile.Street]: 0x33333c,
  [Tile.Sidewalk]: 0x4c4c56,
  [Tile.Floor]: 0x63523f,
  [Tile.Wall]: 0x1b1b24,
  [Tile.Grass]: 0x2e5d3a,
  [Tile.Exit]: 0xd4af37,
}

const ENTITY_COLORS: Record<string, number> = {
  player: 0x7fd17f,
  thug: 0xd17f7f,
  boss: 0xe0483f,
  gangster: 0xc95fa0,
  bouncer: 0x8f7a5a,
  cop: 0x7f9fd1,
  civilian: 0xd1c47f,
  shopkeeper: 0xb87fd1,
  scientist: 0xd9e4e8,
  robot: 0x8fa1b3,
  crate: 0x9c6b3f,
  default: 0xcccccc,
}

/** Scale a 0xRRGGBB colour by `f` (each channel clamped to 255). */
const shade = (color: number, f: number): number => {
  const ch = (c: number): number => Math.max(0, Math.min(255, Math.round(c * f)))
  return (ch((color >> 16) & 0xff) << 16) | (ch((color >> 8) & 0xff) << 8) | ch(color & 0xff)
}

export const createArt = (renderer: Renderer, sprites: SpriteTextures = {}): ArtRegistry => {
  const tileCache = new Map<number, Texture>()
  const entityCache = new Map<string, Texture>()

  // Deterministic pseudo-noise for texture detail (not the sim's rng)
  const hash2 = (a: number, b: number): number => {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f)
    h = Math.imul(h ^ (h >>> 15), 0x2545f491)
    return ((h >>> 16) & 0xffff) / 0xffff
  }

  const drawTile = (tileId: number, variant: number): Texture => {
    const color = TILE_COLORS[tileId] ?? 0xff00ff
    const g = new Graphics().rect(0, 0, TILE_PX, TILE_PX).fill(color)
    const T = TILE_PX
    switch (tileId) {
      case Tile.Wall: {
        // Brick courses
        for (let row = 0; row < 4; row++) {
          const y = row * (T / 4)
          g.rect(0, y, T, 1).fill({ color: 0x000000, alpha: 0.35 })
          const offset = row % 2 === 0 ? T / 3 : T * 0.66
          g.rect(offset, y, 1, T / 4).fill({ color: 0x000000, alpha: 0.3 })
        }
        g.rect(0, 0, T, 3).fill(0x2a2a36)
        break
      }
      case Tile.Floor: {
        // Wood planks
        for (let row = 0; row < 4; row++) {
          g.rect(0, row * (T / 4), T, 1).fill({ color: 0x000000, alpha: 0.18 })
        }
        for (let i = 0; i < 3; i++) {
          const x = hash2(variant * 31 + i, 7) * T
          const y = (Math.floor(hash2(i, variant) * 4) + 0.5) * (T / 4)
          g.rect(x, y - 1, 3, 1).fill({ color: 0x000000, alpha: 0.25 })
        }
        break
      }
      case Tile.Street: {
        // Asphalt speckle (cracks tile too visibly with only 3 variants)
        for (let i = 0; i < 8; i++) {
          const x = hash2(i, variant * 17) * T
          const y = hash2(variant * 13, i) * T
          g.rect(x, y, 1.5, 1.5).fill({ color: 0xffffff, alpha: 0.05 })
        }
        break
      }
      case Tile.Sidewalk: {
        g.rect(0, 0, T, 1).fill({ color: 0xffffff, alpha: 0.08 })
        g.rect(0, 0, 1, T).fill({ color: 0xffffff, alpha: 0.06 })
        break
      }
      case Tile.Grass: {
        for (let i = 0; i < 10; i++) {
          const x = hash2(i * 3, variant * 11) * T
          const y = hash2(variant * 5, i * 7) * T
          g.rect(x, y, 2, 2).fill({ color: 0x1e4227, alpha: 0.7 })
        }
        break
      }
      case Tile.Exit: {
        // Gold pad with a chevron pointing onward
        g.rect(3, 3, T - 6, T - 6).stroke({ width: 2, color: 0x8a6d1f })
        g.poly([T * 0.3, T * 0.3, T * 0.7, T * 0.5, T * 0.3, T * 0.7]).fill(0x8a6d1f)
        break
      }
    }
    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  const tile = (tileId: number, variant = 0): Texture => {
    if (tileId === Tile.Floor && sprites.floor) return sprites.floor
    if (tileId === Tile.Wall && sprites.wall) return sprites.wall
    const key = tileId * TILE_VARIANTS + (variant % TILE_VARIANTS)
    let tex = tileCache.get(key)
    if (!tex) {
      tex = drawTile(tileId, variant % TILE_VARIANTS)
      tileCache.set(key, tex)
    }
    return tex
  }

  const drawEntity = (archetype: string, colorOverride?: number): Texture => {
    if (archetype === 'door') {
      const g = new Graphics()
        .rect(0, 0, TILE_PX, TILE_PX)
        .fill(colorOverride ?? 0x8a6a3f)
        .rect(2, 2, TILE_PX - 4, TILE_PX - 4)
        .stroke({ width: 2, color: 0x000000, alpha: 0.45 })
        .circle(TILE_PX * 0.78, TILE_PX * 0.5, 2)
        .fill(0x222222)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'door.open') {
      // Open door: slim panel against the jamb
      const g = new Graphics().rect(0, 0, 6, TILE_PX).fill(colorOverride ?? 0x8a6a3f)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'fire') {
      // A stacked flame: deep orange body, yellow core, white-hot heart.
      const c = TILE_PX / 2
      const g = new Graphics()
        .circle(c, c + 3, TILE_PX * 0.44)
        .fill(colorOverride ?? 0xff4a12)
        .circle(c, c + 4, TILE_PX * 0.3)
        .fill(colorOverride ?? 0xff9a1e)
        .circle(c, c + 5, TILE_PX * 0.16)
        .fill(colorOverride ?? 0xffe45a)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype === 'projectile' || archetype === 'grenade') {
      const color = archetype === 'grenade' ? 0x3a4a3a : 0xffe066
      const size = archetype === 'grenade' ? 6 : 4
      const g = new Graphics().circle(size, size, size).fill(colorOverride ?? color)
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    if (archetype.startsWith('pickup.')) {
      const s = TILE_PX * 0.45
      const g = new Graphics()
        .roundRect(0, 0, s, s, 3)
        .fill(colorOverride ?? 0xd4af37)
        .roundRect(0, 0, s, s, 3)
        .stroke({ width: 2, color: 0x000000, alpha: 0.4 })
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    // A weapon-mod pickup: a rarity-coloured diamond gem (common grey · rare blue ·
    // legendary gold) so a kid can spot "a mod, and how special" from across a room.
    if (archetype.startsWith('mod.')) {
      const rarity = MODS[archetype.slice('mod.'.length)]?.rarity
      const gem = rarity === 'legendary' ? 0xffb020 : rarity === 'rare' ? 0x4aa3ff : 0xff5bd0
      const r = TILE_PX * 0.28
      const g = new Graphics()
        .poly([r, 0, r * 2, r, r, r * 2, 0, r])
        .fill(colorOverride ?? gem)
        .poly([r, 0, r * 2, r, r, r * 2, 0, r])
        .stroke({ width: 2, color: 0x101018, alpha: 0.6 })
        .poly([r, r * 0.35, r * 1.55, r, r, r * 1.65, r * 0.45, r])
        .stroke({ width: 1.5, color: 0xffffff, alpha: 0.35 })
      const tex = renderer.generateTexture(g)
      g.destroy()
      return tex
    }
    const color = colorOverride ?? ENTITY_COLORS[archetype] ?? ENTITY_COLORS.default
    const r = TILE_PX * 0.35
    const g = new Graphics()
      // body with a darker rim
      .circle(r, r, r)
      .fill(color)
      .circle(r, r, r)
      .stroke({ width: 2, color: 0x000000, alpha: 0.4 })
      // shoulder shading
      .circle(r, r, r * 0.72)
      .stroke({ width: 1.5, color: 0xffffff, alpha: 0.12 })
      // eyes looking +x; sprite rotation orients them
      .circle(r * 1.45, r * 0.72, r * 0.14)
      .fill(colorOverride ?? 0x101018)
      .circle(r * 1.45, r * 1.28, r * 0.14)
      .fill(colorOverride ?? 0x101018)
      // held-item nub at the hand
      .circle(r * 1.55, r * 1.5, r * 0.18)
      .fill(colorOverride ?? 0x3a3a44)
    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  /** Procedural billboarded character on the CHAR_PX (48×48) canvas: a chunky
   * figure with per-direction head/eye/hand placement so all five drawn facings
   * read at a glance. Feet sit on the canvas bottom (the sprite is anchored
   * bottom-centre). This is the guaranteed fallback art when a theme ships no
   * character files — every direction exists for every character archetype. */
  const drawCharacter = (
    archetype: string,
    dir: Facing,
    frame: 'idle' | 'step',
    colorOverride?: number,
  ): Texture => {
    const color = colorOverride ?? ENTITY_COLORS[archetype] ?? ENTITY_COLORS[CHARSET_ALIAS[archetype]] ?? ENTITY_COLORS.default
    const dark = colorOverride ?? shade(color, 0.55)
    const light = colorOverride ?? shade(color, 1.25)
    const outline = colorOverride ?? 0x101018
    const cx = CHAR_PX / 2
    const lift = frame === 'step' ? 1 : 0 // step pose bobs the body, feet stay planted
    // Per-direction lean: diagonals shift head/torso toward the heading so
    // se/ne read as 3/4 views; e is a full profile.
    const headDx = { s: 0, se: 2.5, e: 3.5, ne: 2.5, n: 0 }[dir]
    const bodyDx = { s: 0, se: 1, e: 2, ne: 1, n: 0 }[dir]
    const profile = dir === 'e'

    // Transparent full-canvas rect pins generateTexture's bounds to the whole
    // 48×48 canvas, so the feet anchor (bottom-centre) is exact.
    const g = new Graphics().rect(0, 0, CHAR_PX, CHAR_PX).fill({ color: 0, alpha: 0 })

    // Legs: idle stands square; step strides — trailing leg lifted, leading planted.
    const legW = 5
    const legH = 10
    const legY = 47 - legH
    if (frame === 'idle') {
      g.rect(cx - 7 + bodyDx, legY, legW, legH).fill(dark)
      g.rect(cx + 2 + bodyDx, legY, legW, legH).fill(dark)
    } else {
      g.rect(cx - 9 + bodyDx, legY + 2, legW, legH - 2).fill(dark)
      g.rect(cx + 4 + bodyDx, legY, legW, legH).fill(dark)
    }

    // Torso: narrower in profile so east reads slimmer than south.
    const torsoW = profile ? 14 : 18
    g.roundRect(cx - torsoW / 2 + bodyDx, 20 - lift, torsoW, 19, 6)
      .fill(color)
      .roundRect(cx - torsoW / 2 + bodyDx, 20 - lift, torsoW, 19, 6)
      .stroke({ width: 2, color: outline, alpha: 0.5 })

    // Arms: both visible facing camera-ish; one leading arm in profile.
    if (dir === 's' || dir === 'se') {
      g.rect(cx - torsoW / 2 - 3 + bodyDx, 22 - lift, 3, 10).fill(shade(colorOverride ?? color, colorOverride ? 1 : 0.8))
      g.rect(cx + torsoW / 2 + bodyDx, 22 - lift, 3, 10).fill(shade(colorOverride ?? color, colorOverride ? 1 : 0.8))
    } else if (profile) {
      g.rect(cx + 2 + bodyDx, 23 - lift, 4, 10).fill(shade(colorOverride ?? color, colorOverride ? 1 : 0.8))
    }

    // Head, lightened so it pops against the torso.
    g.circle(cx + headDx, 13 - lift, 8.5)
      .fill(light)
      .circle(cx + headDx, 13 - lift, 8.5)
      .stroke({ width: 2, color: outline, alpha: 0.5 })
    // Back-of-head cap for away-facing poses (n/ne) — no face visible.
    if (dir === 'n' || dir === 'ne') {
      g.circle(cx + headDx, 11.5 - lift, 6.8).fill(shade(colorOverride ?? color, colorOverride ? 1 : 0.7))
    }

    // Eyes: two facing camera, two shifted on the se diagonal, one in profile.
    const eye = colorOverride ?? 0x101018
    if (dir === 's') {
      g.circle(cx - 3.5, 12 - lift, 1.7).fill(eye)
      g.circle(cx + 3.5, 12 - lift, 1.7).fill(eye)
    } else if (dir === 'se') {
      g.circle(cx + headDx - 1, 12.5 - lift, 1.7).fill(eye)
      g.circle(cx + headDx + 4.5, 12.5 - lift, 1.7).fill(eye)
    } else if (profile) {
      g.circle(cx + headDx + 4.5, 12 - lift, 1.7).fill(eye)
    }

    // Held-item nub at the leading hand (hidden when facing away).
    if (dir === 's' || dir === 'se' || profile) {
      g.circle(cx + torsoW / 2 + bodyDx + 2, 30 - lift, 2.5).fill(colorOverride ?? 0x3a3a44)
    }

    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  // Procedural directional sets, cached per ARCHETYPE (not alias) so aliased
  // bodies keep their own colour (boss red, bouncer tan, …).
  const procCharCache = new Map<string, DirSet>()
  const procCharSet = (archetype: string): DirSet => {
    let set = procCharCache.get(archetype)
    if (!set) {
      set = FACINGS.reduce(
        (acc, d) => ({
          ...acc,
          [d]: { idle: drawCharacter(archetype, d, 'idle'), step: drawCharacter(archetype, d, 'step') },
        }),
        {} as DirSet,
      )
      procCharCache.set(archetype, set)
    }
    return set
  }

  const spriteForArchetype = (archetype: string): Texture | undefined => {
    const key = SPRITE_ARCHETYPES[archetype]
    if (key) return sprites[key] as Texture | undefined
    if (archetype.startsWith('pickup.')) {
      const id = archetype.slice('pickup.'.length)
      return sprites.items?.[id] ?? sprites.items?.[ITEM_ALIAS[id]] ?? sprites.item
    }
    const propKey = PROP_SPRITE[archetype]
    if (propKey) return sprites.props?.[propKey]
    if (archetype === 'crate' || archetype.startsWith('prop')) return sprites.prop
    return undefined
  }

  const characterSet = (archetype: string): DirSet | undefined => {
    const alias = CHARSET_ALIAS[archetype]
    if (!alias) return undefined
    // File art wins; the procedural set guarantees every direction exists even
    // when a theme ships no character files at all.
    return sprites.chars?.[alias] ?? procCharSet(archetype)
  }

  const isCharacterSprite = (archetype: string): boolean => archetype in CHARSET_ALIAS

  const walkStep = (archetype: string): Texture | undefined => {
    const key = STEP_ARCHETYPES[archetype]
    return key ? (sprites[key] as Texture | undefined) : undefined
  }

  const flameFrames = (): readonly Texture[] => sprites.flames ?? []

  const effectFrames = (key: EffectKey): readonly Texture[] => sprites[key] ?? []

  const entity = (archetype: string): Texture => {
    const real = spriteForArchetype(archetype)
    if (real) return real
    let tex = entityCache.get(archetype)
    if (!tex) {
      tex = drawEntity(archetype)
      entityCache.set(archetype, tex)
    }
    return tex
  }

  const flashCache = new Map<string, Texture>()
  const entityFlash = (archetype: string, dir?: Facing): Texture => {
    // Characters flash as a white silhouette of their current facing so the
    // pose (and the 48px feet-anchored canvas) never jumps during the flash.
    const character = archetype in CHARSET_ALIAS
    const key = character ? `${archetype}|${dir ?? 's'}` : archetype
    let tex = flashCache.get(key)
    if (!tex) {
      tex = character ? drawCharacter(archetype, dir ?? 's', 'idle', 0xffffff) : drawEntity(archetype, 0xffffff)
      flashCache.set(key, tex)
    }
    return tex
  }

  return {
    tile,
    entity,
    entityFlash,
    isCharacterSprite,
    characterSet,
    walkStep,
    flameFrames,
    effectFrames,
  }
}
