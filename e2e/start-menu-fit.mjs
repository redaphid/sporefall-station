// START MENU FITS ON A PHONE: every button on the Solo / Host / Join / Settings
// picker is on screen, hit-testable and a real thumb-sized target, at the phone
// viewports people actually hold — and desktop is unharmed.
//
// THE BUG THIS EXISTS TO CATCH: on a coarse-pointer phone held in portrait the
// WHOLE stage is rotated to landscape (src/ui/orientation.ts), so a 360x640
// phone lays the menu out in a 640x360 box — minus browser chrome. The menu
// used to be a fixed-size, vertically-centred column (four ~70px buttons, a big
// version readout and four release-note lines, ~450px tall). In a ~360px-tall
// box a centred flex column overflows at BOTH ends, and the top half can never
// be scrolled back into view: the Solo button was simply gone.
//
// Asserts, per viewport, in a REAL layout engine (not a screenshot eyeball):
//   • every menu button's box lies fully inside the viewport
//   • the element the browser hit-tests at each button's centre IS that button
//   • every button is at least 44x44 CSS px (thumb target)
//   • the menu does not overflow sideways
//
// Run: ./e2e/run-start-menu-fit.sh   (own port + own-server verification)
// Screenshots land in $E2E_OUT/start-menu-<label>.png.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4977'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const MIN_TARGET = 44

const VIEWPORTS = [
  { label: '360x640-portrait', width: 360, height: 640, phone: true },
  { label: '390x844-portrait', width: 390, height: 844, phone: true },
  { label: '412x915-portrait', width: 412, height: 915, phone: true },
  { label: '844x390-landscape', width: 844, height: 390, phone: true },
  { label: '640x360-landscape', width: 640, height: 360, phone: true },
  // Tiny: a landscape phone with the URL bar AND the nav bar showing. Does not
  // need to fit unscrolled, but every button must still be reachable.
  { label: '568x280-landscape-cramped', width: 568, height: 280, phone: true, mayScroll: true },
  { label: '1280x720-desktop', width: 1280, height: 720, phone: false },
]

const failures = []
const fail = (m) => (console.error(`  FAIL — ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)

mkdirSync(OUT, { recursive: true })
// No GPU: this suite only measures the DOM menu, and on some hosts (WSL) the
// headless GPU process takes the whole browser down the moment pixi asks for a
// context. Software-only keeps the run about layout, not about the host's GPU.
const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-software-rasterizer'] })

/** The start menu's own buttons (not the settings panel's, which also lives on #ui). */
const MENU_BUTTONS = `() => {
  const solo = Array.from(document.querySelectorAll('#ui button')).find((b) => b.textContent.trim().startsWith('Solo run'))
  const menu = solo?.closest('[data-role="start-menu"]') ?? solo?.parentElement
  return menu ? Array.from(menu.querySelectorAll('button')) : []
}`

const measure = (page) =>
  page.evaluate((src) => {
    const buttons = (0, eval)(src)()
    const menu = buttons[0]?.closest('[data-role="start-menu"]') ?? buttons[0]?.parentElement
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      menuOverflowX: menu ? menu.scrollWidth - menu.clientWidth : null,
      buttons: buttons.map((b) => {
        const r = b.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const hit = document.elementFromPoint(cx, cy)
        return {
          text: b.textContent.trim().split(/\s+/).slice(0, 2).join(' '),
          // Unrotated (stage-space) size — the target the thumb actually gets.
          w: b.offsetWidth,
          h: b.offsetHeight,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          hitOk: !!hit && (hit === b || b.contains(hit)),
        }
      }),
    }
  }, MENU_BUTTONS)

for (const vp of VIEWPORTS) {
  console.log(`\n[start-menu-fit] ${vp.label}`)
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.phone,
    isMobile: vp.phone,
    deviceScaleFactor: vp.phone ? 2 : 1,
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${BASE}/?e2e=1`, { waitUntil: 'networkidle' })
  try {
    await page.waitForFunction((src) => (0, eval)(src)().length >= 3, MENU_BUTTONS, { timeout: 15000 })
  } catch {
    fail(`${vp.label}: start menu never appeared (${errs.join(' | ') || 'no page errors'})`)
    await ctx.close()
    continue
  }
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, `start-menu-${vp.label}.png`) })

  if (vp.mayScroll) {
    // Every button must be REACHABLE: scroll each into view, then hit-test it.
    const n = (await measure(page)).buttons.length
    for (let i = 0; i < n; i++) {
      await page.evaluate(([src, j]) => (0, eval)(src)()[j].scrollIntoView({ block: 'center' }), [MENU_BUTTONS, i])
      const b = (await measure(page)).buttons[i]
      if (!b.hitOk) fail(`${vp.label}: "${b.text}" not reachable even after scrolling`)
      if (b.w < MIN_TARGET || b.h < MIN_TARGET) fail(`${vp.label}: "${b.text}" target ${b.w}x${b.h} < ${MIN_TARGET}`)
    }
    if (!failures.some((f) => f.startsWith(vp.label))) ok(`${n} buttons reachable by scrolling, all >= ${MIN_TARGET}px`)
    await ctx.close()
    continue
  }

  const m = await measure(page)
  const before = failures.length
  if (m.buttons.length < 4) fail(`${vp.label}: expected 4 menu buttons, found ${m.buttons.length}`)
  for (const b of m.buttons) {
    const inside = b.left >= -0.5 && b.top >= -0.5 && b.right <= m.vw + 0.5 && b.bottom <= m.vh + 0.5
    if (!inside)
      fail(
        `${vp.label}: "${b.text}" off-screen — box ${b.left.toFixed(0)},${b.top.toFixed(0)}→` +
          `${b.right.toFixed(0)},${b.bottom.toFixed(0)} in ${m.vw}x${m.vh}`,
      )
    if (!b.hitOk) fail(`${vp.label}: "${b.text}" is not the element hit-tested at its centre`)
    if (b.w < MIN_TARGET || b.h < MIN_TARGET) fail(`${vp.label}: "${b.text}" target ${b.w}x${b.h} < ${MIN_TARGET}`)
  }
  if (m.menuOverflowX > 0.5) fail(`${vp.label}: menu overflows sideways by ${m.menuOverflowX}px`)
  if (failures.length === before)
    ok(`${m.buttons.length} buttons on screen, hit-testable, min ${Math.min(...m.buttons.map((b) => Math.min(b.w, b.h)))}px`)
  await ctx.close()
}

await browser.close()
if (failures.length > 0) {
  console.error(`\n[start-menu-fit] ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\n[start-menu-fit] PASS')
