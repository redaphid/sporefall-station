// LANDSCAPE-ALWAYS: does the game present landscape on a phone stuck in
// portrait, and — the part that actually matters — does INPUT rotate with it?
//
// THE BUG THIS EXISTS TO CATCH: if the view rotates and the input mapping does
// not, every control is 90° out (press left, go up). That failure is invisible
// on a desktop, which is never rotated, and total on a phone. A unit test can
// check the arithmetic; only a real browser can check the arithmetic AGAINST A
// REAL LAYOUT ENGINE — that the CSS transform lands where we think, that
// hit-testing through it reaches the right element, and that a real touch
// sequence moves the character the way the player pointed.
//
// So this drives REAL CDP touch events at a REAL portrait viewport and asserts
// on how far the player actually TRAVELLED in the sim — not on a screenshot.
//
// The contrast case is the whole point: the SAME physical swipe is run in a
// portrait context (rotated) and a landscape context (not rotated), and the two
// must disagree. If they agree, the input mapping did not rotate and the feature
// is broken no matter how right the screenshot looks.
//
// Run: ./e2e/run-landscape-rotation.sh   (own port + own-server verification)

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4931'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')

// A realistic phone in portrait, and the same device turned on its side.
const PORTRAIT = { width: 412, height: 915 }
const LANDSCAPE = { width: 915, height: 412 }

const failures = []
const fail = (m) => (console.error(`  FAIL — ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)


mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()

/** Boot the game in a context of the given size, with touch + a coarse pointer. */
const open = async (size) => {
  const ctx = await browser.newContext({
    viewport: size,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))
  await page.goto(`${BASE}/?mode=solo&e2e=1&seed=4242`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__world && window.__verb)
  return { ctx, page, errs }
}

/**
 * Hold a touch drag and report what the SIM did: how far the player actually
 * TRAVELLED over the hold.
 *
 * Travel, not `entity.vel` — vel reads 0 from outside the tick (the movement
 * system consumes it), so sampling it from the page always said "no movement"
 * even in the unrotated control case. Displacement is the honest observable:
 * it is what the player sees, and it cannot be faked by a transform.
 */
const dragAndRead = async (page, ctx, from, to, ms = 420) => {
  const cdp = await ctx.newCDPSession(page)
  const pt = ([x, y]) => [{ x, y, radiusX: 6, radiusY: 6, force: 1, id: 1 }]
  const before = await page.evaluate(() => {
    const p = window.__world.entities.find((e) => e.playerCtl)
    return { x: p.pos.x, y: p.pos.y }
  })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) })
  // Several move events: the first CDP dispatch on a cold page can land late,
  // and one lone move would leave the stick reading whatever it read at down.
  for (let i = 1; i <= 4; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / 4
    const y = from[1] + ((to[1] - from[1]) * i) / 4
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt([x, y]) })
  }
  await page.waitForTimeout(ms)
  const held = await page.evaluate(() => {
    const p = window.__world.entities.find((e) => e.playerCtl)
    return { x: p.pos.x, y: p.pos.y }
  })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(120)
  await cdp.detach()
  const dx = held.x - before.x
  const dy = held.y - before.y
  return { dx, dy, went: heading(dx, dy), say: `travelled ${dx.toFixed(2)}, ${dy.toFixed(2)}` }
}

/** Which cardinal direction a (x,y) displacement points, or null if ~still. */
const heading = (x, y) => {
  if (Math.hypot(x, y) < 0.05) return null // below this the player never moved
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up'
}

// ── 1. PORTRAIT: the phone will not turn, so the game must ──────────────────
console.log('\n[portrait 412x915 — the phone is stuck in portrait]')
const { ctx: pCtx, page: pPage, errs: pErrs } = await open(PORTRAIT)

const gate = await pPage.evaluate(() => ({
  coarse: window.matchMedia('(pointer: coarse)').matches,
  transform: document.getElementById('stage').style.transform,
  w: document.getElementById('stage').style.width,
  h: document.getElementById('stage').style.height,
  canvas: (() => {
    const c = document.querySelector('#app canvas')
    return { w: c.clientWidth, h: c.clientHeight }
  })(),
  zones: document.querySelectorAll('[data-stick-zone]').length,
  lockable: typeof screen.orientation?.lock === 'function',
}))

gate.coarse ? ok('primary pointer is coarse (the rotation gate is live)') : fail('pointer is not coarse')
gate.transform === 'translate(412px, 0px) rotate(90deg)'
  ? ok(`stage rotated: ${gate.transform}`)
  : fail(`stage transform was "${gate.transform}"`)
gate.w === '915px' && gate.h === '412px'
  ? ok(`stage box swapped to ${gate.w}x${gate.h} — landscape on a portrait screen`)
  : fail(`stage box was ${gate.w}x${gate.h}, expected 915px x 412px`)
gate.canvas.w > gate.canvas.h
  ? ok(`pixi canvas followed the stage: ${gate.canvas.w}x${gate.canvas.h} (landscape)`)
  : fail(`canvas is ${gate.canvas.w}x${gate.canvas.h} — renderer did not follow the rotation`)
gate.zones === 2 ? ok('twin stick zones mounted') : fail(`expected 2 stick zones, got ${gate.zones}`)
console.log(`  note — screen.orientation.lock available in this browser: ${gate.lockable}`)

// Hit-testing THROUGH the transform: the stage's left half (the move stick) is
// physically the TOP half of a portrait screen. If the browser disagrees with
// our maths, this is where it shows up.
const hit = await pPage.evaluate(() => {
  const top = document.elementFromPoint(206, 200)
  const bottom = document.elementFromPoint(206, 700)
  return { top: top?.dataset?.stickZone ?? top?.tagName, bottom: bottom?.dataset?.stickZone ?? bottom?.tagName }
})
hit.top === 'left'
  ? ok('hit-test: the physical TOP half of the screen is the MOVE stick (stage-left)')
  : fail(`physical top half hit-tested as "${hit.top}", expected the left/move zone`)
hit.bottom === 'right'
  ? ok('hit-test: the physical BOTTOM half is the AIM stick (stage-right)')
  : fail(`physical bottom half hit-tested as "${hit.bottom}", expected the right/aim zone`)

await pPage.screenshot({ path: join(OUT, 'landscape-portrait-device.png') })

// THE TRAP. On the rotated stage the player's "up" is the physical +X of the
// portrait viewport, and their "right" is the physical +Y.
console.log('  driving real touch drags…')
const pUp = await dragAndRead(pPage, pCtx, [206, 228], [306, 228])
const pRight = await dragAndRead(pPage, pCtx, [206, 228], [206, 348])

pUp.went === 'up'
  ? ok(`swipe toward physical +X → player moves UP (${pUp.say})`)
  : fail(`swipe toward physical +X → player went "${pUp.went}" (${pUp.say}) — INPUT DID NOT ROTATE`)
pRight.went === 'right'
  ? ok(`swipe toward physical +Y → player moves RIGHT (${pRight.say})`)
  : fail(`swipe toward physical +Y → player went "${pRight.went}" (${pRight.say}) — INPUT DID NOT ROTATE`)
// A HALF-rotated mapping (view turned, one axis fixed) shows up as bleed into
// the axis that should be untouched, which a cardinal-direction check would miss.
Math.abs(pUp.dx) < Math.abs(pUp.dy) * 0.25
  ? ok('the "up" swipe has no sideways bleed (a partial rotation would show here)')
  : fail(`"up" swipe leaked ${pUp.dx.toFixed(3)} into X against ${pUp.dy.toFixed(3)} in Y`)

// ── 1b. The START MENU on the rotated stage ─────────────────────────────────
// Rotating turns a tall 412x915 viewport into a SHORT 915x412 stage, and the
// menu/lobby panels are the tallest DOM in the game. A panel that overflowed
// would be unreachable — there is no page scroll (body is overflow:hidden).
{
  const ctx = await browser.newContext({ viewport: PORTRAIT, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/?e2e=1&seed=4242`, { waitUntil: 'networkidle' }) // no ?mode= → picker shows
  await page.waitForSelector('button')
  const fit = await page.evaluate(() => {
    const stage = document.getElementById('stage')
    const sh = stage.clientHeight
    const sw = stage.clientWidth
    // Measure in the stage's own (rotated) space: offset* is layout-local, so
    // it is unaffected by the transform — exactly what we want to compare.
    let maxB = 0
    let maxR = 0
    for (const el of document.querySelectorAll('#ui *')) {
      if (!el.offsetParent && el.offsetHeight === 0) continue
      maxB = Math.max(maxB, el.offsetTop + el.offsetHeight)
      maxR = Math.max(maxR, el.offsetLeft + el.offsetWidth)
    }
    return { sw, sh, maxB, maxR, buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()) }
  })
  fit.maxB <= fit.sh + 1
    ? ok(`start menu fits the short rotated stage (${fit.maxB}px deep in ${fit.sh}px)`)
    : fail(`start menu overflows the rotated stage: ${fit.maxB}px deep in ${fit.sh}px — unreachable, body has no scroll`)
  fit.maxR <= fit.sw + 1
    ? ok(`start menu fits horizontally (${fit.maxR}px wide in ${fit.sw}px)`)
    : fail(`start menu overflows horizontally: ${fit.maxR}px in ${fit.sw}px`)
  console.log(`  note — menu buttons: ${fit.buttons.join(' / ')}`)
  await page.screenshot({ path: join(OUT, 'landscape-portrait-menu.png') })
  await ctx.close()
}

