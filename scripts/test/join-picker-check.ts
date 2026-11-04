// Verifies the browser join flow around the Bluetooth-vs-tabs picker:
// with Web Bluetooth present the picker must appear and the tabs option must
// proceed to the lobby; without it, join shows the can't-join screen (#15).
// Usage: npx tsx scripts/test/join-picker-check.ts [baseUrl]
import { chromium } from 'playwright-core'

const BASE = process.argv[2] ?? process.env.MP_SMOKE_BASE ?? 'http://localhost:5173'

const main = async (): Promise<void> => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PW_CHROME || undefined,
    // Headless in this repo boots only with these two (see verify-sporefall's drive.mjs).
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  })

  // Path 1: whatever this Chrome actually has (headless usually lacks bluetooth)
  const plain = await (await browser.newContext()).newPage()
  await plain.goto(`${BASE}/?mode=join&room=picker-check&name=Picky`, { waitUntil: 'commit' })
  // Read on the game's own page (about:blank differs), the way probeWebBluetooth
  // does: the picker needs the API and a getAvailability() that does not say no.
  // String form for the same reason as below.
  const webBluetooth = (await plain.evaluate(
    `(async () => {
       if (!('bluetooth' in navigator) || !navigator.bluetooth) return 'absent'
       if (typeof navigator.bluetooth.getAvailability !== 'function') return 'available'
       try { return (await navigator.bluetooth.getAvailability()) === false ? 'unavailable' : 'available' }
       catch { return 'unavailable' }
     })()`,
  )) as string
  console.log('Web Bluetooth on this page:', webBluetooth)
  if (webBluetooth === 'available') {
    await plain.waitForSelector('text=JOIN VIA', { timeout: 15000 })
    console.log('✓ picker shown when Web Bluetooth exists')
  } else {
    await plain.waitForSelector('[data-role="join-unsupported"]', { timeout: 15000 })
    console.log("✓ no Web Bluetooth -> can't-join screen (no silent tabs fallback)")
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
  await page.goto(`${BASE}/?mode=join&room=picker-check2&name=Picky`, { waitUntil: 'commit' })
  await page.waitForSelector('text=JOIN VIA', { timeout: 15000 })
  console.log('✓ picker shown with (stubbed) Web Bluetooth')
  await page.click('text=Bluetooth (phone host)')
  await page.waitForSelector('text=No device picked', { timeout: 15000 })
  console.log('✓ cancelled chooser keeps picker open with retry message')
  await page.click('text=Same-computer tabs')
  await page.waitForSelector('text=Looking for a host', { timeout: 15000 })
  console.log('✓ tabs fallback proceeds to lobby')

  // Path 3: ?transport=tabs must skip the picker even with Web Bluetooth
  const page3 = await ctx.newPage()
  await page3.goto(`${BASE}/?mode=join&room=picker-check3&name=Picky&transport=tabs`, { waitUntil: 'commit' })
  await page3.waitForSelector('text=Looking for a host', { timeout: 15000 })
  console.log('✓ ?transport=tabs skips the picker')

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
