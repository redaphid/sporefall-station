// Drives a CDP-attached Chrome through Join co-op with Web Bluetooth stubbed
// away and screenshots the can't-join screen (#15).
// Usage: node scripts/test/join-unsupported-cdp.mjs <baseUrl> <outDir> <cdpUrl>
// Point cdpUrl at a Chrome you launched for this (own port, throwaway
// --user-data-dir), never someone's everyday browser.
import { chromium } from 'playwright-core'

const [BASE, OUT, CDP] = process.argv.slice(2)
if (!BASE || !OUT || !CDP) throw new Error('usage: join-unsupported-cdp.mjs <baseUrl> <outDir> <cdpUrl>')
const assert = (ok, msg) => {
  if (!ok) throw new Error(`FAIL: ${msg}`)
  console.log(`ok   ${msg}`)
}
const NO_BLUETOOTH = `delete Navigator.prototype.bluetooth; delete navigator.bluetooth`
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const wsUrl = CDP.startsWith('ws') ? CDP : (await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl
const browser = await chromium.connectOverCDP(wsUrl, { timeout: 120000 })
const contexts = []
const open = async (opts, init) => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts })
  contexts.push(ctx)
  await ctx.addInitScript(init)
  return ctx.newPage()
}
const unsupportedText = (page) => page.locator('[data-role="join-unsupported"]').innerText({ timeout: 10000 })

try {
  const phone = await open(
    { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    NO_BLUETOOTH,
  )
  await phone.goto(`${BASE}/`)
  assert(await phone.evaluate(() => !('bluetooth' in navigator)), 'iPhone page has no navigator.bluetooth')
  await phone.click('text=Join co-op')
  const text = await unsupportedText(phone)
  assert(/Safari and Chrome on iPhone and iPad can't use Bluetooth/.test(text), `iPhone sees the reason: ${JSON.stringify(text)}`)
  assert((await phone.locator('text=Looking for a host').count()) === 0, 'no empty lobby behind it')
  await phone.screenshot({ path: `${OUT}/join-unsupported-iphone.png` })
  await phone.click('text=Back to menu')
  await phone.waitForSelector('[data-role="start-menu"]', { timeout: 10000 })
  assert(true, 'Back to menu lands on the start menu')

  const desktop = await open({ viewport: { width: 1000, height: 640 } }, NO_BLUETOOTH)
  await desktop.goto(`${BASE}/?mode=join&room=cdp15`)
  assert(/This browser can't join/.test(await unsupportedText(desktop)), 'desktop without Web Bluetooth names the browser')
  await desktop.screenshot({ path: `${OUT}/join-unsupported-desktop.png` })

  const noAdapter = await open(
    { viewport: { width: 1000, height: 640 } },
    `Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => ({
       getAvailability: () => Promise.resolve(false), requestDevice: () => Promise.reject(new Error('x')) }) })`,
  )
  await noAdapter.goto(`${BASE}/?mode=join&room=cdp15`)
  assert(/Bluetooth unavailable/.test(await unsupportedText(noAdapter)), 'getAvailability false shows Bluetooth unavailable')

  const dev = await open({ viewport: { width: 1000, height: 640 } }, NO_BLUETOOTH)
  await dev.goto(`${BASE}/?mode=join&room=cdp15&transport=tabs`)
  await dev.waitForSelector('text=Looking for a host', { timeout: 10000 })
  assert(true, '?transport=tabs still reaches the BroadcastChannel lobby without Web Bluetooth')
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {})
  await browser.close().catch(() => {})
}
