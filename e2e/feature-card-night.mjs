// Settlers playing cards: the crafted `card-night` save, played through the
// `card-night` input timeline. The player walks into the mess and watches the
// settlers take seats, deal once the chairs fill, and play; then a burst of
// fire into the east table breaks it up and the settlers run. The save is
// loaded inline with two annotation labels pinned to the tables, so the video
// says what it shows. Assertions: every settler lived, nobody was still at a
// table after the shots, and the run did not end.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const save = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/card-night.json'), 'utf8'))
const tables = save.entities.filter((e) => e.archetype === 'table')
save.annotations = tables.map((t, i) => ({
  id: `table-${i}`,
  kind: 'label',
  text: i === 0 ? 'Card table: deals once two seats fill' : 'Card table: the whole table ends together',
  x: t.pos.x,
  y: t.pos.y + 2.4,
  color: '#ffd166',
}))

await recordFeature({
  name: 'feature-card-night',
  world: save,
  script: 'card-night',
  params: { zoom: 1.8 },
  stills: [
    { tick: 90, label: '01-walking-in' },
    { tick: 330, label: '02-first-table-deals' },
    { tick: 600, label: '03-both-tables-playing' },
    { tick: 760, label: '04-shots-scatter-the-table' },
  ],
  readState: () => {
    const w = window.__world
    const settlers = w.entities.filter((e) => e.ai?.faction === 'civ' && !e.dead)
    return {
      tick: w.tick,
      settlers: settlers.length,
      atTable: settlers.filter((e) => e.ai.activity?.kind === 'cards').length,
      gameOver: w.gameOver,
    }
  },
  expect: (s) => [
    s.settlers !== 7 && `${7 - s.settlers} settlers died`,
    s.atTable > 0 && `${s.atTable} settlers still at a card table after the shots`,
    s.gameOver && 'the run ended',
  ],
})
