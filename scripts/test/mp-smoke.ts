// Two-tab multiplayer smoke test over BroadcastChannelTransport.
// Host tab + client tab in one browser context, host starts, both play,
// screenshots + console errors captured.
// Usage: npx tsx scripts/test/mp-smoke.ts [outDir] [baseUrl]
//   baseUrl also settable via MP_SMOKE_BASE (default http://localhost:5173)
import { chromium } from 'playwright-core'

const BASE = process.argv[3] ?? process.env.MP_SMOKE_BASE ?? 'http://localhost:5173'
const outDir = process.argv[2] ?? 'outputs/screenshots'

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const errors: string[] = []
  const track = (label: string) => (msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error') errors.push(`[${label}] ${msg.text()}`)
  }

  const host = await context.newPage()
  host.on('console', track('host'))
  host.on('pageerror', (err) => errors.push(`[host pageerror] ${err.stack ?? err.message}`))
  await host.goto(`${BASE}/?mode=host&class=soldier&seed=777&room=smoke&name=Hosty`)
  await host.waitForSelector('text=HOSTING', { timeout: 10000 })

  const client = await context.newPage()
  client.on('console', track('client'))
  client.on('pageerror', (err) => errors.push(`[client pageerror] ${err.stack ?? err.message}`))
  // transport=tabs skips the Bluetooth-vs-tabs picker shown when Web Bluetooth exists
  await client.goto(`${BASE}/?mode=join&class=thief&room=smoke&name=Sneaky&transport=tabs`)
  await client.waitForSelector('text=Connected', { timeout: 10000 })

  // Host should now list both players
  await host.waitForSelector('text=Sneaky', { timeout: 5000 })
  console.log('✓ lobby: client visible on host')

  await host.click('text=Start game')
  await host.waitForSelector('text=Floor 1', { timeout: 10000 })
  await client.waitForSelector('text=Floor 1', { timeout: 10000 })
  console.log('✓ both entered floor 1')

  // Client walks right for 2 seconds; host should see the thief move.
  await client.bringToFront()
  await client.keyboard.down('d')
  await client.waitForTimeout(2000)
  await client.keyboard.up('d')
  await host.bringToFront()
  await host.waitForTimeout(500)

  await host.screenshot({ path: `${outDir}/mp-host.png` })
  await client.screenshot({ path: `${outDir}/mp-client.png` })

  const hostNet = await host.evaluate(() => (globalThis as Record<string, unknown>).__net)
  const clientNet = await client.evaluate(() => (globalThis as Record<string, unknown>).__net)
  console.log('host net:', JSON.stringify(hostNet))
  console.log('client net:', JSON.stringify(clientNet))

  // Count player-colored sprites via the sim: expose debug hook? Cheap check: no console errors.
  if (errors.length > 0) {
    console.error('console errors:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('✓ no console errors; screenshots saved')
  }
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
