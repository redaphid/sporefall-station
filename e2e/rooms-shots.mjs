// Room-LAYOUT visual evidence: still screenshots of a furnished apartment, shop,
// office and bunker, at game scale, so a human can judge whether the furniture
// reads as ARRANGED or as scattered junk. Deliberately video-free (no ffmpeg) and
// assertion-light — this is the eye-check instrument; reachability is proven by
// the vitest flood-fill suite, not by looking at pictures.
//
//   pnpm exec tsx scripts/test/gen-rooms-tour.mts e2e/output/rooms-fixtures
//   SHOT_TAG=before node e2e/rooms-shots.mjs
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const FIXTURES = join(OUT, 'rooms-fixtures')
const TAG = process.env.SHOT_TAG ?? 'shot'
const SHOTS = join(OUT, `rooms-${TAG}`)
const SIZE = { width: 1280, height: 720 }
mkdirSync(SHOTS, { recursive: true })

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: SIZE })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

await page.goto(`${BASE}/?mode=solo&e2e&seed=7&world=@inline`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function')

const tick = () => page.evaluate(() => window.__sporefall?.world?.tick ?? 0)
const dwell = async (ticks) => {
  const start = await tick()
  while ((await tick()) < start + ticks) await page.waitForTimeout(50)
}

const scene = async (name) => {
  await page.evaluate((j) => window.__loadWorld(j), fixture(name))
  await page.waitForTimeout(300)
  // `__zoom(z, true)` SNAPS the zoom, so no dwell is needed to reach the exact
  // level — and no dwell is exactly what we want: let the world run and a
  // firefight starts washing the frame in damage red, which is noise in a
  // before/after of furniture. These are LAYOUT stills, not action shots.
  for (const [label, zoom, ticks] of [['close', 2.2, 3], ['room', 1.5, 2], ['building', 0.9, 2]]) {
    await page.evaluate((z) => window.__zoom(z, true), zoom)
    await dwell(ticks)
    await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`) })
  }
  const info = await page.evaluate(() => {
    const w = window.__sporefall.world
    const p = w.entities.find((e) => e.playerCtl)
    const bi = w.level.buildings.findIndex(
      (b) =>
        p.pos.x >= b.rect.x && p.pos.x <= b.rect.x + b.rect.w &&
        p.pos.y >= b.rect.y && p.pos.y <= b.rect.y + b.rect.h,
    )
    const b = w.level.buildings[bi]
    const props = w.entities.filter(
      (e) => e.kind === 'interactable' && !e.dead &&
        e.pos.x >= b.rect.x && e.pos.x <= b.rect.x + b.rect.w &&
        e.pos.y >= b.rect.y && e.pos.y <= b.rect.y + b.rect.h,
    )
    const tally = {}
    for (const e of props) tally[e.archetype] = (tally[e.archetype] ?? 0) + 1
    return { role: b.role, roomTypes: b.roomTypes ?? [], props: props.length, tally }
  })
  console.log(`  ${name}: ${info.role} rooms=[${info.roomTypes.join(',')}] props=${info.props}`)
  console.log(`    ${Object.entries(info.tally).map(([k, v]) => `${k}×${v}`).join(' ')}`)
}

console.log(`rooms shots → ${SHOTS}`)
for (const n of ['rooms-1-apartment', 'rooms-2-shop', 'rooms-3-office', 'rooms-4-bunker']) await scene(n)

await page.close()
await context.close()
await browser.close()
if (errs.length) {
  for (const e of errs) console.error(`page error: ${e}`)
  process.exit(1)
}
console.log('OK')
