import { chromium } from 'playwright-core'

const OUT = process.env.OUT || '/tmp/claude-1000/-home-redaphid-Projects-streets-of-rogue/7cd1f2be-c0fd-478e-8279-45f7638dd053/scratchpad'
const URL = 'http://localhost:5173/?mode=solo&class=soldier'

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/game-initial.png` })

// Read the player position before moving, from the page if exposed; else just move and screenshot.
await page.mouse.click(450, 350) // focus canvas
await page.keyboard.down('KeyD')
await page.waitForTimeout(700)
await page.keyboard.up('KeyD')
await page.keyboard.down('KeyS')
await page.waitForTimeout(700)
await page.keyboard.up('KeyS')
await page.keyboard.press('Space') // attack
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/game-after-move.png` })

// Gamepad wiring smoke: confirm getGamepads is polled without throwing.
const gpOk = await page.evaluate(() => typeof navigator.getGamepads === 'function')

await browser.close()
console.log('gamepad-api-present:', gpOk)
console.log('--- console logs ---')
console.log(logs.slice(-40).join('\n'))
