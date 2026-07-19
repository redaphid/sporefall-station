// Shader-FX live probe: boots the built app with the backbuffer pipeline on
// and off, proves the composite path is genuinely live (window.__fx), catches
// shader-compile/console errors, and snaps explosion frames from the showcase
// scenario (staggered grenades) for eyeballing shockwave + bloom.
// Serve first:  pnpm exec vite preview --port 4971 --strictPort
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4971'
const OUT = process.env.PROBE_OUT ?? '/tmp/claude-1000/-home-redaphid-Projects-streets-of-rogue-mobile/45274930-60ad-4e2f-b853-849ae40766ef/scratchpad'

const browser = await chromium.launch({ headless: true })
let failed = false

for (const fx of ['full', 'reduced', 'off']) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => {
    const t = m.text()
    if ((m.type() === 'error' || t.includes('[backbuffer]')) && !t.includes('ReadPixels')) errs.push(`${m.type()}: ${t}`)
  })
  await page.goto(`${BASE}/?mode=solo&e2e=1&seed=42&scenario=showcase&fx=${fx}`, { waitUntil: 'networkidle' })
  const tick = () => page.evaluate(() => window.__world?.tick ?? 0)
  while ((await tick()) < 74) await page.waitForTimeout(40) // first grenade booms ~tick 70
  await page.screenshot({ path: `${OUT}/probe-${fx}-boom.png` })
  while ((await tick()) < 150) await page.waitForTimeout(40) // second boom ~140
  await page.screenshot({ path: `${OUT}/probe-${fx}-boom2.png` })
  const st = await page.evaluate(() => ({ ...window.__fx, tick: window.__world?.tick }))
  const wantActive = fx !== 'off'
  const ok = st.mode === fx && st.active === wantActive && st.failed === false && errs.length === 0
  if (!ok) failed = true
  console.log(`fx=${fx}:`, st, errs.length ? errs.slice(0, 5) : '(clean console)', ok ? 'OK' : 'FAIL')
  await ctx.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
