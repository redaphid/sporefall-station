import { Graphics, Texture, type Renderer } from 'pixi.js'
import { Tile } from '../game/levelgen/level'

export const TILE_PX = 32

/**
 * Maps logical art keys to textures. v1 is procedural colored shapes;
 * swapping this file for a real tileset/spritesheet is the upgrade path.
 */
export const TILE_VARIANTS = 3

export interface ArtRegistry {
  /** variant in [0, TILE_VARIANTS) — picked per position for texture variety. */
  tile(tileId: number, variant?: number): Texture
  entity(archetype: string): Texture
  /** White silhouette of the entity texture, swapped in during hit flash. */
  entityFlash(archetype: string): Texture
  /** True when this archetype draws as a billboarded character sprite (which
   * should flip left/right, not rotate like the top-down procedural blobs). */
  isCharacterSprite(archetype: string): boolean
  /** Directional sprite set (front/side/back × idle/step) for an archetype, if
   * one is loaded — lets the renderer swap by heading instead of rotating. */
  characterSet(archetype: string): DirSet | undefined
  /** The walking (step) pose for an archetype, if a step frame exists. */
  walkStep(archetype: string): Texture | undefined
  /** Fire flicker frames (empty → caller falls back to the procedural flame). */
  flameFrames(): readonly Texture[]
  /** A one-shot effect clip's frames, by effect key. Empty if not loaded. */
  effectFrames(key: EffectKey): readonly Texture[]
}

export type EffectKey = 'hit' | 'explosion' | 'pickup' | 'blood'

/** A billboarded character's facings. Left is the side sprite flipped in the
 * renderer, so only three sprites (front/side/back) are generated per pose. */
export type Facing = 'front' | 'side' | 'back'
export interface DirPose {
  idle?: Texture
  step?: Texture
}
export type DirSet = Record<Facing, DirPose>

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

const COP_ARCHETYPES = new Set(['cop', 'thug', 'gangster', 'bouncer'])

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
  crate: 0x9c6b3f,
  default: 0xcccccc,
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
    return alias ? sprites.chars?.[alias] : undefined
  }

  const isCharacterSprite = (archetype: string): boolean =>
    characterSet(archetype) !== undefined ||
    (spriteForArchetype(archetype) !== undefined && archetype in SPRITE_ARCHETYPES)

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
  const entityFlash = (archetype: string): Texture => {
    let tex = flashCache.get(archetype)
    if (!tex) {
      tex = drawEntity(archetype, 0xffffff)
      flashCache.set(archetype, tex)
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
