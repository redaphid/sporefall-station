// Every shipped indoor-kit file carries the ComfyUI flow that made it, as tEXt
// `prompt` + `workflow`, so dragging a tile or prop into ComfyUI rebuilds its graph.
// scripts/assets/flows/indoor/shipped.json maps each file to its flow; the flow
// files sit beside it. `python3 scripts/assets/indoor_kit.py ship` writes all three.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const FLOWS = join(ROOT, 'scripts', 'assets', 'flows', 'indoor')
const PACK = join(ROOT, 'public', 'themes', 'swampspace-hires')

const tEXt = (png: Buffer): Map<string, Buffer> => {
  const out = new Map<string, Buffer>()
  for (let i = 8; i + 8 <= png.length; ) {
    const bytes = png.readUInt32BE(i)
    if (png.toString('latin1', i + 4, i + 8) === 'tEXt') {
      const data = png.subarray(i + 8, i + 8 + bytes)
      const nul = data.indexOf(0)
      out.set(data.toString('latin1', 0, nul), data.subarray(nul + 1))
    }
    i += 12 + bytes
  }
  return out
}

const shipped = JSON.parse(readFileSync(join(FLOWS, 'shipped.json'), 'utf8')) as Record<string, string>
const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8')) as { sprites: Record<string, string | string[]> }

// The keys the indoor kit owns (src/render/indoorSkin.ts resolves them).
const INDOOR_KEY = /^(tile\.(deck|bulkhead|pillar|stair_up|stair_down)(\..+)?|prop\.(bulkhead-door(-open|-locked)?|generator|coolant-tank|cryo-bunk|freight-case|parts-rack))$/

describe('indoor kit art carries its flow', () => {
  it('every file the manifest maps under an indoor key is a shipped kit file', () => {
    const mapped = Object.entries(manifest.sprites)
      .filter(([k]) => INDOOR_KEY.test(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    expect(mapped.length).toBeGreaterThan(20)
    expect(mapped.filter((f) => !(f in shipped))).toEqual([])
  })

  it('every shipped kit file embeds its prompt + workflow byte for byte', () => {
    const missing = Object.entries(shipped).filter(([file, flow]) => {
      const text = tEXt(readFileSync(join(PACK, file)))
      return !(
        text.get('prompt')?.equals(readFileSync(join(FLOWS, `${flow}_api.json`))) &&
        text.get('workflow')?.equals(readFileSync(join(FLOWS, `${flow}.json`)))
      )
    })
    expect(missing, 'run: python3 scripts/assets/indoor_kit.py ship').toEqual([])
  })

  it('every flow is a ComfyUI graph that saves an image', () => {
    for (const flow of new Set(Object.values(shipped))) {
      const api = JSON.parse(readFileSync(join(FLOWS, `${flow}_api.json`), 'utf8')) as Record<string, { class_type: string }>
      const editor = JSON.parse(readFileSync(join(FLOWS, `${flow}.json`), 'utf8')) as { nodes: { type: string }[] }
      expect(Object.values(api).map((n) => n.class_type)).toContain('SaveImage')
      expect(editor.nodes.map((n) => n.type)).toContain('SaveImage')
    }
  })
})
