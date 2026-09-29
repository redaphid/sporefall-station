// A shipped PNG must not carry its generation flow. The cast-walk pipeline
// embeds each frame's ComfyUI `workflow` + `prompt` (~25 KB a frame), and 400
// such frames pushed the APK past Cloudflare's 25 MiB asset cap, which failed
// every web deploy. The flows live in scripts/assets/flows/cast/ instead
// (`cast_walk.py strip`), so any text chunk bigger than a short label here is
// provenance that leaked into the bundle.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const THEMES_DIR = join(__dirname, '..', '..', 'public', 'themes')
const MAX_TEXT_BYTES = 1024
const TEXT_TYPES = new Set(['tEXt', 'iTXt', 'zTXt'])

interface TextChunk {
  type: string
  keyword: string
  bytes: number
}

const textChunks = (png: Buffer): TextChunk[] => {
  const out: TextChunk[] = []
  for (let i = 8; i + 8 <= png.length; ) {
    const bytes = png.readUInt32BE(i)
    const type = png.toString('latin1', i + 4, i + 8)
    if (TEXT_TYPES.has(type)) {
      const data = png.subarray(i + 8, i + 8 + bytes)
      out.push({ type, keyword: data.toString('latin1', 0, data.indexOf(0)), bytes })
    }
    i += 12 + bytes
  }
  return out
}

const pngs = (readdirSync(THEMES_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.png'))

describe('theme PNG text chunks', () => {
  it('finds the theme PNGs', () => {
    expect(pngs.length).toBeGreaterThan(100)
  })

  it(`no shipped PNG carries a text chunk over ${MAX_TEXT_BYTES} bytes`, () => {
    const oversized = pngs.flatMap((f) =>
      textChunks(readFileSync(join(THEMES_DIR, f)))
        .filter((c) => c.bytes > MAX_TEXT_BYTES)
        .map((c) => `${f} ${c.type} "${c.keyword}" ${c.bytes} B`),
    )
    expect(oversized, 'run: python3 scripts/assets/cast_walk.py strip --kind <kind>').toEqual([])
  })

  it('sees a flow-sized chunk in any text chunk type', () => {
    const chunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
    }
    const flow = Buffer.concat([Buffer.from('workflow\0', 'latin1'), Buffer.alloc(2048, 0x7b)])
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', Buffer.alloc(13)),
      chunk('tEXt', Buffer.from('Software\0pixi', 'latin1')),
      ...[...TEXT_TYPES].map((t) => chunk(t, flow)),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect(textChunks(png).map((c) => [c.type, c.keyword, c.bytes > MAX_TEXT_BYTES])).toEqual([
      ['tEXt', 'Software', false],
      ['tEXt', 'workflow', true],
      ['iTXt', 'workflow', true],
      ['zTXt', 'workflow', true],
    ])
  })
})
