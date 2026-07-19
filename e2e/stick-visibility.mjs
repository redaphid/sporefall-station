// Adaptive touch-controls visibility, proven against the REAL app (main.ts
// wiring: detectTouchCaps + the gamepad coop pipeline + the passive touch
// listener — not a bundled harness):
//   1. desktop context (no touch)  → the touch layer is never even created
//   2. phone context               → controls visible at boot
//   3. fake pad press-to-joins     → controls vanish (display:none, hit-inert)
//   4. a finger taps the screen    → controls return (couch handover)
//   5. the pad moves its stick     → controls vanish again
//   6. every pad unplugs           → controls return (boot default)
// Screenshots per state + an mp4 of the phone run. Fails loudly on any miss.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4941'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
mkdirSync(OUT, { recursive: true })

const URL = `${BASE}/?mode=solo&e2e&seed=7`
const SEL = '[data-role="touch-controls"]'
let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}

/** A fake standard-mapping Gamepad the coop pipeline reads via its normal
 * navigator.getGamepads() poll. Installed before the app boots. */
const FAKE_PAD_RIG = `
  window.__pads = []
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads })
  window.__mkPad = () => ({
    index: 0, id: 'Backseat Fake Pad (STANDARD GAMEPAD)', mapping: 'standard', connected: true,
    timestamp: 0, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  })
  window.__padConnect = () => { window.__pads = [window.__mkPad()] }
  window.__padDisconnect = () => { window.__pads = [] }
  window.__padPress = (i, on) => { window.__pads[0].buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 } }
  window.__padAxis = (i, v) => { window.__pads[0].axes[i] = v }
`

const controlsDisplay = (page) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el).display : null
  }, SEL)

const waitDisplay = async (page, want, what) => {
  try {
    await page.waitForFunction(
      ([sel, w]) => {
        const el = document.querySelector(sel)
        return (el ? getComputedStyle(el).display : null) === w
      },
      [SEL, want],
      { timeout: 4000 },
    )
    check(true, what)
  } catch {
    check(false, `${what} (still ${await controlsDisplay(page)})`)
  }
}

const shot = async (page, name) => {
  const p = join(OUT, `stick-visibility-${name}.png`)
  await page.screenshot({ path: p })
  console.log(`shot  ${p}`)
}

const browser = await chromium.launch({ headless: true })

// ---- 1. desktop: no touch capability → the touch layer must not exist ----
{
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } })
  const page = await context.newPage()
  await page.goto(URL)
  await page.waitForSelector('canvas', { timeout: 15000 })
  await page.waitForTimeout(1200)
  const caps = await page.evaluate(() => ({
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
  }))
  console.log(`desktop caps: ${JSON.stringify(caps)}`)
  check(caps.maxTouchPoints === 0, 'desktop context reports no touch points')
  check((await controlsDisplay(page)) === null, 'desktop: touch controls are never created')
  await shot(page, '1-desktop-no-sticks')
  await context.close()
}

// ---- 2..6 phone: the full takeover / handover dance, recorded ----
const VP = { width: 892, height: 412 }
const videoDir = join(OUT, 'video-stick-visibility')
rmSync(videoDir, { recursive: true, force: true })
{
  const context = await browser.newContext({
    viewport: VP,
    hasTouch: true,
    isMobile: true,
    recordVideo: { dir: videoDir, size: VP },
  })
  const page = await context.newPage()
  await page.addInitScript(FAKE_PAD_RIG)
  await page.goto(URL)
  await page.waitForSelector('canvas', { timeout: 15000 })
  const caps = await page.evaluate(() => ({
    maxTouchPoints: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches,
  }))
  console.log(`phone caps: ${JSON.stringify(caps)}`)
  check(caps.maxTouchPoints > 0, 'phone context reports touch points')
  check(caps.coarse, 'phone context reports a coarse primary pointer')

  // 2. boot: controls visible (coarse primary → phone default)
  await waitDisplay(page, 'block', 'phone boot: touch controls visible')
  await page.waitForTimeout(700)
  await shot(page, '2-touch-sticks-visible')

  // 3. a pad connects and press-to-joins (face button) → controls vanish
  await page.evaluate(() => {
    window.__padConnect()
    window.__padPress(0, true)
  })
  await waitDisplay(page, 'none', 'pad join press: touch controls hidden')
  await page.evaluate(() => window.__padPress(0, false))
  await page.waitForTimeout(700)
  // …and they STAY hidden while the joined pad merely idles.
  check((await controlsDisplay(page)) === 'none', 'pad idle-in-slot: controls stay hidden (no flicker)')
  await shot(page, '3-pad-joined-hidden')

  // 4. a finger touches the screen → couch handover, controls return
  await page.touchscreen.tap(220, 200)
  await waitDisplay(page, 'block', 'screen touch: controls re-shown while pad idles')
  await page.waitForTimeout(700)
  await shot(page, '4-touch-reclaims-visible')

  // 5. the pad produces input again (stick deflection) → hidden again
  await page.evaluate(() => window.__padAxis(0, 1))
  await waitDisplay(page, 'none', 'pad stick input: controls hidden again')
  await page.evaluate(() => window.__padAxis(0, 0))
  await page.waitForTimeout(700)
  await shot(page, '5-pad-input-hidden')

  // 6. the pad unplugs → boot default (phone: visible) restores
  await page.evaluate(() => window.__padDisconnect())
  await waitDisplay(page, 'block', 'pad unplugged: controls restored')
  await page.waitForTimeout(700)
  await shot(page, '6-pad-unplugged-restored')

  await page.close()
  await context.close()
}
await browser.close()

// package the phone video as mp4
const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
if (webm) {
  const mp4 = join(OUT, 'stick-visibility.mp4')
  execFileSync('ffmpeg', ['-y', '-i', join(videoDir, webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-vf', `scale=${VP.width}:${VP.height}`, '-movflags', '+faststart', mp4], { stdio: 'ignore' })
  console.log(`video ${mp4} (${(statSync(mp4).size / 1024).toFixed(0)} KB)`)
}
rmSync(videoDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`stick-visibility: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('stick-visibility: all checks passed')
