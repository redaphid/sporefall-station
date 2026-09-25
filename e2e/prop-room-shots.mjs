// Photograph the prop art IN A FURNISHED ROOM, at game zoom, once per theme pack.
//
// The comparison only means anything if NOTHING moves between shots: same
// fixture, same tiles, same neighbours, same camera, same zoom. Only the theme
// changes -- `swampspace` renders shelf/chair/bunk/bench/table as engine vector
// shapes, each `_review-*` pack renders a different candidate sprite for them.
//
//   pnpm exec tsx scripts/test/gen-prop-rooms.mts e2e/output/prop-rooms
//   node e2e/prop-room-shots.mjs
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const ROOMS = join(OUT, 'prop-rooms')
const SHOTS = join(OUT, 'prop-room-shots')
mkdirSync(SHOTS, { recursive: true })

// He plays on a phone, held landscape. Shoot that shape, at deviceScaleFactor 3
// so the 32px sprites are legible in the PNG without being magnified past what
// the screen actually shows.
const SIZE = { width: 880, height: 410 }

// [fixture, themes, zooms]. zoom 1 is ZOOM_DEFAULT -- literally what the game
// opens at; zoom 2 is "zoom in on the room", still inside ZOOM_MAX 4.
const JOBS = [
  ['crew-quarters', ['swampspace', '_review-A', '_review-B', '_review-C'], [1, 1.6, 2]],
  ['old-vs-new', ['swampspace'], [1.6, 2]],
  ['as-generated', ['swampspace'], [1, 1.6]],
]

const browser = await chromium.launch({ headless: true })
const errs = []
for (const [fixture, themes, zooms] of JOBS) {
  const world = JSON.parse(readFileSync(join(ROOMS, `${fixture}.json`), 'utf8'))
  for (const theme of themes) {
    const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 3 })
    const page = await context.newPage()
    page.on('pageerror', (e) => errs.push(`${fixture}/${theme}: ${e}`))
    page.on('console', (m) => m.type() === 'error' && errs.push(`${fixture}/${theme} console: ${m.text()}`))
    await page.goto(`${BASE}/?mode=solo&e2e&seed=7&world=@inline&theme=${theme}`, { waitUntil: 'networkidle' })
    // `__setTheme` resolves when the new assets are actually BAKED. Waiting on a
    // fixed timeout instead let one pack photograph a half-loaded tile pool and
    // the next a complete one -- the floor changed between shots, which destroys
    // the whole point of holding everything else still.
    await page.waitForFunction(() => typeof window.__setTheme === 'function')
    await page.evaluate((t) => window.__setTheme(t), theme)
    await page.evaluate((j) => window.__loadWorld(j), world)
    await page.waitForTimeout(700)
    for (const z of zooms) {
      await page.evaluate((zz) => window.__zoom(zz, true), z)
      await page.waitForTimeout(450)
      const f = join(SHOTS, `${fixture}--${theme}--zoom${z}.png`)
      await page.screenshot({ path: f })
      console.log(`  ${fixture} ${theme} zoom${z}`)
    }
    await page.close(); await context.close()
  }
}
await browser.close()
if (errs.length) { for (const e of errs) console.error(e); process.exit(1) }
console.log('OK')
