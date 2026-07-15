import { chromium } from 'playwright-core'

const OUT = '/tmp/claude-1000/-home-redaphid-Projects-streets-of-rogue/7cd1f2be-c0fd-478e-8279-45f7638dd053/scratchpad'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto('http://localhost:5173/?mode=solo&class=soldier', { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.mouse.click(450, 350)

// Wander + attack: hold a direction, mash Space, capture a few frames.
const seq = ['KeyW', 'KeyA', 'KeyS', 'KeyD']
for (let i = 0; i < 8; i++) {
  const k = seq[i % 4]
  await page.keyboard.down(k)
  await page.keyboard.press('Space')
  await page.waitForTimeout(350)
  await page.keyboard.press('Space')
  await page.waitForTimeout(300)
  await page.keyboard.up(k)
}
await page.screenshot({ path: `${OUT}/game-combat.png` })
await browser.close()
console.log('pageerrors:', errs.length ? errs.join(' | ') : 'none')
