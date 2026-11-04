// What colour is a round with one mod, in the default theme?
// Run from the repo root:  pnpm exec tsx docs/design/setting-fit/round-colours.mts
//
// composeBulletTraits is the live render code. In the swampspace packs the
// round's core is the themed sprite fx/spore-bolt.png, and bullets.ts tints it
// with the composed colour. Pixi's tint multiplies, so the core a player sees
// is the sprite's body pixel times the tint. The body pixel is read from the
// sprite itself.
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { composeBulletTraits } from '../../../src/render/bulletVisuals.ts'
import { MODS } from '../../../src/game/data/mods.ts'

const bodyPixel = (path: string): [number, number, number] => {
  const png = readFileSync(path)
  let off = 8
  let width = 0
  const idat: Buffer[] = []
  while (off < png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('expected 8-bit RGBA')
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rowLen = width * 4
  const rows = raw.length / (rowLen + 1)
  const px = Buffer.alloc(rows * rowLen)
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < rows; y++) {
    const filter = raw[y * (rowLen + 1)]
    for (let x = 0; x < rowLen; x++) {
      const v = raw[y * (rowLen + 1) + 1 + x]
      const a = x >= 4 ? px[y * rowLen + x - 4] : 0
      const b = y > 0 ? px[(y - 1) * rowLen + x] : 0
      const c = x >= 4 && y > 0 ? px[(y - 1) * rowLen + x - 4] : 0
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]
      px[y * rowLen + x] = (v + pred) & 255
    }
  }
  const counts = new Map<string, number>()
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] !== 255) continue
    const k = `${px[i]},${px[i + 1]},${px[i + 2]}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!top) throw new Error(`no opaque pixels in ${path}`)
  return top[0].split(',').map(Number) as [number, number, number]
}

const body = bodyPixel('public/themes/swampspace-hires/fx/spore-bolt.png')
const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0')
const onBody = (c: number): string =>
  '#' +
  [(c >> 16) & 255, (c >> 8) & 255, c & 255]
    .map((v, i) => Math.round((v * body[i]) / 255).toString(16).padStart(2, '0'))
    .join('')

console.log(`spore-bolt body pixel rgb(${body.join(', ')})`)
console.log('mod           composed  core on screen  halo      halo strength')
let noHalo = 0
for (const id of Object.keys(MODS)) {
  const t = composeBulletTraits([{ id, stacks: 1 }])
  if (t.glow === 0) noHalo++
  console.log(`${id.padEnd(14)}${hex(t.color)}   ${onBody(t.color)}         ${hex(t.glowColor)}   ${t.glow.toFixed(2)}`)
}
console.log(`${noHalo} of ${Object.keys(MODS).length} single-mod rounds have no halo, so their only colour is the core on screen.`)
