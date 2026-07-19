import { Container, Sprite } from 'pixi.js'
import { isWallTile, Tile, WALL_CUT_OUTSIDE, type Level } from '../game/levelgen/level'
import { TILE_PX, type ArtRegistry, type OverlaySide } from './art'

const CHUNK = 8 // tiles per chunk side

interface Chunk {
  container: Container
  /** Pixel bounds in world space. */
  x: number
  y: number
  size: number
}

/** Deterministic 32-bit coordinate hash — variant/accent selection must be a
 * pure function of (tx,ty) so every device (and every replay) bakes the exact
 * same ground. NOT the sim rng: this is render-only. */
const coordHash = (tx: number, ty: number): number => {
  let h = Math.imul(tx ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(ty ^ 0xc2b2ae35, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  return h >>> 0
}

/** Ground "height" rank for seam shading: water-street lowest, then moss/
 * grass, then raised sidewalk decking, then interior floors. A LOWER tile
 * bordering a higher one takes a soft seam shadow on that edge, so surfaces
 * meet deliberately (shoreline, curb) instead of butting flat colors. */
const GROUND_RANK: Record<number, number> = {
  [Tile.Street]: 0,
  [Tile.Grass]: 1,
  [Tile.Sidewalk]: 2,
  [Tile.Floor]: 3,
  [Tile.Exit]: 3,
}

const SIDES: readonly { side: OverlaySide; dx: number; dy: number }[] = [
  { side: 'n', dx: 0, dy: -1 },
  { side: 's', dx: 0, dy: 1 },
  { side: 'w', dx: -1, dy: 0 },
  { side: 'e', dx: 1, dy: 0 },
]

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
    const tileAt = (tx: number, ty: number): number =>
      tx >= 0 && ty >= 0 && tx < level.w && ty < level.h ? level.tiles[ty * level.w + tx] : Tile.Sidewalk
    const chunksX = Math.ceil(level.w / CHUNK)
    const chunksY = Math.ceil(level.h / CHUNK)
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const container = new Container()
        container.position.set(cx * CHUNK * TILE_PX, cy * CHUNK * TILE_PX)
        for (let ty = cy * CHUNK; ty < Math.min((cy + 1) * CHUNK, level.h); ty++) {
          for (let tx = cx * CHUNK; tx < Math.min((cx + 1) * CHUNK, level.w); tx++) {
            // Deterministic per-position hash — variant + accent selection
            const hash = coordHash(tx, ty)
            const tileId = level.tiles[ty * level.w + tx]
            const px = (tx - cx * CHUNK) * TILE_PX
            const py = (ty - cy * CHUNK) * TILE_PX
            // Bevelled wall corner: its texture has a transparent cut triangle,
            // so first lay down the ground tile the bevel exposes (the diagonal
            // outside neighbour's art — falls back to sidewalk).
            const cut = WALL_CUT_OUTSIDE[tileId]
            if (cut) {
              const neighbor = tileAt(tx + cut.dx, ty + cut.dy)
              const ground = isWallTile(neighbor) ? Tile.Sidewalk : neighbor
              const back = new Sprite(art.tile(ground, hash))
              back.position.set(px, py)
              container.addChild(back)
            }
            const sprite = new Sprite(art.tile(tileId, hash))
            sprite.position.set(px, py)
            container.addChild(sprite)

            // ---- Grounding pass: wall-contact shadows + surface seams ------
            // Cheap baked ambient occlusion: walls cast onto adjacent ground,
            // and lower surfaces shade where they meet higher ones. Pure
            // function of the (already deterministic) tile grid.
            if (!isWallTile(tileId)) {
              const myRank = GROUND_RANK[tileId] ?? 0
              for (const { side, dx, dy } of SIDES) {
                const nb = tileAt(tx + dx, ty + dy)
                if (isWallTile(nb)) {
                  const shadow = new Sprite(art.wallShadow(side))
                  shadow.position.set(px, py)
                  container.addChild(shadow)
                } else if ((GROUND_RANK[nb] ?? 0) > myRank) {
                  const seam = new Sprite(art.groundSeam(side))
                  seam.position.set(px, py)
                  container.addChild(seam)
                }
              }
            }
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
