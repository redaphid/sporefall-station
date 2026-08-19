// Judge player identity at REAL phone size: a crew + a hostile + furniture in
// one frame, at the real default camera zoom, on a phone-shaped landscape stage
// (the game is landscape-always — see src/ui/orientation.ts). A design that
// reads at 1280x720 on a desk and fails here has not been judged.
//
//   node e2e/crew-identity.mjs <label> [fixture] [--grey] [--zoom=0.5]
//
// `--grey` desaturates the whole page, which is the honest test of the "never
// colour alone" rule: if you cannot still tell the crew apart in this shot, the
// design fails for ~1 man in 12.
//
// Requires a served build on BASE_URL (default http://localhost:4173).
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const positional = args.filter((a) => !a.startsWith('--'))
const label = positional[0] ?? 'crew'
const fixture = positional[1] ?? 'crew-scene'
const grey = flags.includes('--grey')
const zoom = flags.find((f) => f.startsWith('--zoom='))?.slice('--zoom='.length)

// Pixel 7 in landscape at its real device pixel ratio: 915x412 CSS px is what
// the player's eye actually gets.
const PHONE = { width: 915, height: 412 }

const world = JSON.parse(readFileSync(join(__dirname, `../src/game/__fixtures__/${fixture}.json`), 'utf8'))

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

const params = { mode: 'solo', e2e: '1', seed: '7', world: '@inline' }
if (zoom) params.zoom = zoom
await page.goto(`${BASE}/?${new URLSearchParams(params)}`, { waitUntil: 'networkidle' })
await page.evaluate((w) => window.__loadWorld(w), world)
await page.waitForFunction(() => (window.__world?.tick ?? 0) > 20, null, { timeout: 20_000 })
await page.waitForTimeout(1200)

const seen = await page.evaluate(() => {
  const w = window.__world
  const players = w.entities
    .filter((e) => e.playerCtl)
    .map((e) => ({ slot: e.playerCtl.playerId, downed: e.playerCtl.downed != null }))
  return {
    players,
    npcsOnFloor: w.entities.filter((e) => e.kind === 'npc').length,
    props: w.entities.filter((e) => e.kind === 'interactable').length,
    tick: w.tick,
  }
})

// Desaturation is applied to the whole document, canvas included, so the shot is
// exactly what a player with total colour blindness would be working from.
if (grey) {
  await page.addStyleTag({ content: 'html{filter:grayscale(1) !important}' })
  await page.waitForTimeout(300)
}

await page.screenshot({ path: join(OUT, `${label}-phone.png`) })
await page.close()
await context.close()
await browser.close()

console.log(`[crew-identity] ${join(OUT, `${label}-phone.png`)}`)
console.log(`[crew-identity] ${JSON.stringify(seen)}`)
if (errs.length) {
  console.error(`[crew-identity] page errors: ${errs.join(' | ')}`)
  process.exitCode = 1
}
