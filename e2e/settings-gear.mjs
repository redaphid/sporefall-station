// End-to-end proof that the settings GEAR is tappable on a phone — the
// "i can't click the gear" bug class. The gear is UI CHROME: it must mount on
// #ui ABOVE the touch layer's full-screen stick zones (hit-test), carry
// data-ui-chrome (press classification exemption, chrome.ts), and its taps must
// open the panel with the theme picker reachable — WITHOUT ever leaking into
// the inspect/stick press classification.
//
//   • TOUCH context (real CDP touches, stick zones live):
//       – the gear is the element the browser actually hit-tests at its centre
//       – tap → panel opens; NO inspect chip, NO selection (press-exempt)
//       – the theme picker inside the panel is hit-testable and functions
//       – tap again → panel closes
//       – long-press ON the gear never opens the inspect card
//       – gameplay unharmed: stick drags still move the player, taps on NPCs
//         still inspect, taps on empty space still dismiss
//   • DESKTOP context (mouse): click toggles the panel (theme-swampspace e2e's
//     path keeps working).
//
// Loads the committed `comm-scene` world so entity ids/positions are exact.
// Run via e2e/run-settings-gear.sh (own port + own-server verification).

import { chromium } from 'playwright'
import { cpSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4963'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''
const SIZE = { width: 1280, height: 720 }

const failures = []
const fail = (m) => (console.error(`FAIL: ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)
const shots = []

const URL_PARAMS = new URLSearchParams({ mode: 'solo', e2e: '1', world: 'comm-scene' })

const boot = async (page) => {
  await page.goto(`${BASE}/?${URL_PARAMS}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__world && window.__project && window.__verb)
}

/** Centre of the gear button in client px. */
const gearAt = (page) =>
  page.evaluate(() => {
    const g = document.querySelector('button[aria-label="Settings"]')
    if (!g) return null
    const r = g.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })

/** Observable gear/panel/inspect state. */
const state = (page) =>
  page.evaluate(() => {
    const g = document.querySelector('button[aria-label="Settings"]')
    const panel = g?.nextElementSibling
    const card = document.querySelector('.inspect-card')
    return {
      gearMounted: !!g,
      gearChrome: !!g?.matches('[data-ui-chrome]'),
      gearOnUi: !!g?.closest('#ui'),
      panelOpen: !!panel && panel.style.display !== 'none',
      panelChrome: !!panel?.matches('[data-ui-chrome]'),
      themePicker: !!panel?.querySelector('#th'),
      inspectVisible: !!card && card.style.display !== 'none' && card.getBoundingClientRect().width > 0,
      selected: window.__world.entities.filter((e) => e.selected).map((e) => e.id),
    }
  })

const at = (page, id) =>
  page.evaluate((eid) => {
    const e = window.__world.entities.find((x) => x.id === eid)
    return window.__project(e.pos.x, e.pos.y)
  }, id)

const settle = (page, ms = 300) => page.waitForTimeout(ms)
const shot = async (page, label) => {
  await page.screenshot({ path: join(OUT, `gear-${label}.png`) })
  shots.push(`gear-${label}.png`)
}

const run = async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true })

  // ========================================================================
  // TOUCH CONTEXT — the phone case that shipped broken.
  // ========================================================================
  const touchCtx = await browser.newContext({ viewport: SIZE, hasTouch: true })
  const page = await touchCtx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))
  await boot(page)
  const cdp = await touchCtx.newCDPSession(page)
  const touchStart = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts })
  const touchMove = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts })
  const touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const tap = (x, y) => page.touchscreen.tap(x, y)

  const zones = await page.evaluate(() => document.querySelectorAll('[data-stick-zone]').length)
  zones === 2 ? ok('twin stick zones mounted (touch mode active)') : fail(`expected 2 stick zones, got ${zones}`)

  // --- 0. structure: the gear is chrome, on #ui, and WINS the hit test ----
  let s = await state(page)
  s.gearMounted ? ok('gear button mounted') : fail('no gear button')
  s.gearChrome ? ok('gear carries data-ui-chrome') : fail('gear not marked data-ui-chrome')
  s.panelChrome ? ok('panel carries data-ui-chrome') : fail('panel not marked data-ui-chrome')
  s.gearOnUi ? ok('gear mounts on #ui (above the stick zones)') : fail('gear is NOT on #ui — zones will swallow its taps')
  const g = await gearAt(page)
  const hit = await page.evaluate(
    (p) => document.elementFromPoint(p.x, p.y)?.closest('button[aria-label="Settings"]') !== null,
    g,
  )
  hit ? ok('browser hit test at the gear centre resolves to the GEAR (not a stick zone)') : fail('hit test at gear centre does not reach the gear')

  // Warm up the cold CDP touch path (same jank dance as inspect-ui.mjs).
  await tap(400, 650)
  await settle(page)

  // --- 1. TAP the gear → panel opens; no inspect side effects -------------
  await tap(g.x, g.y)
  await settle(page)
  s = await state(page)
  s.panelOpen ? ok('touch tap on the gear OPENED the settings panel') : fail('tap on gear did not open the panel')
  !s.inspectVisible ? ok('gear tap opened no inspect popup (press-exempt)') : fail('gear tap leaked into inspect')
  s.selected.length === 0 ? ok('gear tap selected no entity') : fail(`gear tap selected ${s.selected}`)
  s.themePicker ? ok('theme picker present in the panel') : fail('no theme picker (#th) in the panel')
  await shot(page, 'panel-open-touch')

  // --- 2. the theme picker is REACHABLE and functions ---------------------
  const thHit = await page.evaluate(() => {
    const th = document.querySelector('#th')
    const r = th.getBoundingClientRect()
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return el === th || th.contains(el)
  })
  thHit ? ok('hit test reaches the theme select (nothing covers the panel)') : fail('theme select is covered')
  await page.evaluate(() => {
    const th = document.querySelector('#th')
    th.value = 'swampspace'
    th.dispatchEvent(new Event('change'))
  })
  await settle(page, 600) // async theme swap
  const savedTheme = await page.evaluate(() => JSON.parse(localStorage.getItem('sor.settings') ?? '{}').theme)
  savedTheme === 'swampspace' ? ok('theme change persisted (picker functions)') : fail(`theme not saved: ${savedTheme}`)
  await shot(page, 'theme-swapped')

  // --- 3. tap the gear again → panel closes -------------------------------
  await tap(g.x, g.y)
  await settle(page)
  s = await state(page)
  !s.panelOpen ? ok('second tap closed the panel') : fail('panel did not close')

  // --- 4. gameplay is unharmed by the exemption ---------------------------
  const cop = await at(page, 2)
  await tap(cop.x, cop.y)
  await settle(page)
  s = await state(page)
  s.inspectVisible ? ok('tapping an NPC still opens the inspect chip') : fail('inspect broke: tap on NPC opened nothing')
  await tap(640, 650)
  await settle(page)
  s = await state(page)
  !s.inspectVisible ? ok('tap on empty space still dismisses') : fail('dismiss broke')

  const before = await page.evaluate(() => {
    const e = window.__world.entities.find((x) => x.id === 1)
    return { x: e.pos.x, y: e.pos.y }
  })
  await touchStart([{ x: 300, y: 400 }])
  for (let i = 1; i <= 6; i++) await touchMove([{ x: 300, y: 400 + i * 12 }])
  await page.waitForTimeout(400)
  await touchEnd()
  await settle(page)
  const after = await page.evaluate(() => {
    const e = window.__world.entities.find((x) => x.id === 1)
    return { x: e.pos.x, y: e.pos.y }
  })
  Math.hypot(after.x - before.x, after.y - before.y) > 0.3
    ? ok('left-half drag still drives the move stick')
    : fail('move stick broke')

  // --- 5. LONG-PRESS on the gear never opens the inspect card -------------
  await touchStart([{ x: g.x, y: g.y }])
  await page.waitForTimeout(600) // past LONG_PRESS_MS
  await touchEnd()
  await settle(page)
  s = await state(page)
  !s.inspectVisible ? ok('long-press ON the gear never inspects') : fail('long-press on gear opened the inspect card')

  await page.close()
  await touchCtx.close()

  // ========================================================================
  // DESKTOP CONTEXT — mouse keeps working (theme-swampspace e2e path).
  // ========================================================================
  const deskCtx = await browser.newContext({ viewport: SIZE })
  const desk = await deskCtx.newPage()
  desk.on('pageerror', (e) => errs.push(String(e)))
  desk.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))
  await boot(desk)
  await desk.click('button[aria-label="Settings"]')
  await settle(desk)
  let d = await state(desk)
  d.panelOpen ? ok('desktop mouse click opens the panel') : fail('mouse click broke')
  await shot(desk, 'panel-open-mouse')
  await desk.click('button[aria-label="Settings"]')
  await settle(desk)
  d = await state(desk)
  !d.panelOpen ? ok('desktop mouse click closes the panel') : fail('mouse close broke')

  await desk.close()
  await deskCtx.close()
  await browser.close()

  if (errs.length) for (const e of errs) fail(`page error: ${e}`)

  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    for (const s2 of shots) cpSync(join(OUT, s2), join(SHARE, s2))
  }
  console.log(`\n[settings-gear] ${shots.length} screenshots`)
  for (const s2 of shots) console.log(`  ${s2} (${statSync(join(OUT, s2)).size} bytes)`)
  if (failures.length) {
    console.error(`\n[settings-gear] ${failures.length} FAILURE(S)`)
    process.exitCode = 1
  } else console.log('\n[settings-gear] OK — all assertions passed')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
