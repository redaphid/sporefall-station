// Sporefall Station (swampspace) merge proof: the built app actually wears the
// theme end-to-end. Two paths are exercised:
//   1. `?theme=swampspace` (dev/session URL param) — spawn shot with themed
//      characters + tiles, plus a second framing teleported next to a prop
//      (crate/barrel) so tiles + chars + props are all visible in one image.
//   2. The settings-picker path a player uses: boot on default city, open the
//      gear panel, pick "Sporefall Station" from the Theme select, and assert
//      the pixels change (hot-swap) with no page errors and the sim ticking.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4988'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const failures = []

const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => failures.push(`page error: ${e}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource'))
      failures.push(`console error: ${m.text()}`)
  })
  return page
}
const waitTicks = async (page, n) => {
  const tick = () => page.evaluate(() => window.__world?.tick ?? 0)
  while ((await tick()) < n) await page.waitForTimeout(40)
}
const snap = async (page, label) => {
  const path = join(OUT, `${label}.png`)
  const buf = await page.screenshot({ path })
  console.log(`[theme-swampspace] captured ${path}`)
  return buf
}

// --- Path 1: URL param -------------------------------------------------------
const p1 = await newPage()
await p1.goto(`${BASE}/?mode=solo&e2e&seed=424242&zoom=2&theme=swampspace`, { waitUntil: 'networkidle' })
await waitTicks(p1, 40)
const spawnShot = await snap(p1, 'swampspace-spawn')

// Frame a prop: teleport the player beside the nearest crate/barrel so the shot
// proves themed tiles + characters + props together.
const propInfo = await p1.evaluate(() => {
  const w = window.__world
  const me = w.entities.find((e) => e.playerCtl && !e.dead)
  // Preference order: furniture first, then doors (themed "Bulkhead Hatch") —
  // some floors (e.g. seed 424242) spawn no crates/barrels at all.
  const PROPS = ['crate', 'barrel', 'vending', 'atm', 'tv', 'toilet', 'door']
  const prop = PROPS.map((k) => w.entities.find((e) => !e.dead && e.archetype === k)).find(Boolean)
  if (!me || !prop) return null
  window.__verb(`teleport ${me.id} ${prop.pos.x + 1.2} ${prop.pos.y}`)
  return { prop: prop.archetype, x: prop.pos.x, y: prop.pos.y }
})
if (!propInfo) failures.push('no prop (crate/barrel/vending/atm/tv/toilet) found on floor to frame the prop shot')
await p1.waitForTimeout(500)
const propShot = await snap(p1, 'swampspace-props')
if (propInfo && spawnShot.equals(propShot)) failures.push('prop-framed shot identical to spawn shot — teleport did nothing')
const tick1 = await p1.evaluate(() => window.__world.tick)
if (tick1 < 40) failures.push(`sim not ticking under swampspace (tick=${tick1})`)
await p1.close()

// --- Path 2: settings picker -------------------------------------------------
const p2 = await newPage()
await p2.goto(`${BASE}/?mode=solo&e2e&seed=424242&zoom=2`, { waitUntil: 'networkidle' })
await p2.evaluate(() => localStorage.clear()) // no persisted theme — boot city next load
await p2.goto(`${BASE}/?mode=solo&e2e&seed=424242&zoom=2`, { waitUntil: 'networkidle' })
await waitTicks(p2, 30)
const cityShot = await snap(p2, 'city-before-picker')

await p2.click('button[aria-label="Settings"]')
const options = await p2.$$eval('#th option', (os) => os.map((o) => ({ id: o.value, name: o.textContent })))
console.log('[theme-swampspace] picker options:', JSON.stringify(options))
if (!options.some((o) => o.id === 'swampspace' && o.name === 'Sporefall Station'))
  failures.push(`picker missing "Sporefall Station": ${JSON.stringify(options)}`)
await p2.selectOption('#th', 'swampspace')
await p2.waitForTimeout(1200) // asset bake + hot swap
await p2.click('button[aria-label="Settings"]') // close panel so the shot is clean
await p2.waitForTimeout(200)
const pickedShot = await snap(p2, 'swampspace-via-picker')
if (pickedShot.equals(cityShot)) failures.push('picker swap changed nothing — city and swampspace shots identical')
const tick2 = await p2.evaluate(() => window.__world.tick)
if (tick2 < 30) failures.push(`sim stopped after picker swap (tick=${tick2})`)
await p2.close()

await browser.close()

if (failures.length) {
  console.error('[theme-swampspace] FAIL')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
writeFileSync(join(OUT, 'theme-swampspace.txt'), `ok prop=${propInfo?.prop} tickUrl=${tick1} tickPicker=${tick2}\n`)
console.log('[theme-swampspace] PASS — URL param + settings picker both wear Sporefall Station')
