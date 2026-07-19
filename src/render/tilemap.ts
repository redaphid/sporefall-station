import { Container, Sprite } from 'pixi.js'
import { isWallTile, Tile, WALL_CUT_OUTSIDE, type Level } from '../game/levelgen/level'
import { TILE_PX, type ArtRegistry } from './art'

const CHUNK = 8 // tiles per chunk side

interface Chunk {
  container: Container
  /** Pixel bounds in world space. */
  x: number
  y: number
  size: number
}

/**
 * Static tile layer split into 8x8-tile chunks, each culled against the
 * camera view every frame. Baked once per level.
 */
export class TilemapView {
  readonly root = new Container()
  private chunks: Chunk[] = []

  build(level: Level, art: ArtRegistry): void {
    this.root.removeChildren().forEach((c) => c.destroy({ children: true }))
    this.chunks = []
    const chunksX = Math.ceil(level.w / CHUNK)
    const chunksY = Math.ceil(level.h / CHUNK)
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const container = new Container()
        container.position.set(cx * CHUNK * TILE_PX, cy * CHUNK * TILE_PX)
        for (let ty = cy * CHUNK; ty < Math.min((cy + 1) * CHUNK, level.h); ty++) {
          for (let tx = cx * CHUNK; tx < Math.min((cx + 1) * CHUNK, level.w); tx++) {
            // Deterministic per-position variant for texture variety
            const variant = (tx * 7 + ty * 13) % 3
            const tileId = level.tiles[ty * level.w + tx]
            const px = (tx - cx * CHUNK) * TILE_PX
            const py = (ty - cy * CHUNK) * TILE_PX
            // Bevelled wall corner: its texture has a transparent cut triangle,
            // so first lay down the ground tile the bevel exposes (the diagonal
            // outside neighbour's art — falls back to sidewalk).
            const cut = WALL_CUT_OUTSIDE[tileId]
            if (cut) {
              const bx = tx + cut.dx
              const by = ty + cut.dy
              const inBounds = bx >= 0 && by >= 0 && bx < level.w && by < level.h
              const neighbor = inBounds ? level.tiles[by * level.w + bx] : Tile.Sidewalk
              const ground = isWallTile(neighbor) ? Tile.Sidewalk : neighbor
              const back = new Sprite(art.tile(ground, variant))
              back.position.set(px, py)
              container.addChild(back)
            }
            const sprite = new Sprite(art.tile(tileId, variant))
            sprite.position.set(px, py)
            container.addChild(sprite)
          }
        }
        this.root.addChild(container)
        this.chunks.push({ container, x: cx * CHUNK * TILE_PX, y: cy * CHUNK * TILE_PX, size: CHUNK * TILE_PX })
      }
    }
  }

  /** Show only chunks overlapping the view rect (world pixels). */
  cull(viewX: number, viewY: number, viewW: number, viewH: number): void {
    for (const chunk of this.chunks) {
      chunk.container.visible =
        chunk.x < viewX + viewW && chunk.x + chunk.size > viewX && chunk.y < viewY + viewH && chunk.y + chunk.size > viewY
    }
  }
}
