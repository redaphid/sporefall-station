// Character-sprite consistency gate: every shipped frame of a character must
// read as the SAME character — standing height, width, head-block, pixel mass
// and centroid within a committed per-character tolerance of a reference frame.
//
// The spec lives in scripts/assets/consistency-spec.json, derived from each
// character's curated s-idle by `python3 scripts/assets/consistency.py
// --write-spec`. The metric definitions here MIRROR scripts/assets/
// consistency.py (metrics()) — if you change one, change both. The Python
// harness is the workbench (reports, sweeps, spec writing); this test is the
// standing tripwire that fails CI when a regenerated or hand-edited sprite
// drifts out of its character's silhouette envelope.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const CHARS_DIR = join(process.cwd(), 'public', 'themes', 'swampspace', 'chars')
const SPEC_PATH = join(process.cwd(), 'scripts', 'assets', 'consistency-spec.json')
const ALPHA_MIN = 128 // consistency.py ALPHA_MIN
const HEAD_CUT = 0.55 // consistency.py HEAD_CUT
const HEAD_ZONE = 0.45 // consistency.py HEAD_ZONE
const DIRS = new Set(['s', 'se', 'e', 'ne', 'n'])

type Metrics = { height: number; width: number; head_h: number; mass: number; cx: number; foot_y: number }
type Spec = Record<
  string,
  {
    ref_frame: string
    ref: Metrics
    tol: { height: number; width: number; head_h: number; mass_frac: number; cx: number; foot_y: number }
    // facing gate (opt-in): drawn side art must face RIGHT — the engine mirrors
    // the west half (docs/sprite-generation.md §3). For characters whose face
    // carries a hot accent (the ranger's amber visor): 'e'/'se' frames need the
    // accent centroid ≥ min_dx px RIGHT of the body centroid; back views
    // ('ne'/'n') must show ≤ back_max_frac accent in the head zone.
    accent?: { min_dx: number; back_max_frac: number }
  }
>

// consistency.py ACCENT_RGB: the locked palette's amber/orange/red hot accents
const ACCENT_RGB = new Set(['255,216,62', '255,144,50', '224,74,42'])

// --- minimal PNG → RGBA decoder (8-bit, non-interlaced; what PIL emits) ------
const decodePng = (buf: Buffer): { width: number; height: number; rgba: Uint8Array } => {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      expect(data[8]).toBe(8) // bit depth: pipeline emits 8-bit
      expect(data[12]).toBe(0) // non-interlaced
    } else if (type === 'PLTE') palette = new Uint8Array(data)
    else if (type === 'tRNS') trns = new Uint8Array(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const line = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = src[i]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      line[i] = v
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 6) rgba.set(line.subarray(x * 4, x * 4 + 4), o)
      else if (colorType === 2) {
        rgba.set(line.subarray(x * 3, x * 3 + 3), o)
        rgba[o + 3] = 255
      } else if (colorType === 3 && palette) {
        const idx = line[x]
        rgba.set(palette.subarray(idx * 3, idx * 3 + 3), o)
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255
      } else if (colorType === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x]
        rgba[o + 3] = 255
      } else {
        // 4 = gray+alpha
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x * 2]
        rgba[o + 3] = line[x * 2 + 1]
      }
    }
    prev.set(line)
  }
  return { width, height, rgba }
}

