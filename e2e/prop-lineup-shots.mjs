// Screenshot the prop-art lineup through the real engine, at game scale and at
// a magnified scale, on the swampspace theme — the visual answer to "the props
// look terrible": which ones are art, which ones are engine vectors.
//
//   pnpm exec tsx scripts/test/gen-prop-lineup.mts e2e/output/prop-lineup
//   node e2e/prop-lineup-shots.mjs
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHOTS = join(OUT, 'prop-lineup')
const THEME = process.env.LINEUP_THEME ?? 'swampspace'
const SIZE = { width: 1600, height: 900 }
mkdirSync(SHOTS, { recursive: true })

const world = JSON.parse(readFileSync(join(SHOTS, 'prop-lineup.json'), 'utf8'))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2 })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

await page.goto(`${BASE}/?mode=solo&e2e&seed=7&world=@inline&theme=${THEME}`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function')
await page.waitForTimeout(1500)
await page.evaluate((j) => window.__loadWorld(j), world)
await page.waitForTimeout(600)

for (const [label, zoom] of [['1x-game-scale', 1], ['2x', 2], ['3x-detail', 3]]) {
  await page.evaluate((z) => window.__zoom(z, true), zoom)
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, `lineup-${THEME}-${label}.png`) })
  console.log(`  shot: lineup-${THEME}-${label}.png`)
}

const seen = await page.evaluate(() => {
  const w = window.__sporefall.world
  return w.entities.filter((e) => e.kind === 'interactable' && !e.dead).map((e) => e.archetype)
})
console.log(`lineup rendered ${seen.length} props: ${seen.join(', ')}`)

await page.close()
await context.close()
await browser.close()
if (errs.length) {
  for (const e of errs) console.error(`page error: ${e}`)
  process.exit(1)
}
console.log('OK')
