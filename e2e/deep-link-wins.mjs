// A DEEP LINK ALWAYS WINS OVER THE SAVED RUN — and never touches it.
//
// THE BUG THIS EXISTS TO CATCH (2026-09-18): the owner opened
// `/?mode=solo&seed=18&scenario=armed&floor=3` on their phone and "it just took
// me to my existing game". The service worker served the previous build (the
// new one only applied at the mode picker, which `?mode=` skips), that build
// did not know `armed` and silently ignored it, and the resulting ordinary run
// was autosaved over the owner's real one. See src/app/deepLink.ts.
//
// Asserts, in a real browser against a real build:
//   1. a solo run with no seed in the URL leaves a save
//   2. the owner's scenario URL starts the scenario (floor 3, machine gun), not
//      the save — and the save is still the original run afterwards
//   2b. a bare `?seed=` link starts that seed, not the save, and leaves the save
//      alone (a seed-7 save once hijacked `/?mode=solo&seed=31337`)
//   3. an unknown scenario shows a visible error, starts no run, and leaves the
//      save alone
//   4. a plain URL afterwards resumes the ORIGINAL run
//
// The stale-service-worker half (old build cached, link opened after a deploy)
// is covered by the `freshen` cases in src/app/webUpdate.test.ts; driving it
// here would need two different builds on one origin.
//
// Run: ./e2e/run-deep-link-wins.sh

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4978'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const OWNER_URL = '/?mode=solo&seed=18&scenario=armed&floor=3&e2e'

const failures = []
const fail = (m) => (console.error(`  FAIL — ${m}`), failures.push(m))
const check = (cond, m) => (cond ? console.log(`  ok — ${m}`) : fail(m))

mkdirSync(OUT, { recursive: true })
// No GPU: see start-menu-fit.mjs — WSL's headless GPU process can take the
// browser down when pixi asks for a context.
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-software-rasterizer'] })
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => logs.push(m.text()))

const save = () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('sporefall.savegame')
    if (!raw) return null
    const env = JSON.parse(raw)
    const w = env.world ?? env
    return { seed: w.seed, floor: w.floor }
  })
const world = () =>
  page.evaluate(() => {
    const w = window.__world
    if (!w) return null
    return { seed: w.seed, floor: w.floor, weapon: w.entities.find((e) => e.playerCtl)?.combat?.weapon }
  })
const waitForWorld = (pred, ms = 30_000) =>
  page.waitForFunction(pred, null, { timeout: ms, polling: 250 }).then(
    () => true,
    () => false,
  )

console.log('[deep-link-wins] 1. a solo run leaves a save')
await page.goto(`${BASE}/?mode=solo&e2e`)
await waitForWorld(() => window.__world?.tick > 120)
await page.waitForTimeout(1500)
const original = await save()
const originalSeed = original?.seed
check(
  typeof originalSeed === 'number' && originalSeed !== 31337,
  `save exists for the unseeded run (${JSON.stringify(original)})`,
)

console.log('[deep-link-wins] 2. the owner URL starts the scenario, not the save')
logs.length = 0
await page.goto(`${BASE}${OWNER_URL}`)
const armed = await waitForWorld(
  () => window.__world?.seed === 18 && window.__world?.floor === 3 && window.__world?.tick > 120,
  45_000,
)
const w2 = await world()
check(armed, `scenario applied: seed 18, floor 3 (${JSON.stringify(w2)})`)
check(w2?.weapon === 'machinegun', `armed loadout (weapon ${w2?.weapon})`)
check(!logs.some((l) => /resumed in-progress run/.test(l)), 'did not resume the save')
await page.waitForTimeout(2000) // several autosave intervals
check(JSON.stringify(await save()) === JSON.stringify(original), 'save untouched by the scenario run')
await page.screenshot({ path: join(OUT, 'deep-link-armed.png') })

console.log('[deep-link-wins] 2b. a ?seed= link starts that seed, not the save')
logs.length = 0
await page.goto(`${BASE}/?mode=solo&seed=31337&e2e`)
const seeded = await waitForWorld(() => window.__world?.seed === 31337 && window.__world?.tick > 120, 45_000)
const w2b = await world()
check(seeded, `seed link applied: seed 31337 (${JSON.stringify(w2b)})`)
check(!logs.some((l) => /resumed in-progress run/.test(l)), 'did not resume the save')
await page.waitForTimeout(2000) // several autosave intervals
check(JSON.stringify(await save()) === JSON.stringify(original), 'save untouched by the seed run')

console.log('[deep-link-wins] 3. an unknown scenario is a visible error, not a run')
logs.length = 0
await page.goto(`${BASE}/?mode=solo&seed=18&scenario=no-such-scenario&e2e`)
const errShown = await page
  .waitForSelector('[data-role="boot-error"]', { timeout: 30_000 })
  .then((el) => el.innerText())
  .catch(() => null)
check(!!errShown && errShown.includes('no-such-scenario'), `error shown (${JSON.stringify(errShown?.slice(0, 80))})`)
check((await world()) === null, 'no run started behind the error')
check(!logs.some((l) => /resumed in-progress run/.test(l)), 'did not resume the save')
check(JSON.stringify(await save()) === JSON.stringify(original), 'save untouched')
await page.screenshot({ path: join(OUT, 'deep-link-unknown.png') })

console.log('[deep-link-wins] 4. a plain URL still resumes the original run')
logs.length = 0
await page.goto(`${BASE}/?mode=solo&e2e`)
await waitForWorld(() => !!window.__world)
await page.waitForTimeout(500)
const w4 = await world()
check(
  w4?.seed === originalSeed && logs.some((l) => /resumed in-progress run/.test(l)),
  `resumed seed ${originalSeed} (${JSON.stringify(w4)})`,
)

await browser.close()
if (failures.length) {
  console.error(`[deep-link-wins] ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('[deep-link-wins] PASS')
