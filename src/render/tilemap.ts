import { Container, Sprite } from 'pixi.js'
import type { Level } from '../game/levelgen/level'
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
            const sprite = new Sprite(art.tile(level.tiles[ty * level.w + tx]))
            sprite.position.set((tx - cx * CHUNK) * TILE_PX, (ty - cy * CHUNK) * TILE_PX)
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