// --- silhouette metrics (mirror of consistency.py metrics()) -----------------
const silhouette = (path: string): Metrics => {
  const { width: W, height: H, rgba } = decodePng(readFileSync(path))
  const occ = new Array<number>(H).fill(0)
  let top = -1
  let bottom = -1
  let minX = W
  let maxX = -1
  let mass = 0
  let sumX = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (rgba[(y * W + x) * 4 + 3] > ALPHA_MIN) {
        occ[y]++
        mass++
        sumX += x
        if (top === -1) top = y
        bottom = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
  if (mass === 0) return { height: 0, width: 0, head_h: 0, mass: 0, cx: 0, foot_y: 0 }
  const height = bottom - top + 1
  const zoneEnd = top + Math.max(1, Math.floor(height * HEAD_ZONE))
  let headPeak = 0
  for (let y = top; y < zoneEnd; y++) if (occ[y] > headPeak) headPeak = occ[y]
  let headH = 0
  for (let y = top; y <= bottom; y++) {
    if (occ[y] < HEAD_CUT * headPeak && headH > 0) break
    if (occ[y] >= HEAD_CUT * headPeak) headH = y - top + 1
  }
  return {
    height,
    width: maxX - minX + 1,
    head_h: headH,
    mass,
    cx: sumX / mass - (W - 1) / 2,
    foot_y: bottom,
  }
}

// accent facing (mirror of consistency.py accent_dx()): signed centroid-x
// offset of face-accent pixels from the body centroid, and the accent's share
// of head-zone pixels. [0, 0] when the frame has no accent pixels.
const accentDx = (path: string): [number, number] => {
  const { width: W, height: H, rgba } = decodePng(readFileSync(path))
  let top = -1
  let bottom = -1
  let mass = 0
  let sumX = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (rgba[(y * W + x) * 4 + 3] > ALPHA_MIN) {
        mass++
        sumX += x
        if (top === -1) top = y
        bottom = y
      }
  if (mass === 0) return [0, 0]
  const zoneEnd = top + Math.max(1, Math.floor((bottom - top + 1) * HEAD_ZONE))
  let accN = 0
  let accX = 0
  let headPx = 0
  for (let y = top; y < zoneEnd; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      if (rgba[o + 3] <= ALPHA_MIN) continue
      headPx++
      if (ACCENT_RGB.has(`${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}`)) {
        accN++
        accX += x
      }
    }
  if (accN === 0) return [0, 0]
  return [accX / accN - sumX / mass, accN / Math.max(1, headPx)]
}

// <kind>-<dir>-<frame>.png, kind and frame may contain '-' (bog-mutant-s-attack-1)
const parseFrame = (file: string): { kind: string; frame: string } | null => {
  const toks = file.replace(/\.png$/, '').split('-')
  for (let i = 1; i < toks.length - 1; i++)
    if (DIRS.has(toks[i]))
      return { kind: toks.slice(0, i).join('-'), frame: toks.slice(i).join('-') }
  return null
}

// ---------------------------------------------------------------------------
describe('swampspace character-sprite consistency (committed spec)', () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Spec
  const byKind = new Map<string, Array<{ frame: string; file: string }>>()
  for (const f of readdirSync(CHARS_DIR).filter((f) => f.endsWith('.png')).sort()) {
    const p = parseFrame(f)
    if (!p) continue
    if (!byKind.has(p.kind)) byKind.set(p.kind, [])
    byKind.get(p.kind)!.push({ frame: p.frame, file: join(CHARS_DIR, f) })
  }

  it('has a committed spec for every shipped character', () => {
    for (const kind of byKind.keys()) expect(spec[kind], `spec for ${kind}`).toBeDefined()
  })

  it('spec reference frames exist and still match their committed metrics (spec drift tripwire)', () => {
    for (const [kind, s] of Object.entries(spec)) {
      const m = silhouette(join(CHARS_DIR, `${kind}-${s.ref_frame}.png`))
      const why = `${kind} ${s.ref_frame}: re-run consistency.py --write-spec after editing sprites`
      expect({ ...m, cx: 0 }, why).toEqual({ ...s.ref, cx: 0 })
      expect(m.cx, why).toBeCloseTo(s.ref.cx, 1) // python rounds cx to 2 decimals
    }
  })

  for (const [kind, frames] of byKind) {
    describe(kind, () => {
      for (const { frame, file } of frames) {
        it(`${frame} stays within the character's silhouette envelope`, () => {
          const s = spec[kind]
          expect(s).toBeDefined()
          const m = silhouette(file)
          const { ref, tol } = s
          expect(Math.abs(m.height - ref.height), `height ${m.height} vs ref ${ref.height}`).toBeLessThanOrEqual(tol.height)
          expect(Math.abs(m.width - ref.width), `width ${m.width} vs ref ${ref.width}`).toBeLessThanOrEqual(tol.width)
          expect(Math.abs(m.head_h - ref.head_h), `head_h ${m.head_h} vs ref ${ref.head_h}`).toBeLessThanOrEqual(tol.head_h)
          expect(Math.abs(m.mass - ref.mass) / ref.mass, `mass ${m.mass} vs ref ${ref.mass}`).toBeLessThanOrEqual(tol.mass_frac)
          expect(Math.abs(m.cx - ref.cx), `cx ${m.cx.toFixed(2)} vs ref ${ref.cx}`).toBeLessThanOrEqual(tol.cx)
          expect(Math.abs(m.foot_y - ref.foot_y), `foot_y ${m.foot_y} vs ref ${ref.foot_y}`).toBeLessThanOrEqual(tol.foot_y)
          if (s.accent) {
            const dir = frame.split('-')[0]
            const [dx, frac] = accentDx(file)
            if (dir === 'e' || dir === 'se') {
              expect(frac, 'face accent missing — side art cannot face right without a face').toBeGreaterThan(0)
              expect(dx, `faces LEFT (accent dx ${dx.toFixed(1)}) — drawn side art must face right (west is mirrored)`).toBeGreaterThanOrEqual(s.accent.min_dx)
            }
            if (dir === 'ne' || dir === 'n')
              expect(frac, `back view shows the face accent (frac ${frac.toFixed(3)})`).toBeLessThanOrEqual(s.accent.back_max_frac)
          }
        })
      }
    })
  }
})
