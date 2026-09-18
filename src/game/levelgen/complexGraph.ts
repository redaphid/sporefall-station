import { isWallTile, type TileGrid } from './level'

/**
 * The justified access graph of a complex floor (space syntax; spec P2).
 *
 * Walkable tiles are split into REGIONS by the barrier tiles — doors, arches
 * and service doors — so every room is one region and the corridors (with
 * their atria and courts) are another. Two regions are adjacent when a
 * barrier tile touches both. The DEPTH of a region is the number of barriers
 * crossed on the shortest walk from the spawn: the corridor is depth 0, a
 * room off it depth 1, a room behind that depth 2, and so on.
 */
export interface AccessGraph {
  /** Region id per tile; -1 = solid, or a barrier tile. */
  region: Int32Array
  adj: Set<number>[]
  /** Barriers crossed from the spawn's region; -1 = unreachable. */
  depth: number[]
}

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

export const buildAccessGraph = (grid: TileGrid, barriers: ReadonlySet<number>, spawnKey: number): AccessGraph => {
  const { w, h } = grid
  const region = new Int32Array(w * h).fill(-1)
  const open = (k: number): boolean => !isWallTile(grid.tiles[k]) && !barriers.has(k)
  let n = 0
  const stack: number[] = []
  for (let k = 0; k < w * h; k++) {
    if (region[k] >= 0 || !open(k)) continue
    region[k] = n
    stack.push(k)
    while (stack.length > 0) {
      const i = stack.pop()!
      const x = i % w
      const y = (i / w) | 0
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (region[j] >= 0 || !open(j)) continue
        region[j] = n
        stack.push(j)
      }
    }
    n++
  }
  // Barrier tiles side by side (double doors, a wide arch, a door opening
  // straight onto another) act as one: every region touching the cluster is
  // one barrier away from every other.
  const adj = Array.from({ length: n }, () => new Set<number>())
  const seen = new Set<number>()
  for (const k0 of barriers) {
    if (seen.has(k0) || isWallTile(grid.tiles[k0])) continue
    const touching = new Set<number>()
    const cluster = [k0]
    seen.add(k0)
    for (let ci = 0; ci < cluster.length; ci++) {
      const k = cluster[ci]
      const x = k % w
      const y = (k / w) | 0
      for (const [dx, dy] of ORTHO) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        const r = region[j]
        if (r >= 0) touching.add(r)
        else if (barriers.has(j) && !seen.has(j) && !isWallTile(grid.tiles[j])) {
          seen.add(j)
          cluster.push(j)
        }
      }
    }
    for (const p of touching) for (const q of touching) if (p !== q) adj[p].add(q)
  }
  const g: AccessGraph = { region, adj, depth: [] }
  g.depth = regionDistances(g, region[spawnKey])
  return g
}

/** Barriers crossed from region `from` to every region (-1 = unreachable). */
export const regionDistances = (g: AccessGraph, from: number): number[] => {
  const dist = new Array<number>(g.adj.length).fill(-1)
  if (from < 0) return dist
  dist[from] = 0
  const queue = [from]
  for (let qi = 0; qi < queue.length; qi++) {
    const r = queue[qi]
    for (const s of g.adj[r]) {
      if (dist[s] >= 0) continue
      dist[s] = dist[r] + 1
      queue.push(s)
    }
  }
  return dist
}
