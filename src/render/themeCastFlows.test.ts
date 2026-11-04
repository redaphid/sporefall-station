// Every shipped cast-walk frame carries the ComfyUI flow that made it, as tEXt
// `prompt` + `workflow`, so dragging a sprite into ComfyUI rebuilds its graph.
// scripts/assets/flows/cast/<kind>/ keeps a copy per direction; a frame that
// lost its flow (an export from before the flows came back) gets it back with
// `python3 scripts/assets/cast_walk.py embed --kind <kind>`.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const FLOWS = join(ROOT, 'scripts', 'assets', 'flows', 'cast')
const PACKS = ['swampspace-hires', 'swampspace']
const DIRS = ['s', 'se', 'e', 'ne', 'n']
const POSES = ['idle', 'step', ...Array.from({ length: 8 }, (_, i) => `walk-${i}`)]

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

const kinds = readdirSync(FLOWS)

describe('cast-walk frames carry their flow', () => {
  it('finds the kinds with flows', () => {
    expect(kinds).toEqual(expect.arrayContaining(['mycologist', 'vine-ranger', 'drowned-diver', 'blast-diver']))
  })

  it("every frame of a kind in flows/cast/ embeds its direction's prompt + workflow", () => {
    const missing = kinds.flatMap((kind) =>
      DIRS.flatMap((d) => {
        const prompt = readFileSync(join(FLOWS, kind, `${d}_api.json`))
        const workflow = readFileSync(join(FLOWS, kind, `${d}.json`))
        return PACKS.flatMap((pack) => POSES.map((p) => `public/themes/${pack}/chars/${kind}-${d}-${p}.png`)).filter(
          (f) => {
            const text = tEXt(readFileSync(join(ROOT, f)))
            return !(text.get('prompt')?.equals(prompt) && text.get('workflow')?.equals(workflow))
          },
        )
      }),
    )
    expect(missing, 'run: python3 scripts/assets/cast_walk.py embed --kind <kind>').toEqual([])
  })
})
