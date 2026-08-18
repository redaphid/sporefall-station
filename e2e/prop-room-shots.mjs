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
  // The single-prop proof (gen-prop-rooms.mts scene 4). `swampspace` is the
  // CONTROL -- it draws the chair as the engine vector placeholder -- and each
  // `_review-*` pack swaps in one candidate and nothing else.
  // Two zooms, two different questions. 1.6 is near play zoom and answers the
  // one that matters -- does the eye go to the chair instead of the threat.
  // 3 is close enough to actually READ the sprite (outline, interior detail)
  // while still standing on the real floor beside real neighbours; it is NOT a
  // substitute for 1.6, because a prop that looks good at 3 and glows at 1.6 has
  // failed the only test with a gameplay cost.
  ['chair-proof', ['swampspace'], [1.6, 3]],
]

// Generation is an ITERATION LOOP, not a sweep: render one prop, look at the
// room, let what you see drive the next prompt. Reshooting all four fixtures for
// every reroll wastes minutes per turn, so `ONLY=chair-proof` (and optional
// `THEMES=swampspace,_review-A`) narrows the run to the thing under test.
// `THEMES` REPLACES the job's pack list rather than intersecting it: while a prop
// is being iterated the packs are `_review-s<seed>` dirs that did not exist when
// this file was written, so an intersection could only ever shrink the list and
// never point at the thing under test. `ZOOMS` likewise.
const only = process.env.ONLY?.split(',').filter(Boolean)
const themeOverride = process.env.THEMES?.split(',').filter(Boolean)
const zoomOverride = process.env.ZOOMS?.split(',').filter(Boolean).map(Number)
const jobs = JOBS.filter(([f]) => !only || only.includes(f)).map(([f, themes, zooms]) => [
  f,
  themeOverride ?? themes,
  zoomOverride ?? zooms,
])

const browser = await chromium.launch({ headless: true })
const errs = []
for (const [fixture, themes, zooms] of jobs) {
  const world = JSON.parse(readFileSync(join(ROOMS, `${fixture}.json`), 'utf8'))
  for (const theme of themes) {
    const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 3 })
    const page = await context.newPage()
    page.on('pageerror', (e) => errs.push(`${fixture}/${theme}: ${e}`))
    page.on('console', (m) => m.type() === 'error' && errs.push(`${fixture}/${theme} console: ${m.text()}`))
    // A THEME WARNING IS FATAL HERE, even though warnings are ignorable
    // elsewhere. `loadThemeChain` falls back to the default pack when it cannot
    // use the id it was given, and the run then photographs a real, plausible,
    // WRONG pack -- eight candidates that come back pixel-identical because none
    // of them ever loaded. A silent fallback in a comparison harness is worse
    // than a crash: the crash you notice.
    page.on('console', (m) => m.type() === 'warning' && m.text().startsWith('[theme')
      && errs.push(`${fixture}/${theme} THEME NOT APPLIED: ${m.text()}`))
    await page.goto(`${BASE}/?mode=solo&e2e&seed=7&world=@inline&theme=${theme}`, { waitUntil: 'domcontentloaded' })
    // ORDER IS LOAD-BEARING: world FIRST, theme second.
    //
    // With `?world=@inline`, main.ts parks on `await new Promise(...)` until the
    // harness calls `__loadWorld` -- and that await sits ~50 lines ABOVE the
    // `?e2e` block that exposes `__setTheme`. So `__setTheme` does not exist yet.
    // Waiting for it before pushing the world is a deadlock: the page waits for
    // the world, the harness waits for the hook, neither moves, and the run dies
    // on a 30s timeout that looks like a broken fixture.
    await page.waitForFunction(() => typeof window.__loadWorld === 'function')
    await page.evaluate((j) => window.__loadWorld(j), world)
    // Pushing the world unblocks boot, so `__setTheme` appears only now. It
    // resolves when the new assets are actually BAKED. Waiting on a fixed timeout
    // instead let one pack photograph a half-loaded tile pool and the next a
    // complete one -- the floor changed between shots, which destroys the whole
    // point of holding everything else still.
    await page.waitForFunction(() => typeof window.__setTheme === 'function')
    await page.evaluate((t) => window.__setTheme(t), theme)
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
