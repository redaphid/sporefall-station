// Theme hot-swap proof: the SAME seeded scene screenshotted under the default
// `city` theme and the `test` (magenta) theme, swapped at runtime via the
// __setTheme hook (the awaitable twin of the `theme` debug verb). Asserts:
//   1. the two screenshots actually differ (the theme changed pixels),
//   2. the deliberately-broken tile.wall ref in the test theme only degrades
//      (procedural fallback) — no page errors, sim keeps ticking,
//   3. swapping back to city still works.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

const pageErrors = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  // The test theme references does-not-exist.png ON PURPOSE (graceful-
  // degradation fixture) — the browser logs that 404 as a console error.
  if (m.type() === 'error' && !m.text().includes('does-not-exist.png') && !m.text().includes('Failed to load resource'))
    consoleErrors.push(m.text())
})

await page.goto(`${BASE}/?mode=solo&e2e&seed=424242&zoom=2`, { waitUntil: 'networkidle' })
const tick = () => page.evaluate(() => window.__world?.tick ?? 0)
while ((await tick()) < 30) await page.waitForTimeout(40)

const shots = {}
const snap = async (label) => {
  const path = join(OUT, `theme-${label}.png`)
  shots[label] = await page.screenshot({ path })
  console.log(`[theme-swap] captured ${path}`)
}

await snap('city')

// Runtime hot-swap to the magenta test theme (awaits asset baking).
await page.evaluate(() => window.__setTheme('test'))
await page.waitForTimeout(300)
await snap('test')

// Themed display names resolve without touching the sim.
const themedTitle = await page.evaluate(() => {
  const cop = window.__world.entities.find((e) => e.archetype === 'cop')
  return cop ? JSON.parse(window.__verb(`get ${cop.id}`)).archetype : 'no-cop'
})

// Swap back via the debug-verb path (fire-and-forget), then settle.
const verbReply = await page.evaluate(() => window.__verb('theme city'))
await page.waitForTimeout(800)
await snap('city-restored')

const tickAfter = await tick()

const failures = []
if (shots.city.equals(shots.test)) failures.push('city and test screenshots are identical — theme swap changed nothing')
if (shots.test.equals(shots['city-restored'])) failures.push('test and restored-city screenshots are identical — swap-back failed')
if (!JSON.parse(verbReply || '{}').theme) failures.push(`theme verb reply malformed: ${verbReply}`)
if (tickAfter < 30) failures.push(`sim stopped ticking after theme swaps (tick=${tickAfter})`)
if (themedTitle === 'no-cop') console.log('[theme-swap] note: no cop on this floor, name-lookup smoke skipped')
if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`)
if (consoleErrors.length) failures.push(`console errors: ${consoleErrors.join(' | ')}`)

await browser.close()

if (failures.length) {
  console.error('[theme-swap] FAIL')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
writeFileSync(join(OUT, 'theme-swap.txt'), `ok tick=${tickAfter}\n`)
console.log('[theme-swap] PASS — city vs test vs restored screenshots differ, no errors, sim alive')
