// #50 backfill — COMBAT / DEATH, exact world state.
// Injects the committed `combat-stage` snapshot (three frozen-in-place mutants down
// the pistol lane, hp 24 each) via `?world=`, then replays the proven `shooting`
// input timeline. Real systems only. Adversarial post-run assertions: every mutant
// the fixture pinned is gone (killed + swept), the player survived, no game over.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const mutantIds = fixture.entities.filter((e) => e.archetype === 'mutant').map((e) => e.id)
if (mutantIds.length !== 3) throw new Error(`combat-stage fixture should pin 3 mutants, has ${mutantIds.length}`)

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
      mutantsAlive: w.entities.filter((e) => e.archetype === 'mutant' && !e.dead).length,
      playerHp: pl?.health?.hp ?? null,
      playerDowned: !!pl?.playerCtl?.downed,
    }
  },
  expect: (s) => [
    s.mutantsAlive !== 0 && `${s.mutantsAlive} mutant(s) left standing`,
    mutantIds.some((id) => s.ids.includes(id)) && `pinned mutant ids survived: ${mutantIds.filter((id) => s.ids.includes(id))}`,
    (s.playerHp ?? 0) <= 0 && `player died (hp ${s.playerHp})`,
    s.playerDowned && 'player was downed',
    s.gameOver && 'unexpected game over',
  ],
})
