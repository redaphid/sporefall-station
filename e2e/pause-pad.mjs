// The pause menu with a controller alone (#125), in a real page. A scripted
// standard gamepad joins, pauses with Start, and walks the menu: the cursor
// opens on Resume, Right walks the actions, one A only arms New Seed, Up climbs
// to the wand strip, and B resumes. Screenshots land in e2e/output/pause-pad/.
//
//   BASE_URL=http://127.0.0.1:4990 node e2e/pause-pad.mjs
//   CDP_URL=http://localhost:9222 BASE_URL=http://localhost:4990 node e2e/pause-pad.mjs
// CDP_URL drives an existing Chrome (real GPU) in a fresh context of its own.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4990'
const OUT = join(process.env.E2E_OUT ?? 'e2e/output', 'pause-pad')
mkdirSync(OUT, { recursive: true })
const URL = `${BASE}/?mode=solo&seed=18&scenario=armed&floor=3`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const A = 0
const B = 1
const START = 9
const UP = 12
const RIGHT = 15

const FAKE_PAD = () => {
  const held = new Set()
  window.__pad = { press: (i) => held.add(i), release: (i) => held.delete(i) }
  const snapshot = () => ({
    id: 'Scripted pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: performance.now(),
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.has(i), touched: held.has(i), value: held.has(i) ? 1 : 0 })),
  })
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [snapshot(), null, null, null] })
}

/** What a player sees: is the menu up, which control holds the cursor, the seed. */
const look = () => {
  const strips = document.querySelectorAll('[data-role="mod-sequence"]')
  const pauseStrip = strips[strips.length - 1]
  const ring = [...document.querySelectorAll('button')].filter((b) => b.style.boxShadow.includes('3px'))
  return {
    paused: strips.length > 1 && pauseStrip.offsetParent !== null,
    rings: ring.map((b) => (b.closest('[data-role="mod-sequence"]') ? `chip:${b.title.split(' (')[0]}` : b.textContent)),
    seed: window.world?.seed,
    tick: window.world?.tick,
  }
}

const until = async (page, what, fn, ms = 20000) => {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn).catch(() => undefined)
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const browser = process.env.CDP_URL
  ? await chromium.connectOverCDP(process.env.CDP_URL)
  : await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-software-rasterizer'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
await context.addInitScript(FAKE_PAD)
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(URL, { waitUntil: 'commit' })
await until(page, 'the armed run', () => window.world?.tick > 30 && document.querySelectorAll('[data-role="mod-sequence"] button[data-i]').length > 0)
const bootErrors = errors.length

const press = async (button) => {
  await page.evaluate((b) => window.__pad.press(b), button)
  await sleep(150)
  await page.evaluate((b) => window.__pad.release(b), button)
  await sleep(150)
}
const shot = (name) => page.screenshot({ path: join(OUT, `${name}.png`) })

const r = {}
await press(A) // the first press joins the pad
await press(START)
await until(page, 'the pause menu', () => {
  const s = document.querySelectorAll('[data-role="mod-sequence"]')
  return s.length > 1 && s[s.length - 1].offsetParent !== null
})
await sleep(200)
r.opened = await page.evaluate(look)
await shot('1-opens-on-resume')
await press(RIGHT)
r.onNewSeed = await page.evaluate(look)
await press(A)
await sleep(200)
r.armed = await page.evaluate(look)
r.armedLabel = await page.evaluate(() => document.querySelector('[data-role="pause-new-seed"]')?.textContent)
await shot('2-new-seed-armed')
await press(UP)
r.strip = await page.evaluate(look)
await shot('3-up-to-strip')
await press(B)
await sleep(400)
r.resumed = await page.evaluate(look)
r.errors = errors.slice(bootErrors)
await context.close()
if (process.env.CDP_URL) await browser.close().catch(() => {})
else await browser.close()

const checks = [
  ['Start opens the menu with one cursor, on Resume', r.opened.paused && JSON.stringify(r.opened.rings) === '["Resume"]'],
  ['Right moves the cursor to New Seed', JSON.stringify(r.onNewSeed.rings) === '["🎲 New Seed"]'],
  ['one A arms New Seed and keeps the run', r.armed.paused && r.armed.seed === r.opened.seed && r.armedLabel === '🎲 Wipe this run? Press again'],
  ['Up climbs to the wand strip', r.strip.rings.length === 1 && r.strip.rings[0].startsWith('chip:')],
  ['B resumes the same run', !r.resumed.paused && r.resumed.seed === r.opened.seed && r.resumed.tick > r.strip.tick],
  ['no page errors after boot', r.errors.length === 0],
]
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ r, checks }, null, 2))
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(JSON.stringify(r))
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
