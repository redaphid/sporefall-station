// Verifies the browser join flow around the Bluetooth-vs-tabs picker:
// with Web Bluetooth present the picker must appear and the tabs option must
// proceed to the lobby; without it, join goes straight to the lobby.
// Usage: npx tsx scripts/test/join-picker-check.ts [baseUrl]
import { chromium } from 'playwright-core'

const BASE = process.argv[2] ?? process.env.MP_SMOKE_BASE ?? 'http://localhost:5173'

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })

  // Path 1: whatever this Chrome actually has (headless usually lacks bluetooth)
  const plain = await (await browser.newContext()).newPage()
  const hasBt = await plain.evaluate(() => 'bluetooth' in navigator)
  console.log('navigator.bluetooth present:', hasBt)
  await plain.goto(`${BASE}/?mode=join&class=soldier&room=picker-check&name=Picky`)
  if (hasBt) {
    await plain.waitForSelector('text=JOIN VIA', { timeout: 5000 })
    console.log('✓ picker shown when Web Bluetooth exists')
  } else {
    await plain.waitForSelector('text=Looking for a host', { timeout: 5000 })
    console.log('✓ no Web Bluetooth -> straight to lobby (no picker)')
  }

  // Path 2: stub navigator.bluetooth to force the picker; cancel the chooser,
  // then fall back to tabs.
  const ctx = await browser.newContext()
  // String form: a function here would get tsx/esbuild `__name` helpers
  // injected, which don't exist in the page.
  await ctx.addInitScript(
    `Object.defineProperty(navigator, 'bluetooth', { value: {
       requestDevice: () => Promise.reject(Object.assign(new Error('User cancelled'), { name: 'NotFoundError' })),
     } })`,
  )
  const page = await ctx.newPage()
  await page.goto(`${BASE}/?mode=join&class=soldier&room=picker-check2&name=Picky`)
  await page.waitForSelector('text=JOIN VIA', { timeout: 5000 })
  console.log('✓ picker shown with (stubbed) Web Bluetooth')
  await page.click('text=Bluetooth (phone host)')
  await page.waitForSelector('text=No device picked', { timeout: 5000 })
  console.log('✓ cancelled chooser keeps picker open with retry message')
  await page.click('text=Same-computer tabs')
  await page.waitForSelector('text=Looking for a host', { timeout: 5000 })
  console.log('✓ tabs fallback proceeds to lobby')

  // Path 3: ?transport=tabs must skip the picker even with Web Bluetooth
  const page3 = await ctx.newPage()
  await page3.goto(`${BASE}/?mode=join&class=soldier&room=picker-check3&name=Picky&transport=tabs`)
  await page3.waitForSelector('text=Looking for a host', { timeout: 5000 })
  console.log('✓ ?transport=tabs skips the picker')

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
