// End-to-end proof of controller button remapping through the REAL app:
// gear → Controller → capture → the overlay changes what fires on the next
// poll, persists across reload, and resets clean.
//
//   • rebind attack to B via the capture flow (fake pad presses B)
//   • the captured press is INERT: nothing fires while capture is open
//   • after the bind: B fires, A does not (swap moved interact onto A/RB/L2/R2)
//   • the swap is visible in the UI rows and in localStorage (sporefall.padmap v1)
//   • reload: the remap survives; B still fires, A still does not
//   • no-pads capture prompt explains Chrome's press-to-appear rule
//   • Reset to defaults: A fires again
//
// Run via e2e/run-gamepad-remap.sh (unique port + own-server verification).

import { chromium } from 'playwright'
import { cpSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4971'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''

const failures = []
const fail = (m) => (console.error(`FAIL: ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)
const shots = []

const run = async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

  // A mutable fake pad behind the real Gamepad API surface the app polls.
  await ctx.addInitScript(() => {
    const mk = (over = {}) => ({
      index: 0,
      id: 'Fake Pad (STANDARD GAMEPAD Vendor: beef Product: cafe)',
      connected: true,
      timestamp: 0,
      mapping: 'standard',
      axes: over.axes ?? [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => {
        const v = over.values?.[i] ?? (over.pressed?.includes(i) ? 1 : 0)
        return { pressed: over.pressed?.includes(i) ?? false, touched: v > 0, value: v }
      }),
    })
    window.__pads = [mk()]
    window.__setPad = (over) => { window.__pads = [mk(over)] }
    window.__noPads = () => { window.__pads = [] }
    navigator.getGamepads = () => window.__pads
  })

  const boot = async () => {
    await page.goto(`${BASE}/?mode=solo&seed=7&e2e`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.__world?.tick > 5)
  }
  const setPad = (over) => page.evaluate((o) => window.__setPad(o), over)
  const settle = (ms = 300) => page.waitForTimeout(ms)
  const shots_ = async (label) => {
    await page.screenshot({ path: join(OUT, `remap-${label}.png`) })
    shots.push(`remap-${label}.png`)
  }
  const projectiles = () => page.evaluate(() => window.__world.entities.filter((e) => e.kind === 'projectile').length)
  const bindText = (action) =>
    page.evaluate((a) => document.querySelector(`[data-remap-action="${a}"]`)?.textContent, action)
  const clickBind = (action) => page.click(`[data-remap-action="${action}"]`)
  const gear = 'button[aria-label="Settings"]'

  // --- boot + join the fake pad -------------------------------------------
  await boot()
  await setPad({ pressed: [9] }) // Start joins (inert join press)
  await settle()
  await setPad({})
  await settle()

  // Sanity: default layout — A fires.
  await setPad({ pressed: [0] })
  await settle(600)
  const defShots = await projectiles()
  await setPad({})
  await settle(600)
  defShots > 0 ? ok(`default layout: A fires (${defShots} projectiles)`) : fail('default layout: A did not fire')

  // --- open gear → Controller ---------------------------------------------
  await page.click(gear)
  await settle()
  const rows = await page.evaluate(() => document.querySelectorAll('[data-remap-action]').length)
  rows === 8 ? ok('Controller section shows all 8 action rows') : fail(`expected 8 remap rows, got ${rows}`)
  const attackDefault = await bindText('attack')
  attackDefault === 'A · RB · L2 · R2'
    ? ok('attack row names its default buttons canonically')
    : fail(`attack row shows '${attackDefault}'`)
  await shots_('panel-defaults')

  // --- capture: rebind attack to B ----------------------------------------
  await clickBind('attack')
  await settle(150)
  const prompt = await bindText('attack')
  prompt === 'press a button…' ? ok('capture prompt shown') : fail(`capture prompt was '${prompt}'`)
  await shots_('capture-mode')

  // The captured press must be INERT in gameplay.
  const before = await projectiles()
  await setPad({ pressed: [1] }) // press B while capturing
  await settle(500)
  const during = await projectiles()
  during === before ? ok('captured press fired nothing (inert)') : fail(`capture leaked: ${before} -> ${during} projectiles`)
  await setPad({})
  await settle(150)

  const attackNow = await bindText('attack')
  attackNow === 'B' ? ok('attack row rebound to B via capture') : fail(`attack row shows '${attackNow}' after capture`)
  const interactNow = await bindText('interact')
  interactNow === 'A · RB · L2 · R2'
    ? ok('SWAP: interact row inherited attack\'s old buttons')
    : fail(`interact row shows '${interactNow}' after swap`)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sporefall.padmap') ?? 'null'))
  stored?.v === 1 && String(stored?.map?.attack) === '1'
    ? ok('remap persisted to localStorage (sporefall.padmap v1)')
    : fail(`stored map wrong: ${JSON.stringify(stored)}`)
  await shots_('panel-rebound')

  // --- close panel; live behavior: B fires, A does not ---------------------
  await page.click(gear)
  await settle(600) // let old projectiles die out

  await setPad({ pressed: [1] })
  await settle(600)
  const bShots = await projectiles()
  await setPad({})
  await settle(700)
  bShots > 0 ? ok(`B now fires (${bShots} projectiles)`) : fail('B did not fire after rebind')

  await setPad({ pressed: [0] })
  await settle(600)
  const aShots = await projectiles()
  await setPad({})
  await settle(600)
  aShots === 0 ? ok('A no longer fires (attack moved off it)') : fail(`A still fires: ${aShots} projectiles`)

  // --- persistence across reload ------------------------------------------
  await boot()
  await setPad({ pressed: [9] })
  await settle()
  await setPad({})
  await settle(600)
  await setPad({ pressed: [1] })
  await settle(600)
  const bAfterReload = await projectiles()
  await setPad({})
  await settle(700)
  bAfterReload > 0 ? ok(`remap survives reload: B fires (${bAfterReload})`) : fail('after reload B did not fire')
  await setPad({ pressed: [0] })
  await settle(600)
  const aAfterReload = await projectiles()
  await setPad({})
  await settle(600)
  aAfterReload === 0 ? ok('after reload A still does not fire') : fail(`after reload A fires: ${aAfterReload}`)

  await page.click(gear)
  await settle()
  const reloadRow = await bindText('attack')
  reloadRow === 'B' ? ok('panel shows the persisted binding after reload') : fail(`panel shows '${reloadRow}' after reload`)

  // --- no-pads capture prompt ---------------------------------------------
  await page.evaluate(() => window.__noPads())
  await clickBind('roll')
  await settle(200)
  const noPads = await bindText('roll')
  noPads?.includes('no controller detected')
    ? ok('empty getGamepads() → capture explains press-to-appear')
    : fail(`no-pads prompt was '${noPads}'`)
  await shots_('no-controller')
  await page.keyboard.press('Escape')
  await settle(100)
  const cancelled = await bindText('roll')
  cancelled === 'LB' ? ok('Esc cancels capture and restores the row') : fail(`after Esc roll row shows '${cancelled}'`)
  await page.evaluate(() => window.__setPad({}))

  // --- reset to defaults ---------------------------------------------------
  await page.click('#ctl-reset')
  await settle(150)
  const resetRow = await bindText('attack')
  resetRow === 'A · RB · L2 · R2' ? ok('Reset to defaults restores the rows') : fail(`after reset attack row is '${resetRow}'`)
  await page.click(gear)
  await settle(600)
  // The no-pads dance above disconnected the pad, so it is UNJOINED now: the
  // first A press is spent on joining (inert until released — the join rule).
  // Release, then a fresh press must fire on the restored defaults.
  await setPad({ pressed: [0] })
  await settle()
  await setPad({})
  await settle(400)
  await setPad({ pressed: [0] })
  await settle(600)
  const aRestored = await projectiles()
  await setPad({})
  aRestored > 0 ? ok(`after reset A fires again (${aRestored})`) : fail('after reset A does not fire')

  await browser.close()

  if (errs.length) for (const e of errs) fail(`page error: ${e}`)
  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    for (const s of shots) cpSync(join(OUT, s), join(SHARE, s))
  }
  console.log(`\n[gamepad-remap] ${shots.length} screenshots`)
  for (const s of shots) console.log(`  ${s} (${statSync(join(OUT, s)).size} bytes)`)
  if (failures.length) {
    console.error(`\n[gamepad-remap] ${failures.length} FAILURE(S)`)
    process.exitCode = 1
  } else console.log('\n[gamepad-remap] OK — all assertions passed')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
