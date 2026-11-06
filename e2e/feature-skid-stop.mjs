// #175 skid to a stop: a character that stops dead from a run leans back
// against it and kicks dust forward from its feet (display only).
//
// Stage: combat-stage, the player alone on the open lot west of the walled
// block at (30, 9), running each of the eight directions (the walk8 script:
// 14 ticks of run, 70 ticks of rest, eight times). Every leg ends in a skid.
//
// Two passes over the same deterministic run:
//   1. `record()`: the live video (the clip).
//   2. A stepped pass: the sim advances one tick per screenshot, so every tick
//      of every skid is on file for the 4x frame strip.
//
// Env: BASE_URL (served dist), E2E_OUT, SKID_STEP_OUT (stepped frames dir).
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BASE, OUT, record } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const STEP_OUT = process.env.SKID_STEP_OUT ?? join(OUT, 'skid-stop-steps')
const PLAYER = { x: 30, y: 9 }
const TOTAL = Number(process.env.SKID_TOTAL ?? 20 + 8 * 84)

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { ...PLAYER }
  p.prevPos = { ...PLAYER }
  w.entities = [p]
  return w
}

const params = { mode: 'solo', e2e: '1', world: '@inline', script: 'walk8' }
const load = async (page) => {
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate((j) => window.__loadWorld(j), stage())
}
const readState = () => {
  const p = window.__world.entities.find((e) => e.playerCtl)
  return { tick: window.__world.tick, x: p.pos.x, y: p.pos.y }
}

const ok = await record({
  name: 'skid-stop',
  params,
  beforeTicks: load,
  stills: [
    { tick: 36, label: 'e-skid' },
    { tick: 120, label: 'se-skid' },
    { tick: 456, label: 'nw-skid' },
  ],
  readState,
  // walk8 returns to where it started, give or take a few hundredths.
  expect: (s) => [Math.hypot(s.x - PLAYER.x, s.y - PLAYER.y) > 0.5 && `player ended at (${s.x}, ${s.y})`].filter(Boolean),
})

mkdirSync(STEP_OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?${new URLSearchParams(params)}`, { waitUntil: 'networkidle' })
await load(page)
await page.waitForFunction(() => window.__sporefall !== undefined, { timeout: 20000 })
await page.evaluate(() => {
  const s = window.__sporefall
  const orig = s.tick.bind(s)
  window.__go = 0
  s.tick = () => {
    if (window.__go <= 0) return
    window.__go--
    orig()
  }
})
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const pos = []
for (let t = await page.evaluate(() => window.__world.tick); t < TOTAL; ) {
  await page.evaluate(() => (window.__go = 1))
  await page.waitForFunction((t0) => window.__world.tick > t0, t, { timeout: 10000 })
  const s = await page.evaluate(readState)
  t = s.tick
  pos.push(s)
  await frame()
  await page.screenshot({ path: join(STEP_OUT, `t${String(t).padStart(4, '0')}.png`) })
}
await browser.close()
console.log(`[skid-stop] stepped frames in ${STEP_OUT}; final ${JSON.stringify(pos.at(-1))}`)
if (errs.length) {
  for (const e of errs) console.error(`[skid-stop] FAIL: ${e}`)
  process.exitCode = 1
}
if (!ok) process.exitCode = 1
