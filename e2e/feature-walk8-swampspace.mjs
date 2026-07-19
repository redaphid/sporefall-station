// fix/character-consistency — the vine-ranger walking a full compass circle in
// the swampspace theme. Same stage/timeline as feature-walk8.mjs, but with
// ?theme=swampspace so every still shows the regenerated ranger frames: the
// five drawn directions (s/se/e/ne/n) plus the three mirrored west poses. The
// point of the artifact set is IDENTITY — every facing must read as the same
// character (proportions, teal suit, amber visor), which is what the
// consistency harness (scripts/assets/consistency.py) pins numerically.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage with only the player, centred in the open park at (10,11). */
const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 10, y: 11 }
  p.prevPos = { x: 10, y: 11 }
  p.facing = Math.PI / 2 // start facing s (toward camera)
  p.health.hp = p.health.max
  w.entities = [p]
  return w
}

// walk8 timeline: 20 settle, then 8 × (14 move + 70 hold); stills land at the
// start of each hold (see feature-walk8.mjs for the tick math).
const stills = [
  { tick: 10, label: '00-idle-s' },
  { tick: 44, label: '01-e' },
  { tick: 128, label: '02-se' },
  { tick: 212, label: '03-s' },
  { tick: 296, label: '04-sw' },
  { tick: 380, label: '05-w' },
  { tick: 464, label: '06-nw' },
  { tick: 548, label: '07-n' },
  { tick: 632, label: '08-ne' },
]

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    pos: pl ? { x: pl.pos.x, y: pl.pos.y } : null,
    facing: pl?.facing ?? null,
    hp: pl?.health?.hp ?? null,
    max: pl?.health?.max ?? null,
    downed: !!pl?.playerCtl?.downed,
  }
}

await recordFeature({
  name: 'char-consistency-walk8-swampspace',
  world: stage(),
  script: 'walk8',
  params: { zoom: 2, theme: 'swampspace' },
  stills,
  readState,
  expect: (s) => [
    s.tick < 692 && `script did not finish (tick ${s.tick} < 692)`,
    s.pos === null && 'player missing from world',
    s.pos && Math.hypot(s.pos.x - 10, s.pos.y - 11) > 1 && `player drifted: ended at ${JSON.stringify(s.pos)}`,
    s.facing !== 0 && `post-script facing ${s.facing} ≠ 0 (did the script run?)`,
    s.hp !== s.max && `player took damage on an empty stage (${s.hp}/${s.max})`,
    s.downed && 'player downed on an empty stage',
  ],
})
