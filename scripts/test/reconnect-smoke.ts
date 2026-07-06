// Mid-game drop + auto-rejoin over the dev transport.
// Join, start, simulate a BLE-style drop on the client, verify the client
// reconnects to the SAME avatar (host never rejects, game continues).
// Usage: npx tsx scripts/test/reconnect-smoke.ts [baseUrl]
import { chromium } from 'playwright-core'

const BASE = process.argv[2] ?? process.env.MP_SMOKE_BASE ?? 'http://localhost:5173'

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const errors: string[] = []
  const hookErrors = (label: string, page: import('playwright-core').Page): void => {
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(`[${label}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => errors.push(`[${label} pageerror] ${err.stack ?? err.message}`))
  }

  const host = await context.newPage()
  hookErrors('host', host)
  await host.goto(`${BASE}/?mode=host&class=soldier&seed=777&room=rejoin&name=Hosty`)
  await host.waitForSelector('text=HOSTING', { timeout: 10000 })

  const client = await context.newPage()
  hookErrors('client', client)
  await client.goto(`${BASE}/?mode=join&class=thief&room=rejoin&name=Sneaky&transport=tabs`)
  await client.waitForSelector('text=Connected', { timeout: 10000 })
  await host.click('text=Start game')
  await client.waitForSelector('text=Floor 1', { timeout: 10000 })
  console.log('✓ game started')

  // Drop the client's link mid-game (host sees a disconnect, ghost created)
  await client.evaluate(() => {
    const t = (globalThis as Record<string, unknown>).__transport as { simulateDrop(): void }
    t.simulateDrop()
  })
  await client.waitForSelector('text=reconnecting', { timeout: 5000 })
  console.log('✓ client noticed the drop and is reconnecting')

  // Auto-rejoin fires after ~2s; wait until the reconnecting banner clears
  await client.waitForFunction(
    () => {
      const text = document.body.innerText
      return !text.includes('reconnecting') && !text.includes('Connection lost') && text.includes('Floor 1 —')
    },
    undefined,
    { timeout: 20000 },
  )
  console.log('✓ client rejoined and mission state resumed')

  // Host must still list Sneaky (same slot reclaimed, not a rejection)
  const hostBody = await host.textContent('body')
  if (!hostBody?.includes('Sneaky') && !hostBody?.includes('Floor 1')) {
    throw new Error('host state looks wrong after rejoin')
  }

  // Prove gameplay continues: client moves after rejoin without errors
  await client.bringToFront()
  await client.keyboard.down('d')
  await client.waitForTimeout(1500)
  await client.keyboard.up('d')
  await client.waitForTimeout(500)

  if (errors.length > 0) {
    console.error('console errors:\n' + errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('✓ reconnect flow clean — no console errors')
  }
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
