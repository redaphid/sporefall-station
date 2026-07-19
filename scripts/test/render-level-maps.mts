// Render full-level tile maps to PNG for visual inspection of the levelgen
// architecture work (hallway spines, bunkers, courtyard compounds, bevelled
// corners, boulevards/alleys/plazas). Pure levelgen — no pixi, no browser:
// each tile becomes an 8x8 colored cell in a raw RGB buffer that ffmpeg wraps
// into a PNG. Filenames carry seed/floor/theme plus the set-pieces present.
//
//   pnpm exec tsx scripts/test/render-level-maps.mts [outDir]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateLevel } from '../../src/game/levelgen/generate'
import { Tile, WALL_CUT_OUTSIDE } from '../../src/game/levelgen/level'

const OUT = process.argv[2] ?? 'e2e/output/maps'
mkdirSync(OUT, { recursive: true })

const SCALE = 8
const COLORS: Record<number, [number, number, number]> = {
  [Tile.Street]: [0x33, 0x33, 0x3c],
  [Tile.Sidewalk]: [0x4c, 0x4c, 0x56],
  [Tile.Floor]: [0x63, 0x52, 0x3f],
  [Tile.Wall]: [0x14, 0x14, 0x1c],
  [Tile.Grass]: [0x2e, 0x5d, 0x3a],
  [Tile.Exit]: [0xd4, 0xaf, 0x37],
}

const render = (seed: number, floor: number): void => {
  const level = generateLevel(seed, floor)
  const W = level.w * SCALE
  const H = level.h * SCALE
  const buf = Buffer.alloc(W * H * 3)
  for (let ty = 0; ty < level.h; ty++) {
    for (let tx = 0; tx < level.w; tx++) {
      const t = level.tiles[ty * level.w + tx]
      const cut = WALL_CUT_OUTSIDE[t]
      const base = COLORS[t] ?? (cut ? COLORS[Tile.Wall] : [255, 0, 255])
      for (let py = 0; py < SCALE; py++) {
        for (let px = 0; px < SCALE; px++) {
          let c = base
          if (cut) {
            // Show the bevel: the cut triangle renders as sidewalk.
            const u = (px + 0.5) / SCALE
            const v = (py + 0.5) / SCALE
            const inCut =
              (cut.dx < 0 && cut.dy < 0 && u + v < 0.5) ||
              (cut.dx > 0 && cut.dy < 0 && 1 - u + v < 0.5) ||
              (cut.dx > 0 && cut.dy > 0 && 2 - u - v < 0.5) ||
              (cut.dx < 0 && cut.dy > 0 && u + 1 - v < 0.5)
            if (inCut) c = COLORS[Tile.Sidewalk]
          }
          const i = ((ty * SCALE + py) * W + tx * SCALE + px) * 3
          buf[i] = c[0]
          buf[i + 1] = c[1]
          buf[i + 2] = c[2]
        }
      }
    }
  }
  // Overlay door positions (gold dots) so airlocks/gates/spine ends read.
  for (const b of level.buildings) {
    for (const d of b.doors) {
      for (let py = 2; py < SCALE - 2; py++) {
        for (let px = 2; px < SCALE - 2; px++) {
          const i = ((d.y * SCALE + py) * W + d.x * SCALE + px) * 3
          buf[i] = 0xd4
          buf[i + 1] = 0xaf
          buf[i + 2] = 0x37
        }
      }
    }
  }

  const pois = new Set(level.buildings.map((b) => b.poi).filter(Boolean))
  const tags = [
    pois.has('bunker') ? 'bunker' : '',
    pois.has('courtyard') ? 'courtyard' : '',
    pois.has('hallway') ? 'hallways' : '',
    (level.plazas?.length ?? 0) > 0 ? 'plaza' : '',
  ]
    .filter(Boolean)
    .join('-')
  const name = `map-seed${seed}-floor${floor}-${level.theme}${tags ? `-${tags}` : ''}.png`
  const raw = join(OUT, 'tmp.raw')
  writeFileSync(raw, buf)
  execFileSync('ffmpeg', [
    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', raw, '-frames:v', '1', join(OUT, name),
  ], { stdio: 'ignore' })
  rmSync(raw)
  console.log(`${name}  buildings=${level.buildings.length} pois=[${[...pois].join(',')}] plazas=${level.plazas?.length ?? 0}`)
}

for (const seed of [7, 11, 42]) {
  for (let floor = 1; floor <= 5; floor++) render(seed, floor)
}
console.log(`maps in ${OUT}`)
