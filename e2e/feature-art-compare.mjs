// Hero-art review recorder (art-cn1): drives the deterministic `artcompare`
// script over the seed-7 / floor-1 combat-stage — the vine-ranger idles facing
// the camera, walks a full compass circle showing every drawn facing, then
// marches east into the frozen thug line and swings a bat (the combat beat).
// One run captures idle + all 8 facings + combat, so the owner can A/B the hero
// across builds at IDENTICAL on-screen framing:
//   A) shipped engine (CHAR_PX 48) at zoom 2  -> 48px hero drawn 96px on screen
//   B) hi-res engine  (CHAR_PX 96) at zoom 1  -> 96px native hero, same framing
// Same seed, same 20-tile viewport, so it isolates the pure aesthetic diff.
//
// Env: ART_ZOOM (default 2), ART_NAME (default feature-art-compare), E2E_OUT.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const ZOOM = Number(process.env.ART_ZOOM ?? 2)
const NAME = process.env.ART_NAME ?? 'feature-art-compare'
const THEME = process.env.ART_THEME ?? 'swampspace'

// combat-stage (seed 7, floor 1, hostile:false): the vine-ranger on the lane at
// x8 facing the camera, keeping the fixture's 200-round pistol, high HP so the
// combat beat never downs them; the three guard thugs (x12/15/18, frozen) stay
// as targets the pistol fires into at the end of the run.
const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 8, y: 11 }
  p.prevPos = { x: 8, y: 11 }
  p.facing = Math.PI / 2 // idle facing south (toward camera)
  p.health = { hp: 500, max: 500, iframes: 0 }
  return w
}

// Still ticks land ~10 ticks into each 90-tick hold; screenshot capture lags
// the sim ~60 ticks under video recording, so each shot falls mid-hold.
const stills = [
  { tick: 20, label: '01-idle-south' },
  { tick: 114, label: '02-east' },
  { tick: 218, label: '03-southeast' },
  { tick: 322, label: '04-south' },
  { tick: 426, label: '05-southwest' },
  { tick: 530, label: '06-west' },
  { tick: 634, label: '07-northwest' },
  { tick: 738, label: '08-north' },
  { tick: 842, label: '09-northeast' },
  { tick: 1020, label: '10-combat' },
]

const readState = () => {
  const w = window.__world
  const p = w.entities.find((e) => e.playerCtl)
  const thugs = w.entities.filter((e) => e.archetype === 'thug')
  return {
    tick: w.tick,
    gameOver: w.gameOver,
    playerHp: p?.health?.hp ?? null,
    playerFacing: p?.facing ?? null,
    thugsAlive: thugs.filter((e) => !e.dead).length,
    thugHpMin: thugs.length ? Math.min(...thugs.map((e) => e.health?.hp ?? 0)) : null,
  }
}

const ok = await recordFeature({
  name: NAME,
  world: stage(),
  script: 'artcompare',
  params: { zoom: ZOOM, theme: THEME },
  stills,
  readState,
  expect: (s) => [
    s.gameOver && 'unexpected game over',
    s.playerHp !== null && s.playerHp <= 0 && 'player died during the showcase',
    s.thugHpMin !== null && s.thugHpMin >= 24 && 'no thug was hit by the pistol',
  ],
})
if (!ok) process.exitCode = 1
