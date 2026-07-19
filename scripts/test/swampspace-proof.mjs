// In-game proof shot of the swampspace theme: boots the built app with
// ?theme=swampspace on a seeded solo run and captures screenshots at two zooms.
// Usage: node scripts/test/swampspace-proof.mjs  (expects `vite preview` on BASE_URL)
import { chromium } from 'playwright'
import { join } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:4987'
const OUT = process.env.OUT ?? 'docs/assets/swampspace'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
page.on('console', (m) => {
  if (m.type() === 'warning' && `${m.text()}`.includes('[theme]')) console.log('  ', m.text())
})
await page.goto(`${BASE}/?mode=solo&e2e&seed=424242&zoom=2&theme=swampspace`, {
  waitUntil: 'networkidle',
})
const tick = () => page.evaluate(() => window.__world?.tick ?? 0)
while ((await tick()) < 40) await page.waitForTimeout(50)
await page.screenshot({ path: join(OUT, 'ingame-swampspace.png') })
console.log('captured', join(OUT, 'ingame-swampspace.png'))
await browser.close()
