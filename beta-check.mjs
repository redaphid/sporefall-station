import { chromium } from 'playwright'
const b = await chromium.connectOverCDP('http://127.0.0.1:9333')
const ctx = b.contexts()[0] ?? (await b.newContext())
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
const fails = []
page.on('response', (r) => { if (r.status() >= 400) fails.push(`${r.status()} ${r.url()}`) })
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto('https://sporefall.hypnodroid.com/betas/frog-villager/?mode=solo&e2e=1&seed=424242&zoom=2', { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForTimeout(6000)
// Did the theme actually load the frog art?
const probe = await page.evaluate(async () => {
  const r = await fetch('themes/swampspace-hires/manifest.json')
  const m = await r.json()
  const keys = Object.keys(m.sprites).filter((k) => k.startsWith('char.civilian.'))
  return { civKeys: keys.length, walkKeys: keys.filter((k) => k.includes('-walk-')).length, sample: m.sprites['char.civilian.e-walk-3'] }
})
await page.screenshot({ path: '/tmp/frog-art/beta-shot.png' })
console.log(JSON.stringify({ probe, errs: errs.slice(0, 5), fails: fails.slice(0, 5) }, null, 1))
await page.close()
