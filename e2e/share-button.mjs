// End-to-end proof for the pause menu's SHARE STATE button.
//
// The claim being tested is not "shareState works" (state-link-roundtrip.mjs
// owns that) — it is "a person holding a PHONE, in a normal game, with no
// console and no `?debug`, can get a link onto their clipboard in two taps".
// Every URL here is deliberately debug-free.
//
//   A. Reachability, in a TOUCH context with the stick zones live:
//      – ⏸ is mounted on #ui, marked data-ui-chrome, and WINS the browser's
//        hit test at its own centre (the exact way the settings gear once
//        shipped mouse-only), and it is the ONLY route to pause on a phone —
//        Escape and the pad's Start do not exist there.
//      – tapping ⏸ opens the pause menu, with no inspect/selection side effects
//      – Share state is inside it and nothing covers it
//   B. The ring is armed WITHOUT `?debug` — the capture must carry real
//      run-up, or the button is capturing the corpse instead of the bug.
//   C. One tap: pending → a real URL → the clipboard actually holds it, and
//      the stored payload is really in the world store and really JSON.
//   D. Prove the check can fail: point the upload at a dead port and confirm
//      the button goes RED with the real reason, offers no URL, and never
//      paints a success.
//
// Usage: node e2e/share-button.mjs [origin]   (needs `wrangler dev` — the
// /state route is the Worker, not the static asset server)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ORIGIN = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:8787'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SEED = 20260820
const SIZE = { width: 900, height: 600 }

const ok = (m) => console.log(`  PASS  ${m}`)
const fail = (m) => {
  console.error(`  FAIL  ${m}`)
  process.exitCode = 1
}

const settle = (page, ms = 250) => page.waitForTimeout(ms)

/** Everything observable about the share control, in one round trip. */
const shareState = (page) =>
  page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const share = btns.find((b) => /Share state|Copy link|Capturing|Share again|Try again/.test(b.textContent ?? ''))
    const status = document.querySelector('[data-role="share-status"]')
    const link = document.querySelector('[data-role="share-url"]')
    return {
      label: share?.textContent ?? null,
      disabled: !!share?.disabled,
      status: status && status.style.display !== 'none' ? status.textContent : null,
      url: link && link.style.display !== 'none' ? link.value : null,
      /** Nothing may cover the button — a control you cannot tap is not a control. */
      hit: (() => {
        if (!share) return false
        const r = share.getBoundingClientRect()
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return el === share || share.contains(el)
      })(),
    }
  })

const pauseAt = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-role="pause-button"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      chrome: b.matches('[data-ui-chrome]'),
      onUi: !!b.closest('#ui'),
      visible: b.style.display !== 'none',
      hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-role="pause-button"]') !== null,
    }
  })

