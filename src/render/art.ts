import { Graphics, Texture, type Renderer } from 'pixi.js'
import { Tile } from '../game/levelgen/level'

export const TILE_PX = 32

/**
 * Maps logical art keys to textures. v1 is procedural colored shapes;
 * swapping this file for a real tileset/spritesheet is the upgrade path.
 */
export interface ArtRegistry {
  tile(tileId: number): Texture
  entity(archetype: string): Texture
  /** White silhouette of the entity texture, swapped in during hit flash. */
  entityFlash(archetype: string): Texture
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
  cop: 0x7f9fd1,
  civilian: 0xd1c47f,
  shopkeeper: 0xb87fd1,
  default: 0xcccccc,
}

export const createArt = (renderer: Renderer): ArtRegistry => {
  const tileCache = new Map<number, Texture>()
  const entityCache = new Map<string, Texture>()

  const tile = (tileId: number): Texture => {
    let tex = tileCache.get(tileId)
    if (!tex) {
      const color = TILE_COLORS[tileId] ?? 0xff00ff
      const g = new Graphics().rect(0, 0, TILE_PX, TILE_PX).fill(color)
      // Subtle edge shading so tiles read as a grid without real art
      if (tileId === Tile.Wall) {
        g.rect(0, 0, TILE_PX, 3).fill(0x2a2a36)
      } else {
        g.rect(0, 0, TILE_PX, 1).fill({ color: 0xffffff, alpha: 0.04 })
      }
      tex = renderer.generateTexture(g)
      g.destroy()
      tileCache.set(tileId, tex)
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
      .circle(r, r, r)
      .fill(color)
      .circle(r, r, r)
      .stroke({ width: 2, color: 0x000000, alpha: 0.35 })
      // Facing notch pointing +x; sprite rotation orients it.
      .poly([r * 1.6, r * 0.7, r * 2.0, r, r * 1.6, r * 1.3])
      .fill(colorOverride ?? 0xffffff)
    const tex = renderer.generateTexture(g)
    g.destroy()
    return tex
  }

  const entity = (archetype: string): Texture => {
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

  return { tile, entity, entityFlash }
}
