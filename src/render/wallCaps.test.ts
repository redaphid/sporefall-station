import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isWallTile, Tile } from '../game/levelgen/level'
import { SPRITE_KEYS, WALL_CAP_NAMES } from './theme'
import { CAP_QUARTER_TURNS, CORNER_QUARTER_TURNS, cutCapSides, planWallCaps } from './wallCaps'

/** Grid from ASCII: '#' wall, 'H' hull, '.' floor, and the four bevels
 * 'a' NW, 'b' NE, 'c' SE, 'd' SW. */
const grid = (...rows: string[]) => {
  const ch: Record<string, number> = {
    '#': Tile.Wall,
    H: Tile.Hull,
    '.': Tile.Floor,
    a: Tile.WallCutNW,
    b: Tile.WallCutNE,
    c: Tile.WallCutSE,
    d: Tile.WallCutSW,
  }
  const h = rows.length
  const w = rows[0].length
  const tiles = rows.flatMap((r) => [...r].map((c) => ch[c]))
  return { w, h, tiles }
}

const sorted = <T>(xs: readonly T[]): T[] => [...xs].sort()

describe('planWallCaps', () => {
  it('returns nothing for ground tiles', () => {
    expect(planWallCaps(grid('.#.'), 0, 0)).toBeUndefined()
  })

  it('a VERTICAL run caps its flanks, never its top or bottom (no ladder of dashes)', () => {
    const g = grid('.#.', '.#.', '.#.')
    const mid = planWallCaps(g, 1, 1)!
    expect(sorted(mid.sides)).toEqual(['e', 'w'])
    expect(mid.inner).toEqual([])
    // The run ends at the map edge: off-map counts as wall, so no end cap there.
    expect(sorted(planWallCaps(g, 1, 0)!.sides)).toEqual(['e', 'w'])
  })

  it('a HORIZONTAL run caps its north and south faces', () => {
    const g = grid('...', '###', '...')
    expect(sorted(planWallCaps(g, 1, 1)!.sides)).toEqual(['n', 's'])
  })

  it('a free-standing run end caps its tip so the line wraps around it', () => {
    const g = grid('.....', '.###.', '.....')
    expect(sorted(planWallCaps(g, 1, 1)!.sides)).toEqual(['n', 's', 'w'])
    expect(sorted(planWallCaps(g, 3, 1)!.sides)).toEqual(['e', 'n', 's'])
  })

  it('a room corner: convex outside, concave nub inside', () => {
    // Room outline; the NW corner wall tile at (1,1).
    const g = grid('......', '.####.', '.#..#.', '.####.', '......')
    const nw = planWallCaps(g, 1, 1)!
    expect(sorted(nw.sides)).toEqual(['n', 'w'])
    // Inside corner: walls east and south, room floor diagonally SE.
    expect(nw.inner).toEqual(['se'])
  })

  it('a T-junction keeps the through-line and nubs both inside corners', () => {
    const g = grid('.....', '#####', '..#..', '..#..')
    const t = planWallCaps(g, 2, 1)!
    expect(t.sides).toEqual(['n'])
    expect(sorted(t.inner)).toEqual(['se', 'sw'])
    const stem = planWallCaps(g, 2, 2)!
    expect(sorted(stem.sides)).toEqual(['e', 'w'])
  })

  it('the inside of a thick wall mass is left uncapped', () => {
    const g = grid('.....', '.###.', '.###.', '.###.', '.....')
    expect(planWallCaps(g, 2, 2)).toEqual({ sides: [], inner: [] })
  })

  it('hull and wall tiles join as one solid mass (no cap between them)', () => {
    const g = grid('.#H.')
    expect(sorted(planWallCaps(g, 1, 0)!.sides)).toEqual(['w'])
    expect(sorted(planWallCaps(g, 2, 0)!.sides)).toEqual(['e'])
  })

  it('bevelled corners leave their two exposed edges to the baked bevel art', () => {
    const g = grid('...', '.a#', '.##')
    expect(cutCapSides(Tile.WallCutNW)).toEqual(['n', 'w'])
    expect(planWallCaps(g, 1, 1)).toEqual({ sides: [], inner: [] })
    expect(cutCapSides(Tile.WallCutNE)).toEqual(['n', 'e'])
    expect(cutCapSides(Tile.WallCutSE)).toEqual(['s', 'e'])
    expect(cutCapSides(Tile.WallCutSW)).toEqual(['s', 'w'])
    expect(cutCapSides(Tile.Wall)).toEqual([])
  })

  it('caps EVERY wall/ground edge exactly once and fills every concave corner (random grids)', () => {
    let seed = 12345
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      return seed / 2 ** 32
    }
    for (let trial = 0; trial < 40; trial++) {
      const w = 12
      const h = 10
      const tiles = Array.from({ length: w * h }, () => (rnd() < 0.45 ? (rnd() < 0.2 ? Tile.Hull : Tile.Wall) : Tile.Floor))
      const g = { w, h, tiles }
      const solid = (x: number, y: number): boolean =>
        x < 0 || y < 0 || x >= w || y >= h ? true : isWallTile(tiles[y * w + x])
      let boundaryEdges = 0
      let capped = 0
      let concave = 0
      let nubs = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!solid(x, y)) continue
          for (const [dx, dy] of [
            [0, -1],
            [1, 0],
            [0, 1],
            [-1, 0],
          ])
            if (!solid(x + dx, y + dy)) boundaryEdges++
          for (const [dx, dy] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ])
            if (solid(x + dx, y) && solid(x, y + dy) && !solid(x + dx, y + dy)) concave++
          const plan = planWallCaps(g, x, y)!
          capped += plan.sides.length
          nubs += plan.inner.length
        }
      }
      expect(capped).toBe(boundaryEdges)
      expect(nubs).toBe(concave)
    }
  })
})

