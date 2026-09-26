// Reorder the wand with ONE input at a time, in a real page (headless Chromium,
// Lane B: the DOM HUD renders, the world canvas does not).
//
//   touch — a phone-sized touch context: tap two HUD chips during play, then
//           ⏸, tap two chips in the pause strip, Resume.
//   pad   — no touch, no mouse, no keyboard: a scripted standard gamepad
//           (navigator.getGamepads) joins, pauses with Start, walks the pause
//           strip with the d-pad, taps two chips with A, resumes with Start.
//
// Each run asserts on the REAL sim list (window.world), before and after, and
// on the pause strip's preview while the sim is stopped.
//
//   BASE_URL=http://127.0.0.1:4990 node e2e/reorder-inputs.mjs
// (serve the build first: .claude/skills/verify-sporefall/scripts/serve.sh start 4990)

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4990'
const OUT = join(process.env.E2E_OUT ?? 'e2e/output', 'reorder-inputs')
mkdirSync(OUT, { recursive: true })
const URL = `${BASE}/?mode=solo&seed=18&scenario=armed&floor=3`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The local player's live mod order, straight off the sim. */
const simOrder = () => {
  const p = window.world.entities.find((e) => e.playerCtl?.playerId === 0)
  return p.loadout.inventory.find((s) => s.itemId === p.combat.weapon).mods.map((m) => m.id)
}
/** Chip names drawn by a strip: the HUD's (first) or the pause menu's (last). */
const stripNames = (which) => {
  const strips = document.querySelectorAll('[data-role="mod-sequence"]')
  const strip = which === 'hud' ? strips[0] : strips[strips.length - 1]
  return [...strip.querySelectorAll('button[data-i]')].map((b) => b.title.split(' (')[0])
}
const paused = () => {
  const strips = document.querySelectorAll('[data-role="mod-sequence"]')
  return strips.length > 1 && strips[strips.length - 1].offsetParent !== null
}

const until = async (page, what, fn, arg, ms = 20000) => {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => undefined)
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

const boot = async (context) => {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(URL, { waitUntil: 'commit' })
  await until(page, 'the armed run', () => window.world?.tick > 30 && document.querySelectorAll('[data-role="mod-sequence"] button[data-i]').length === 5)
  const start = await page.evaluate(simOrder)
  const hud = await page.evaluate(stripNames, 'hud')
  const idOf = Object.fromEntries(hud.map((name, i) => [name, start[i]]))
  /** The pause strip's preview, as mod ids. */
  const preview = async () => (await page.evaluate(stripNames, 'pause')).map((name) => idOf[name])
  return { page, errors, start, bootErrors: [...errors], preview }
}

const touchRun = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const { page, errors, start, bootErrors, preview } = await boot(context)
  const r = { input: 'touch', maxTouchPoints: await page.evaluate(() => navigator.maxTouchPoints), bootErrors, start }
  const hud = page.locator('[data-role="mod-sequence"]').first()
  await hud.locator('button[data-i="0"]').tap()
  await hud.locator('button[data-i="1"]').tap()
  await sleep(300)
  r.afterHudTaps = await page.evaluate(simOrder)
  await page.locator('[data-role="pause-button"]').tap()
  await until(page, 'the pause menu', paused)
  const strip = page.locator('[data-role="mod-sequence"]').last()
  await strip.locator('button[data-i="2"]').tap()
  await strip.locator('button[data-i="4"]').tap()
  await sleep(500)
  r.pausedPreview = await preview()
  r.pausedSim = await page.evaluate(simOrder)
  await page.screenshot({ path: join(OUT, 'touch-paused-preview.png') })
  await page.getByRole('button', { name: 'Resume' }).tap()
  await sleep(400)
  r.afterResume = await page.evaluate(simOrder)
  r.errors = errors
  await context.close()
  return r
}

/** A standard-mapping gamepad whose buttons the test holds and releases. */
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

const padRun = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: false })
  await context.addInitScript(FAKE_PAD)
  const { page, errors, start, bootErrors, preview } = await boot(context)
  const press = async (button) => {
    await page.evaluate((b) => window.__pad.press(b), button)
    await sleep(120)
    await page.evaluate((b) => window.__pad.release(b), button)
    await sleep(120)
  }
  const A = 0
  const START = 9
  const RIGHT = 15
  const r = { input: 'gamepad', bootErrors, start }
  await press(A) // any input joins the pad (it lands on the local player's slot)
  await press(START)
  await until(page, 'the pause menu', paused)
  r.pausedBy = 'Start'
  await sleep(200)
  await press(RIGHT)
  await press(A) // pick chip 1
  await press(RIGHT)
  await press(RIGHT)
  await press(A) // tap chip 3: swap 1 and 3
  await sleep(300)
  r.pausedPreview = await preview()
  r.pausedSim = await page.evaluate(simOrder)
  await page.screenshot({ path: join(OUT, 'pad-paused-preview.png') })
  await press(START)
  await until(page, 'the run to resume', () => !document.querySelectorAll('[data-role="mod-sequence"]')[1] || document.querySelectorAll('[data-role="mod-sequence"]')[1].offsetParent === null)
  await sleep(300)
  r.afterResume = await page.evaluate(simOrder)
  r.errors = errors
  await context.close()
  return r
}

const swap = (xs, a, b) => {
  const out = [...xs]
  ;[out[a], out[b]] = [out[b], out[a]]
  return out
}

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-software-rasterizer'] })
const touch = await touchRun(browser)
const pad = await padRun(browser)
await browser.close()

const checks = [
  ['touch: two HUD taps swap the sim list', JSON.stringify(touch.afterHudTaps) === JSON.stringify(swap(touch.start, 0, 1))],
  ['touch: the pause strip previews the swap', JSON.stringify(touch.pausedPreview) === JSON.stringify(swap(touch.afterHudTaps, 2, 4))],
  ['touch: the paused sim is untouched', JSON.stringify(touch.pausedSim) === JSON.stringify(touch.afterHudTaps)],
  ['touch: Resume applies the queued swap', JSON.stringify(touch.afterResume) === JSON.stringify(touch.pausedPreview)],
  ['pad: the pause strip previews the swap', JSON.stringify(pad.pausedPreview) === JSON.stringify(swap(pad.start, 1, 3))],
  ['pad: the paused sim is untouched', JSON.stringify(pad.pausedSim) === JSON.stringify(pad.start)],
  ['pad: Start resumes and applies the queued swap', JSON.stringify(pad.afterResume) === JSON.stringify(pad.pausedPreview)],
  // Headless WSL Chromium has no WebGL, so the renderer may throw at boot
  // before any input; only an error raised after that counts against the run.
  ['no page errors after boot', touch.errors.length === touch.bootErrors.length && pad.errors.length === pad.bootErrors.length],
]
const report = { url: URL, touch, pad, checks: Object.fromEntries(checks) }
writeFileSync(join(OUT, 'run.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
const failed = checks.filter(([, ok]) => !ok)
for (const [what] of failed) console.error(`FAIL: ${what}`)
process.exitCode = failed.length ? 1 : 0
