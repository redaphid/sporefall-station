import { Tile, TileGrid, isWallTile } from './level'

/**
 * Autotile pass: bevel convex building corners that face the street. A wall
 * tile whose two exposed orthogonal neighbours AND the diagonal between them
 * are outdoor ground (street/sidewalk/grass), while the opposite two stay
 * wall, becomes a 45° cut variant named for the exposed corner.
 *
 * Collision is untouched — cut tiles stay fully solid (see level.ts Tile
 * docs): the drawn shape is strictly inside the collision square, so movement
 * can never snag on the bevel; you just can't stand in the sliver of pavement
 * it reveals. Runs only on floors >= 2 (floor 1 is frozen byte-exact) and
 * AFTER connectivity repair, so reachability BFS never sees cut tiles.
 */
export const applyCornerCuts = (grid: TileGrid): void => {
  const outdoor = (t: number): boolean => t === Tile.Street || t === Tile.Sidewalk || t === Tile.Grass
  const cuts: { x: number; y: number; t: number }[] = []
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      if (grid.get(x, y) !== Tile.Wall) continue
      const n = grid.get(x, y - 1)
      const s = grid.get(x, y + 1)
      const e = grid.get(x + 1, y)
      const w = grid.get(x - 1, y)
      if (outdoor(n) && outdoor(w) && outdoor(grid.get(x - 1, y - 1)) && isWallTile(s) && isWallTile(e)) {
        cuts.push({ x, y, t: Tile.WallCutNW })
      } else if (outdoor(n) && outdoor(e) && outdoor(grid.get(x + 1, y - 1)) && isWallTile(s) && isWallTile(w)) {
        cuts.push({ x, y, t: Tile.WallCutNE })
      } else if (outdoor(s) && outdoor(e) && outdoor(grid.get(x + 1, y + 1)) && isWallTile(n) && isWallTile(w)) {
        cuts.push({ x, y, t: Tile.WallCutSE })
      } else if (outdoor(s) && outdoor(w) && outdoor(grid.get(x - 1, y + 1)) && isWallTile(n) && isWallTile(e)) {
        cuts.push({ x, y, t: Tile.WallCutSW })
      }
    }
  }
  for (const c of cuts) grid.set(c.x, c.y, c.t as (typeof Tile)[keyof typeof Tile])
}
