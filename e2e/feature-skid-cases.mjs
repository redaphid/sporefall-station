// #175 skid to a stop: the edge cases, driven by real keyboard and mouse input
// one sim tick at a time (no ?script: the script table cannot aim apart from
// the move direction).
//
//   A  run east 1 s, release            -> lean back + dust
//   B  run east 1 s, attack on release  -> no lean (an attack cancels the skid)
//   C  aim north with the mouse, run east 1 s, release (aimwalk sideways)
//      -> the lean follows the RUN, not the facing; the held weapon follows it
//
// Every tick is screenshotted to SKID_CASES_OUT for the 4x/8x strips.
// Env: BASE_URL (served dist), SKID_CASES_OUT.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BASE, OUT } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const STEP_OUT = process.env.SKID_CASES_OUT ?? join(OUT, 'skid-cases-steps')
const PLAYER = { x: 26, y: 9 }

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { ...PLAYER }
  p.prevPos = { ...PLAYER }
  w.entities = [p]
  return w
}

/** [first tick, what to do]. Keys stay down until released. */
const PLAN = [
  [10, { down: ['KeyD'] }], // A
  [40, { up: ['KeyD'] }],
  [100, { down: ['KeyD'] }], // B
  [130, { up: ['KeyD'], press: 'Space' }],
  [185, { mouse: [640, 150] }], // C: aim north
  [190, { down: ['KeyD'] }],
  [220, { up: ['KeyD'] }],
]
const TOTAL = 270

mkdirSync(STEP_OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?${new URLSearchParams({ mode: 'solo', e2e: '1', world: '@inline' })}`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
await page.evaluate((j) => window.__loadWorld(j), stage())
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
const log = []
for (let t = await page.evaluate(() => window.__world.tick); t < TOTAL; ) {
  for (const [at, act] of PLAN) {
    if (at !== t + 1) continue
    for (const k of act.up ?? []) await page.keyboard.up(k)
    for (const k of act.down ?? []) await page.keyboard.down(k)
    if (act.press) await page.keyboard.press(act.press)
    if (act.mouse) await page.mouse.move(...act.mouse)
  }
  await page.evaluate(() => (window.__go = 1))
  await page.waitForFunction((t0) => window.__world.tick > t0, t, { timeout: 10000 })
  const s = await page.evaluate(() => {
    const p = window.__world.entities.find((e) => e.playerCtl)
    return { tick: window.__world.tick, x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3), facing: +p.facing.toFixed(2) }
  })
  t = s.tick
  log.push(s)
  await frame()
  await page.screenshot({ path: join(STEP_OUT, `t${String(t).padStart(4, '0')}.png`) })
}
await browser.close()
for (const at of [40, 130, 220]) console.log(`[skid-cases] around ${at}:`, JSON.stringify(log.filter((s) => s.tick >= at - 1 && s.tick <= at + 2)))
if (errs.length) {
  for (const e of errs) console.error(`[skid-cases] FAIL: ${e}`)
  process.exitCode = 1
}
