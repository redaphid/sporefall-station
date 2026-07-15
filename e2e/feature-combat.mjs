// #50 backfill — COMBAT / DEATH, exact world state.
// Injects the committed `combat-stage` snapshot (three frozen-in-place thugs down
// the pistol lane, hp 24 each) via `?world=`, then replays the proven `shooting`
// input timeline. Real systems only. Adversarial post-run assertions: every thug
// the fixture pinned is gone (killed + swept), the player survived, no game over.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const thugIds = fixture.entities.filter((e) => e.archetype === 'thug').map((e) => e.id)
if (thugIds.length !== 3) throw new Error(`combat-stage fixture should pin 3 thugs, has ${thugIds.length}`)

await recordFeature({
  name: 'feature-combat',
  world: 'combat-stage',
  script: 'shooting',
  stills: [
    { tick: 20, label: '01-injected' },
    { tick: 210, label: '02-take-aim' },
    { tick: 260, label: '03-opening-fire' },
    { tick: 320, label: '04-bullets-flying' },
    { tick: 380, label: '05-cleared' },
  ],
  readState: () => {
    const w = window.__world
    const pl = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      gameOver: w.gameOver,
      ids: w.entities.map((e) => e.id),
      thugsAlive: w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length,
      playerHp: pl?.health?.hp ?? null,
      playerDowned: !!pl?.playerCtl?.downed,
    }
  },
  expect: (s) => [
    s.thugsAlive !== 0 && `${s.thugsAlive} thug(s) left standing`,
    thugIds.some((id) => s.ids.includes(id)) && `pinned thug ids survived: ${thugIds.filter((id) => s.ids.includes(id))}`,
    (s.playerHp ?? 0) <= 0 && `player died (hp ${s.playerHp})`,
    s.playerDowned && 'player was downed',
    s.gameOver && 'unexpected game over',
  ],
})