describe('cap rotations', () => {
  it('turn the north-authored strip clockwise onto each edge', () => {
    expect(CAP_QUARTER_TURNS).toEqual({ n: 0, e: 1, s: 2, w: 3 })
  })
  it('turn the NW-authored nub clockwise onto each corner', () => {
    expect(CORNER_QUARTER_TURNS).toEqual({ nw: 0, ne: 1, se: 2, sw: 3 })
  })
})

// ---------------------------------------------------------------------------
// The shipped hi-res art: bodies capless, caps present. Minimal PNG decode
// (8-bit RGB/RGBA, non-interlaced — what PIL writes) so no image dependency.

const decodePng = (path: string): { w: number; h: number; ch: number; px: Uint8Array } => {
  const b = readFileSync(path)
  const w = b.readUInt32BE(16)
  const h = b.readUInt32BE(20)
  const ch = b[25] === 6 ? 4 : b[25] === 2 ? 3 : 0
  expect(b[24], `${path}: bit depth`).toBe(8)
  expect(ch, `${path}: colour type`).toBeGreaterThan(0)
  const idat: Buffer[] = []
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o)
    const type = b.toString('ascii', o + 4, o + 8)
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const px = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= ch ? px[y * stride + x - ch] : 0
      const up = y > 0 ? px[(y - 1) * stride + x] : 0
      const ul = y > 0 && x >= ch ? px[(y - 1) * stride + x - ch] : 0
      const pa = Math.abs(up - ul)
      const pb = Math.abs(a - ul)
      const pc = Math.abs(a + up - 2 * ul)
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : ul][f]
      px[y * stride + x] = (v + pred) & 0xff
    }
  }
  return { w, h, ch, px }
}

const HIRES = join(process.cwd(), 'public', 'themes', 'swampspace-hires')
const hires = JSON.parse(readFileSync(join(HIRES, 'manifest.json'), 'utf8')) as { sprites: Record<string, string | string[]> }
const rowLum = (img: ReturnType<typeof decodePng>, y: number): number => {
  let sum = 0
  for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * img.ch
    sum += 0.299 * img.px[i] + 0.587 * img.px[i + 1] + 0.114 * img.px[i + 2]
  }
  return sum / img.w
}

describe('swampspace-hires wall caps', () => {
  it.each(WALL_CAP_NAMES)('%s: cap keys are canonical and mapped', (name) => {
    expect(SPRITE_KEYS.has(`tile.${name}.cap`)).toBe(true)
    expect(SPRITE_KEYS.has(`tile.${name}.cap.inner`)).toBe(true)
    expect(hires.sprites[`tile.${name}.cap`]).toBe(`tiles/${name}-cap.png`)
    expect(hires.sprites[`tile.${name}.cap.inner`]).toBe(`tiles/${name}-cap-inner.png`)
  })

  it.each(WALL_CAP_NAMES)('%s: the edge strip hugs the top edge, transparent below', (name) => {
    const img = decodePng(join(HIRES, 'tiles', `${name}-cap.png`))
    expect(img.ch).toBe(4)
    const alpha = (x: number, y: number): number => img.px[(y * img.w + x) * 4 + 3]
    expect(alpha(0, 0)).toBe(255)
    expect(alpha(img.w - 1, 0)).toBe(255)
    let depth = 0
    while (depth < img.h && alpha(0, depth) === 255) depth++
    expect(depth).toBeGreaterThan(1)
    expect(depth).toBeLessThan(img.h / 4)
    for (let y = depth; y < img.h; y++) for (let x = 0; x < img.w; x++) expect(alpha(x, y)).toBe(0)
    // The nub is the strip's first cap-depth square, nothing else.
    const nub = decodePng(join(HIRES, 'tiles', `${name}-cap-inner.png`))
    const na = (x: number, y: number): number => nub.px[(y * nub.w + x) * 4 + 3]
    expect(na(depth - 1, depth - 1)).toBe(255)
    expect(na(depth, 0)).toBe(0)
    expect(na(0, depth)).toBe(0)
  })

  it.each(WALL_CAP_NAMES)('%s: body tiles carry NO baked cap along their top edge', (name) => {
    const bodies = [hires.sprites[`tile.${name}`], hires.sprites[`tile.${name}.accent`] ?? []].flat()
    expect(bodies.length).toBeGreaterThan(0)
    for (const f of bodies) {
      const img = decodePng(join(HIRES, f))
      const rows = Array.from({ length: img.h }, (_, y) => rowLum(img, y))
      const body = [...rows.slice(img.h / 4)].sort((a, b) => a - b)[Math.floor((img.h * 3) / 8)]
      // The old baked cap sat ~80 luminance above the body; allow texture noise.
      expect(Math.max(...rows.slice(0, 8)), `${f}: bright cap rows at the top`).toBeLessThan(body + 25)
    }
  })
})
