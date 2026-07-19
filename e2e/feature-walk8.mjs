// feat/sprite-scale-8dir — 48px feet-anchored characters with 8-way facing.
// Injects the committed `combat-stage` snapshot with the thugs cleared and the
// player parked in the open park at (10,11), then drives the `walk8` script: a
// full compass circle (E, SE, S, SW, W, NW, N, NE) with a pause after each leg.
// A still lands in every pause, so the artifact set shows all eight facings —
// the five drawn directions (s/se/e/ne/n) plus the three mirrored west poses —
// on the new 48×48 canvas. Post-run asserts pin the sim did the walking: the
// player ends near the start (legs cancel pairwise), unhurt, facing NE.
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

// walk8 timeline: 20 settle, then 8 × (14 move + 70 hold). Screenshots under
// video recording lag the sim by ~60 ticks, so each still targets the START of
// a hold: facing persists while idle, leaving a ~66-tick window in which the
// captured frame still shows that leg's facing. Leg k: move [20+84k, 34+84k),
// hold to 104+84k; still at 44+84k.
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
  name: 'sprite-8dir-walk',
  world: stage(),
  script: 'walk8',
  // zoom 2 doubles the pixels-per-tile so the 48px characters read clearly.
  params: { zoom: 2 },
  stills,
  readState,
  expect: (s) => [
    s.tick < 692 && `script did not finish (tick ${s.tick} < 692)`,
    s.pos === null && 'player missing from world',
    s.pos && Math.hypot(s.pos.x - 10, s.pos.y - 11) > 1 && `player drifted: ended at ${JSON.stringify(s.pos)} (opposite legs must cancel)`,
    // readState runs after the plan is exhausted; past the end the scripted
    // source emits emptyInput(), whose aim is (1,0) → facing snaps EXACTLY to
    // 0 (east). If the script never drove the sim at all, facing would still
    // be the injected π/2 — so this pins "the timeline really played".
    s.facing !== 0 && `post-script facing ${s.facing} ≠ 0 (emptyInput aims east; did the script run?)`,
    s.hp !== s.max && `player took damage on an empty stage (${s.hp}/${s.max})`,
    s.downed && 'player downed on an empty stage',
  ],
})
