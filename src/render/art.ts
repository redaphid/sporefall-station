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

  const entity = (archetype: string): Texture => {
    let tex = entityCache.get(archetype)
    if (!tex) {
      const color = ENTITY_COLORS[archetype] ?? ENTITY_COLORS.default
      const r = TILE_PX * 0.35
      const g = new Graphics()
        .circle(r, r, r)
        .fill(color)
        .circle(r, r, r)
        .stroke({ width: 2, color: 0x000000, alpha: 0.35 })
        // Facing notch pointing +x; sprite rotation orients it.
        .poly([r * 1.6, r * 0.7, r * 2.0, r, r * 1.6, r * 1.3])
        .fill(0xffffff)
      tex = renderer.generateTexture(g)
      g.destroy()
      entityCache.set(archetype, tex)
    }
    return tex
  }

  return { tile, entity }
}