// ── 2. LANDSCAPE: the same swipe must mean something ELSE ───────────────────
console.log('\n[landscape 915x412 — the same device turned; no rotation applied]')
const { ctx: lCtx, page: lPage, errs: lErrs } = await open(LANDSCAPE)
const lGate = await lPage.evaluate(() => document.getElementById('stage').style.transform)
lGate === 'none' ? ok('stage NOT rotated (already landscape)') : fail(`stage transform was "${lGate}"`)
await lPage.screenshot({ path: join(OUT, 'landscape-landscape-device.png') })

const lRight = await dragAndRead(lPage, lCtx, [206, 228], [306, 228])
lRight.went === 'right'
  ? ok(`the SAME physical +X swipe moves RIGHT here (${lRight.say})`)
  : fail(`unrotated +X swipe went "${lRight.went}" (${lRight.say}), expected right`)

// The contrast is the proof: same gesture, different meaning, because the screen
// turned underneath it. If these two ever agree, the mapping stopped rotating.
pUp.went && lRight.went && pUp.went !== lRight.went
  ? ok(`CONTRAST HOLDS: identical swipe → "${lRight.went}" unrotated vs "${pUp.went}" rotated`)
  : fail(`the same swipe means "${pUp.went}"/"${lRight.went}" — input is NOT rotating`)

for (const e of [...pErrs, ...lErrs]) fail(`page error: ${e}`)

await browser.close()

console.log(`\nstills → ${OUT}`)
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\nAll landscape-rotation checks passed.')
