// Render indoor-complex floors (3+) to PNG without a browser: every tile an
// 10x10 cell in the game's procedural tile colours graded by biome, module
// roles tinted, plus the populated world's entities (furniture, crew, dormant
// sleepers, security patrols) and the director's vents. A pure-node PNG
// encoder (zlib) so it needs neither WebGL nor ffmpeg.
//
//   pnpm exec tsx scripts/test/render-complex-maps.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { Tile } from '../../src/game/levelgen/level'
import { populateWorld } from '../../src/game/populate'
import { setupFloor } from '../../src/game/systems/missions'
import { createWorld } from '../../src/game/world'
import { BIOME_TINT, mulTint } from '../../src/render/complexLook'

const OUT = process.argv[2] ?? 'e2e/out'
mkdirSync(OUT, { recursive: true })
const S = 10

const TILE: Record<number, number> = {
  [Tile.Floor]: 0x63523f,
  [Tile.Wall]: 0x1b1b24,
  [Tile.Grass]: 0x2e5d3a,
  [Tile.Exit]: 0xd4af37,
  [Tile.Hall]: 0x3d4650,
  [Tile.Grate]: 0x2c3238,
  [Tile.Tiled]: 0x8c9a9c,
  [Tile.Plating]: 0x565c62,
  [Tile.Hull]: 0x0c0f14,
  [Tile.Bog]: 0x2f4a3a,
}
const ROLE: Record<string, number> = {
  mess: 0xffd27f, galley: 0xffb27f, quarters: 0x9fd0ff, washroom: 0xbfefff, lab: 0xb8ff9f,
  medbay: 0xff9fb0, reactor: 0xff8f5f, depot: 0xd8c8a8, security: 0x8fb0ff,
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const png = (w: number, h: number, rgb: Buffer): Buffer => {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const mix = (a: number, b: number, t: number): number => {
  const ch = (s: number): number => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

const render = (seed: number, floor: number): { file: string; buf: Buffer; W: number; H: number } => {
  const w = createWorld(seed, floor)
  populateWorld(w)
  setupFloor(w)
  const L = w.level
  const biome = L.complex!.biome
  const W = L.w * S
  const H = L.h * S
  const buf = Buffer.alloc(W * H * 3)
  const put = (px: number, py: number, c: number): void => {
    if (px < 0 || py < 0 || px >= W || py >= H) return
    const i = (py * W + px) * 3
    buf[i] = (c >> 16) & 255
    buf[i + 1] = (c >> 8) & 255
    buf[i + 2] = c & 255
  }
  const roleAt = new Map<number, string>()
  for (const b of L.buildings) {
    for (const r of b.rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roleAt.set(y * L.w + x, b.role)
  }
  for (let ty = 0; ty < L.h; ty++) {
    for (let tx = 0; tx < L.w; tx++) {
      const t = L.tiles[ty * L.w + tx]
      let c = mulTint(TILE[t] ?? 0xff00ff, BIOME_TINT[biome])
      const role = roleAt.get(ty * L.w + tx)
      if (role && t !== Tile.Bog && t !== Tile.Grass) c = mix(c, ROLE[role], 0.28)
      for (let py = 0; py < S; py++) {
        for (let px = 0; px < S; px++) {
          let cc = c
          if (t === Tile.Grate && (py % 3 === 1)) cc = 0x7fd65a
          if (t === Tile.Tiled && (px === 0 || py === 0)) cc = mix(c, 0, 0.25)
          if (t === Tile.Hall && px === 0 && py === 0) cc = mix(c, 0xffffff, 0.2)
          put(tx * S + px, ty * S + py, cc)
        }
      }
    }
  }
  const dot = (x: number, y: number, r: number, c: number): void => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) put(Math.round(x * S) + dx, Math.round(y * S) + dy, c)
  }
  for (const e of w.entities) {
    if (e.dead) continue
    if (e.kind === 'interactable') dot(e.pos.x, e.pos.y, 2, 0x2a2a2a)
    else if (e.kind === 'door') dot(e.pos.x, e.pos.y, 2, 0xc9a227)
    else if (e.kind === 'npc') {
      const c = e.ai?.dormant ? 0xb06ae0 : e.ai?.behavior === 'patrol' ? 0x4f8fff : e.ai?.faction === 'gang' ? 0xe04848 : 0xf0e080
      dot(e.pos.x, e.pos.y, 3, 0x000000)
      dot(e.pos.x, e.pos.y, 2, c)
    }
  }
  dot(L.spawn.x, L.spawn.y, 4, 0x000000)
  dot(L.spawn.x, L.spawn.y, 3, 0x7fff7f)
  const file = join(OUT, `indoor-map-seed${seed}-floor${floor}-${biome}.png`)
  writeFileSync(file, png(W, H, buf))
  const roles = new Map<string, number>()
  for (const b of L.buildings) roles.set(b.role, (roles.get(b.role) ?? 0) + 1)
  console.log(`${file}: ${L.buildings.length} modules ${JSON.stringify(Object.fromEntries(roles))}, ${L.complex!.vents.length} vents, ${w.entities.filter((e) => e.kind === 'npc' && !e.dead).length} npcs`)
  return { file, buf, W, H }
}

// Complex floors only (3, 5, 7, 9 = one lap of the four biomes), then one
// contact sheet of them all (4 across) for a before/after at a glance.
const shots = [[3, 3], [3, 5], [3, 7], [3, 9], [11, 3], [7, 7], [21, 5], [42, 9]].map(([seed, floor]) => render(seed, floor))
const COLS = 4
const GAP = 12
const cw = shots[0].W
const ch = shots[0].H
const rows = Math.ceil(shots.length / COLS)
const SW = COLS * cw + (COLS + 1) * GAP
const SH = rows * ch + (rows + 1) * GAP
const sheet = Buffer.alloc(SW * SH * 3, 0x30)
shots.forEach((s, i) => {
  const ox = GAP + (i % COLS) * (cw + GAP)
  const oy = GAP + Math.floor(i / COLS) * (ch + GAP)
  for (let y = 0; y < ch; y++) s.buf.copy(sheet, ((oy + y) * SW + ox) * 3, y * cw * 3, (y + 1) * cw * 3)
})
const sheetFile = join(OUT, 'indoor-map-sheet.png')
writeFileSync(sheetFile, png(SW, SH, sheet))
console.log(sheetFile)