const boot = async (browser, query, viewport = SIZE) => {
  const ctx = await browser.newContext({ viewport, hasTouch: true, permissions: [] })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  await page.goto(`${ORIGIN}/?${query}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.world, null, { timeout: 30000 })
  return { ctx, page, errors }
}

/** Let the sim run long enough that the ring holds a full rotation of run-up. */
const playFor = (page, tick) =>
  page.waitForFunction((t) => window.world && window.world.tick >= t, tick, { timeout: 30000 })

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  // ── A. reachable from a phone, with NO ?debug anywhere ────────────────────
  const a = await boot(browser, `mode=solo&seed=${SEED}&e2e=1`)
  const { page } = a

  const zones = await page.evaluate(() => document.querySelectorAll('[data-stick-zone]').length)
  zones === 2 ? ok('twin stick zones mounted (this really is the touch case)') : fail(`expected 2 stick zones, got ${zones}`)

  await playFor(page, 90)
  let p = await pauseAt(page)
  if (!p) fail('no ⏸ button — the pause menu is unreachable on a phone')
  else {
    p.onUi ? ok('⏸ mounts on #ui (above the stick zones)') : fail('⏸ is NOT on #ui — the zones will swallow its taps')
    p.chrome ? ok('⏸ carries data-ui-chrome (press-exempt)') : fail('⏸ not marked data-ui-chrome')
    p.hit ? ok('browser hit test at the ⏸ centre resolves to the BUTTON') : fail('hit test at ⏸ centre does not reach it')
  }

  // Warm the cold CDP touch path before the tap that matters.
  await page.touchscreen.tap(450, 520)
  await settle(page)

  await page.touchscreen.tap(p.x, p.y)
  await settle(page, 400)
  const paused = await page.evaluate(() => !!window.world && document.body.innerText.includes('PAUSED'))
  paused ? ok('a TOUCH tap on ⏸ opened the pause menu') : fail('tap on ⏸ did not open the pause menu')
  const leaked = await page.evaluate(() => window.world.entities.filter((e) => e.selected).map((e) => e.id))
  leaked.length === 0 ? ok('the ⏸ tap selected nothing (never entered inspect)') : fail(`⏸ tap selected ${leaked}`)
  const hidden = await pauseAt(page)
  hidden && !hidden.visible ? ok('⏸ hides itself while the menu is up (Resume owns that)') : fail('⏸ still showing over the pause menu')

  let s = await shareState(page)
  s.label ? ok(`Share button present in the pause menu ("${s.label.trim()}")`) : fail('no Share button in the pause menu')
  s.hit ? ok('hit test reaches the Share button (nothing covers it)') : fail('Share button is covered')
  s.status === null && s.url === null ? ok('says nothing before the first tap') : fail(`stale state before tap: ${JSON.stringify(s)}`)
  await page.screenshot({ path: join(OUT, 'share-pause-menu.png') })

  // ── C. one tap: pending, then a real link on the clipboard ───────────────
  const shareBox = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Share state/.test(x.textContent ?? ''))
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.touchscreen.tap(shareBox.x, shareBox.y)

  // The pending state is the promise that the tap was heard. It is short, so
  // poll rather than sleep — but do NOT pass if it is simply never observed.
  let sawPending = false
  for (let i = 0; i < 60 && !sawPending; i++) {
    const now = await shareState(page)
    if (now.label?.includes('Capturing')) sawPending = true
    if (now.url) break
    await settle(page, 30)
  }
  sawPending ? ok('a pending state is shown while the capture runs') : fail('never showed a pending state — a silent button')

  await page.waitForFunction(
    () => {
      const l = document.querySelector('[data-role="share-url"]')
      const st = document.querySelector('[data-role="share-status"]')
      return (l && l.style.display !== 'none' && l.value) || (st && /Share failed/.test(st.textContent ?? ''))
    },
    null,
    { timeout: 60000 },
  )
  s = await shareState(page)
  if (!s.url) {
    fail(`share failed instead of producing a link: ${s.status}`)
  } else {
    ok(`produced a link: ${s.url}`)
    s.status?.includes('Copied to the clipboard')
      ? ok('reports the clipboard took it')
      : fail(`did not report a copy: ${s.status}`)

    // The clipboard claim, checked against the clipboard rather than believed.
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    clip === s.url ? ok('the clipboard really holds the link') : fail(`clipboard holds "${clip}", not the link`)

    // ── B. run-up, with no ?debug in sight ────────────────────────────────
    const runUp = /[\d.]+s of run-up/.exec(s.status ?? '')
    runUp ? ok(`link carries run-up without ?debug — "${runUp[0]}"`) : fail(`no run-up reported: ${s.status}`)

    // And the payload is really in the store, really JSON, really with frames.
    const id = new URL(s.url).searchParams.get('state')
    const res = await fetch(`${ORIGIN}/state/${id}`)
    const ctype = res.headers.get('content-type') ?? ''
    ctype.includes('application/json')
      ? ok(`stored payload served as JSON (${ctype})`)
      : fail(`stored payload served as "${ctype}" — SPA fallback?`)
    const payload = await res.json()
    payload.rewind?.frames?.length > 0
      ? ok(`the stored payload carries ${payload.rewind.frames.length} ticks of recorded input`)
      : fail('stored payload has no rewind frames — the ring was not armed')
    payload.meta?.note ? ok(`meta records where it came from ("${payload.meta.note}")`) : fail('no note in meta')
  }
  await page.screenshot({ path: join(OUT, 'share-copied.png') })

  // ── E. a REAL phone's landscape height ──────────────────────────────────
  // 780x360 is roughly an Android phone turned sideways, and the pause menu's
  // natural height is well over that: title + loadout panel + a row of buttons
  // + the status line + the link field. It fits only because the loadout panel
  // is flex-shrinkable and absorbs the difference — measured, not assumed:
  // giving that panel `flex-shrink:0` makes the check below go red on the link
  // field. The overlay does not scroll, so anything pushed past the edge is
  // simply GONE, and a link he cannot see or touch is no share button at all.
  const e = await boot(browser, `mode=solo&seed=${SEED}&e2e=1`, { width: 780, height: 360 })
  await playFor(e.page, 60)
  const ep = await pauseAt(e.page)
  await e.page.touchscreen.tap(20, 340) // warm the CDP touch path, off the play area
  await settle(e.page)
  await e.page.touchscreen.tap(ep.x, ep.y)
  await settle(e.page, 400)
  const inView = (sel) =>
    e.page.evaluate((s) => {
      const el =
        s === 'share'
          ? [...document.querySelectorAll('button')].find((x) => /Share state|Share again/.test(x.textContent ?? ''))
          : document.querySelector('[data-role="share-url"]')
      if (!el) return { found: false }
      const r = el.getBoundingClientRect()
      const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        found: true,
        fully: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0,
        hit: hitEl === el || el.contains(hitEl),
        bottom: Math.round(r.bottom),
      }
    }, sel)

  let v = await inView('share')
  v.found && v.fully ? ok(`at 780x360 the Share button is fully on screen (bottom ${v.bottom}px of 360)`) : fail(`Share button not fully on screen at phone height: ${JSON.stringify(v)}`)
  v.hit ? ok('and it wins the hit test there') : fail('Share button is covered at phone height')

  // The link only appears AFTER a share — which is exactly when the menu is at
  // its tallest, so this is the case most likely to overflow.
  const eBox = await e.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Share state/.test(x.textContent ?? ''))
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await e.page.touchscreen.tap(eBox.x, eBox.y)
  await e.page.waitForFunction(
    () => {
      const l = document.querySelector('[data-role="share-url"]')
      return l && l.style.display !== 'none' && l.value
    },
    null,
    { timeout: 60000 },
  )
  await settle(e.page, 200)
  v = await inView('link')
  v.found && v.fully ? ok(`the link field is fully on screen too (bottom ${v.bottom}px of 360)`) : fail(`the shared link is off-screen at phone height: ${JSON.stringify(v)}`)
  v.hit ? ok('and the link field is touchable (long-press can reach it)') : fail('the link field is covered at phone height')
  await e.page.screenshot({ path: join(OUT, 'share-phone-height.png') })

  // ── D. prove the check can fail ─────────────────────────────────────────
  // Same game, same button, upload pointed at a port with nothing on it. A
  // button that cannot go red is a button that cannot be trusted when green.
  const d = await boot(browser, `mode=solo&seed=${SEED}&e2e=1&stateOrigin=http://127.0.0.1:9`)
  await playFor(d.page, 60)
  const dp = await pauseAt(d.page)
  await d.page.touchscreen.tap(450, 520)
  await settle(d.page)
  await d.page.touchscreen.tap(dp.x, dp.y)
  await settle(d.page, 400)
  const dBox = await d.page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Share state/.test(x.textContent ?? ''))
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await d.page.touchscreen.tap(dBox.x, dBox.y)
  await d.page
    .waitForFunction(
      () => /Share failed/.test(document.querySelector('[data-role="share-status"]')?.textContent ?? ''),
      null,
      { timeout: 60000 },
    )
    .catch(() => {})
  const ds = await shareState(d.page)
  ds.status?.startsWith('Share failed')
    ? ok(`negative control went RED: "${ds.status}"`)
    : fail(`negative control stayed GREEN — status was "${ds.status}"`)
  ds.url === null ? ok('a failed share offers no URL to copy') : fail(`failed share still offered "${ds.url}"`)
  !ds.disabled && /Try again/.test(ds.label ?? '') ? ok('a failed share can be retried') : fail(`stuck after failure: "${ds.label}"`)
  await d.page.screenshot({ path: join(OUT, 'share-failed.png') })

  for (const [name, ctx] of [
    ['A', a],
    ['E', e],
    ['D', d],
  ])
    if (ctx.errors.length) console.log(`  note: context ${name} console errors: ${ctx.errors.slice(0, 3).join(' | ')}`)

  await browser.close()
  console.log(process.exitCode ? '\nSHARE BUTTON: FAILED\n' : '\nSHARE BUTTON: ALL CHECKS PASSED\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
