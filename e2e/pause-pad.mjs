// The pause menu with a controller alone (#125), in a real page. A scripted
// standard gamepad joins, pauses with Start, and walks the menu: the cursor
// opens on Resume, Right walks the actions, one A only arms New Seed, Up climbs
// to the wand strip, and B resumes. A held Enter only arms New Seed or Run it
// back. Main menu takes two A presses and lands on a fresh start menu, and a new
// run from there ticks at 30 Hz. Screenshots land in e2e/output/pause-pad/.
//
//   BASE_URL=http://127.0.0.1:4990 node e2e/pause-pad.mjs
//   CDP_URL=<cdpUrl> BASE_URL=http://localhost:4990 node e2e/pause-pad.mjs
// CDP_URL drives a Chrome from `node scripts/own-chrome.mjs launch` (real GPU),
// never someone's everyday browser; :9222 is refused. The run uses a fresh
// context of its own inside it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { assertNotPersonalChrome } from '../scripts/own-chrome.mjs'

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

if (process.env.CDP_URL) assertNotPersonalChrome(process.env.CDP_URL)
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
// Keyboard: focus New Seed and HOLD Enter. Chrome autorepeats the keydown and
// each one is a click, so a held key must not count as the second press.
await press(START)
await until(page, 'the pause menu again', () => {
  const s = document.querySelectorAll('[data-role="mod-sequence"]')
  return s.length > 1 && s[s.length - 1].offsetParent !== null
})
await page.focus('[data-role="pause-new-seed"]')
await page.keyboard.down('Enter')
for (let i = 0; i < 8; i++) {
  await sleep(40)
  await page.keyboard.down('Enter') // a repeat: Playwright sets repeat=true while held
}
await page.keyboard.up('Enter')
await sleep(300)
r.heldEnter = await page.evaluate(look)
r.heldEnterLabel = await page.evaluate(() => document.querySelector('[data-role="pause-new-seed"]')?.textContent)
// The same hold on Run it back: it arms (and New Seed disarms), nothing restarts.
await page.focus('[data-role="pause-run-it-back"]')
await page.keyboard.down('Enter')
for (let i = 0; i < 8; i++) {
  await sleep(40)
  await page.keyboard.down('Enter')
}
await page.keyboard.up('Enter')
await sleep(300)
r.heldEnterRb = await page.evaluate(look)
r.heldEnterRbLabels = await page.evaluate(() => ({
  runItBack: document.querySelector('[data-role="pause-run-it-back"]')?.textContent,
  newSeed: document.querySelector('[data-role="pause-new-seed"]')?.textContent,
}))
await shot('4-run-it-back-armed')
// Main menu: one A arms it, the second quits. The page must land on a fresh
// start menu with the deep-link params gone and no world left running, and a
// new run from there must tick at the normal 30 Hz.
await press(RIGHT)
r.onMainMenu = await page.evaluate(look)
await press(A)
await sleep(200)
r.mainMenuArmed = await page.evaluate(() => ({
  label: document.querySelector('[data-role="pause-main-menu"]')?.textContent,
  paused: document.querySelectorAll('[data-role="mod-sequence"]').length > 1,
}))
await shot('5-main-menu-armed')
await page.evaluate(() => (window.__oldPage = true))
await press(A)
await until(page, 'the start menu', () => !window.__oldPage && document.querySelector('[data-role="start-menu"]') !== null)
await sleep(1000)
r.menu = await page.evaluate(() => ({ search: location.search, world: window.world === undefined, startMenu: !!document.querySelector('[data-role="start-menu"]') }))
await shot('6-back-at-start-menu')
await page.click('[data-role="start-menu"] button.sf-start__btn')
await until(page, 'a new run', () => window.world?.tick > 10)
const t0 = await page.evaluate(() => window.world.tick)
await sleep(2000)
r.newRunTicksIn2s = (await page.evaluate(() => window.world.tick)) - t0
// Headless WSL Chromium has no WebGL, and pixi throws this whenever it gets to
// it; on a real GPU (CDP_URL) every page error counts.
const NO_WEBGL = /reading 'updateRenderable'/
r.errors = errors.slice(bootErrors).filter((e) => process.env.CDP_URL || !NO_WEBGL.test(e))
await context.close()
if (process.env.CDP_URL) await browser.close().catch(() => {})
else await browser.close()

const quitArmed =
  JSON.stringify(r.onMainMenu.rings) === '["Main menu"]' && r.mainMenuArmed.label === 'Quit to the menu? Press again' && r.mainMenuArmed.paused
const checks = [
  ['Start opens the menu with one cursor, on Resume', r.opened.paused && JSON.stringify(r.opened.rings) === '["Resume"]'],
  ['Right moves the cursor to New Seed', JSON.stringify(r.onNewSeed.rings) === '["🎲 New Seed"]'],
  ['one A arms New Seed and keeps the run', r.armed.paused && r.armed.seed === r.opened.seed && r.armedLabel === '🎲 Wipe this run? Press again'],
  ['Up climbs to the wand strip', r.strip.rings.length === 1 && r.strip.rings[0].startsWith('chip:')],
  ['B resumes the same run', !r.resumed.paused && r.resumed.seed === r.opened.seed && r.resumed.tick > r.strip.tick],
  ['held Enter on New Seed only arms it', r.heldEnter.paused && r.heldEnter.seed === r.opened.seed && r.heldEnterLabel === '🎲 Wipe this run? Press again'],
  [
    'held Enter on Run it back only arms it, and disarms New Seed',
    r.heldEnterRb.paused &&
      r.heldEnterRb.tick === r.heldEnter.tick &&
      r.heldEnterRbLabels.runItBack === 'Restart this run? Press again' &&
      r.heldEnterRbLabels.newSeed === '🎲 New Seed',
  ],
  ['Right reaches Main menu, and one A only arms it', quitArmed],
  // Refresh also lands on the picker, so these count only when Main menu did it.
  ['the second A lands on a fresh start menu with no deep-link params and no world', quitArmed && r.menu.search === '' && r.menu.world && r.menu.startMenu],
  ['a new run from the menu ticks at 30 Hz (no leaked loop)', quitArmed && r.newRunTicksIn2s >= 45 && r.newRunTicksIn2s <= 75],
  ['no page errors after boot', r.errors.length === 0],
]
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ r, checks }, null, 2))
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(JSON.stringify(r))
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
