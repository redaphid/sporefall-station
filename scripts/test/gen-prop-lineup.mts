// The prop-art lineup: one of EVERY furnishing archetype the game places,
// stood on a clean floor in two labelled bands — the ones wearing real pack
// art, and the ones drawn as hand-coded engine vectors. Rendered by the real
// engine so the picture is what the player actually sees, at game scale.
//
//   pnpm exec tsx scripts/test/gen-prop-lineup.mts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnPlayer } from '../../src/game/player'
import { spawnObject } from '../../src/game/systems/objects'
import { serializeWorld } from '../../src/game/serialize'
import { Tile } from '../../src/game/levelgen/level'
import { createWorld } from '../../src/game/world'
import type { Annotation } from '../../src/game/types'

const OUT = process.argv[2] ?? 'e2e/output/prop-lineup'
mkdirSync(OUT, { recursive: true })

// Ordered by how often the census says the player meets them.
const WITH_ART: [string, string][] = [
  ['crate', 'cargo-crate'], ['cabinet', 'supply-cabinet'], ['barrel', 'spore-barrel'],
  ['desk', 'work-desk'], ['tv', 'wall-screen'], ['vending', 'nutrient-dispenser'],
  ['locker', 'weapons-locker'], ['toilet', 'hydro-recycler'], ['atm', 'cryo-terminal'],
]
const NO_ART: [string, string][] = [
  ['shelf', '20.8/floor'], ['chair', '13.1/floor'], ['bunk', '7.9/floor'],
  ['plant', '5.6/floor'], ['bench', '4.8/floor'], ['table', '2.8/floor'],
  ['sporeNode', '0.2/floor'],
]

const w = createWorld(7, 1)
// Strip the generated population: this is a lineup, not a level.
w.entities = []
w.byId = new Map()
w.nextId = 1

// Find a naturally open rect — the level checksum guard forbids carving tiles,
// and it is right to: the level must regenerate from seed+floor byte-identically.
const COLS = Math.max(WITH_ART.length, NO_ART.length)
const NEED_W = COLS * 3 + 2
const NEED_H = 16
const findOpen = (): { x: number; y: number } => {
  const L = w.level
  for (let y = 1; y < L.h - NEED_H - 1; y++)
    for (let x = 1; x < L.w - NEED_W - 1; x++) {
      let ok = true
      for (let j = 0; j < NEED_H && ok; j++)
        for (let i = 0; i < NEED_W; i++) if (L.solid[(y + j) * L.w + (x + i)]) { ok = false; break }
      if (ok) return { x, y }
    }
  throw new Error('no open rect for the lineup')
}
const { x: X0, y: Y0 } = findOpen()

const notes: Annotation[] = []
const band = (list: [string, string][], row: number, title: string, color: string): void => {
  notes.push({ id: 0, kind: 'label', x: X0 + (COLS * 3) / 2, y: row - 2.1, text: title, color })
  list.forEach(([arch, sub], i) => {
    const x = X0 + i * 3 + 1
    spawnObject(w, arch, x, row)
    notes.push({ id: 0, kind: 'label', x: x + 0.5, y: row - 0.9, text: arch, color })
    notes.push({ id: 0, kind: 'label', x: x + 0.5, y: row + 1.75, text: sub, color: '#9aa5b1' })
  })
}

band(WITH_ART, Y0 + 4, 'HAS PACK ART', '#8aff8a')
band(NO_ART, Y0 + 12, 'NO ART - ENGINE VECTOR PLACEHOLDER', '#ff6b6b')

// Player parked off to the side; the camera follows it, so this frames the lineup.
spawnPlayer(w, 0, X0 + (COLS * 3) / 2, Y0 + 8)

w.annotations = notes.map((n, i) => ({ ...n, id: `lineup-${i}` }))
writeFileSync(join(OUT, 'prop-lineup.json'), JSON.stringify(serializeWorld(w)))
console.log(`lineup @ (${X0},${Y0}): ${WITH_ART.length} textured + ${NO_ART.length} vector, ${notes.length} labels -> ${OUT}/prop-lineup.json`)
