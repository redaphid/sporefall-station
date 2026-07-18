// Screenshot proof of the local co-op controllers overlay.
// Injects a fake 8bitdo-Zero-2-shaped gamepad (non-standard mapping, hat on
// axis 9) via a getGamepads override, presses to join, drives movement +
// attack, and captures the on-screen overlay.
// Usage: node scripts/test/controllers-overlay-shot.mjs [outDir] [baseUrl]
import { chromium } from 'playwright-core'

const BASE = process.argv[3] ?? process.env.SHOT_BASE ?? 'http://localhost:5199'
const outDir = process.argv[2] ?? 'outputs/screenshots'

// A getGamepads() shim controllable from the page via window.__setPad.
const injectFakePad = () => {
  const btn = (pressed) => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })
  const make = (over) => ({
    index: 0,
    id: '8BitDo Zero 2 gamepad',
    mapping: '',
    connected: true,
    timestamp: performance.now(),
    buttons: Array.from({ length: 17 }, (_, i) => btn((over.buttons || [])[i] || false)),
    axes: Array.from({ length: 10 }, (_, i) => (over.axes || [])[i] ?? 0),
  })
  let pad = make({})
  window.__setPad = (over) => (pad = make(over))
  navigator.getGamepads = () => [pad]
}

const main = async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.stack || e.message)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  await page.addInitScript(injectFakePad)
  await page.goto(`${BASE}/?mode=solo&seed=42&pads=1`)
  await page.waitForSelector('text=Floor 1', { timeout: 15000 })

  // Press-to-join: face button 0 down for a few frames, then release.
  await page.evaluate(() => window.__setPad({ buttons: (() => { const b = []; b[0] = true; return b })() }))
  await page.waitForTimeout(300)
  // Now hold "up-left" on the hat (axis 9 = 1.0) plus attack (button 0).
  await page.evaluate(() =>
    window.__setPad({ axes: (() => { const a = []; a[9] = 1.0; return a })(), buttons: (() => { const b = []; b[0] = true; return b })() }),
  )
  await page.waitForTimeout(400)

  const debug = await page.evaluate(() => navigator.getGamepads()[0]?.id)
  await page.screenshot({ path: `${outDir}/controllers-overlay.png` })
  console.log('pad id seen by page:', debug)

  if (errors.length) {
    console.error('console/page errors:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('✓ overlay screenshot captured, no errors')
  }
  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
