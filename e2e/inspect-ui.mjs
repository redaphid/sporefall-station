// End-to-end proof of the object info popup (tap / long-press inspect), driven
// against the REAL pixi build with REAL input paths:
//
//   • TOUCH context (CDP-dispatched touch events → the actual stick-zone press
//     discrimination in touch.ts/pressModel.ts): quick tap on an NPC → compact
//     CHIP; tapping the chip expands it; long-press (500ms hold) → full CARD
//     with live AI state; a >slop drag never inspects; a two-finger pinch never
//     inspects; tap on empty space dismisses; killing the inspected entity
//     shows the destroyed state then auto-closes; inspect works at zoom 0.5×
//     and 4× (zoom-aware pick radius).
//   • DESKTOP context (mouse): click → full card immediately; ✕ closes; a mouse
//     drag never inspects; the mission-target card offers the locate action and
//     clicking it glides the camera to the target (focusModel machinery).
//
// Loads the committed `comm-scene` world so entity ids/positions are exact.
// Serves nothing itself — run via e2e/run-inspect-ui.sh (own port + own-server
// verification + ffmpeg mux). Video: the touch context is recorded.

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4917'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''
const SIZE = { width: 1280, height: 720 }

const failures = []
const fail = (m) => (console.error(`FAIL: ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)
const shots = []

const URL_PARAMS = new URLSearchParams({ mode: 'solo', e2e: '1', world: 'comm-scene' })

/** Common page bootstrap: navigate, wait for the world + helpers. */
const boot = async (page) => {
  await page.goto(`${BASE}/?${URL_PARAMS}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__world && window.__project && window.__verb)
}

/** Screen position of an entity via the LIVE camera. */
const at = (page, id) =>
  page.evaluate((eid) => {
    const e = window.__world.entities.find((x) => x.id === eid)
    return window.__project(e.pos.x, e.pos.y)
  }, id)

/** Read the popup's observable state from the DOM. */
const popup = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('.inspect-card')
    const vis = !!card && card.style.display !== 'none' && card.getBoundingClientRect().width > 0
    const r = card ? card.getBoundingClientRect() : null
    return {
      visible: vis,
      mode: card?.dataset.mode ?? null,
      title: card?.querySelector('[data-inspect-title]')?.textContent ?? '',
      tagline: card?.querySelector('[data-inspect-tagline]')?.textContent ?? '',
      hp: card?.querySelector('[data-inspect-hp]')?.dataset.inspectHp ?? '',
      hasClose: !!card?.querySelector('[data-inspect-close]'),
      hasMission: !!card?.querySelector('[data-inspect-mission]'),
      hasThumb: !!card?.querySelector('img'),
      text: card?.textContent ?? '',
      rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
      selected: window.__world.entities.filter((e) => e.selected).map((e) => e.id),
      ringPresent: !!document.querySelector('.selection-ring'),
    }
  })

const onScreen = (p) =>
  p.rect && p.rect.x >= 0 && p.rect.y >= 0 && p.rect.x + p.rect.w <= SIZE.width && p.rect.y + p.rect.h <= SIZE.height

const settle = (page, ms = 300) => page.waitForTimeout(ms)
const shot = async (page, label) => {
  await page.screenshot({ path: join(OUT, `inspect-${label}.png`) })
  shots.push(`inspect-${label}.png`)
}

// ---------------------------------------------------------------------------
const run = async () => {
  mkdirSync(OUT, { recursive: true })
  const videoDir = join(OUT, 'video-inspect-ui')
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })

  // ========================================================================
  // TOUCH CONTEXT (recorded) — real stick zones, real claiming, CDP touches.
  // ========================================================================
  const touchCtx = await browser.newContext({
    viewport: SIZE,
    hasTouch: true,
    recordVideo: { dir: videoDir, size: SIZE },
  })
  const page = await touchCtx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))
  await boot(page)
  const cdp = await touchCtx.newCDPSession(page)
  const touchStart = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts })
  const touchMove = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts })
  const touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  // Atomic tap: no JS-side wait between down/up, so headless dispatch jank can
  // never stretch a tap past the long-press threshold (a stretched press being
  // classified as a long-press would be CORRECT behavior, but not what these
  // steps mean to exercise). Raw CDP events below are only for held gestures.
  const tap = (x, y) => page.touchscreen.tap(x, y)

  // Sanity: touch controls actually mounted (stick zones own the screen).
  const zones = await page.evaluate(() => document.querySelectorAll('[data-stick-zone]').length)
  zones === 2 ? ok('twin stick zones mounted (touch mode active)') : fail(`expected 2 stick zones, got ${zones}`)
  // Keep the player alive through the whole reel (hostile NPCs act freely).
  await page.evaluate(() => window.__verb('set 1 {"health":{"hp":5000,"max":5000}}'))

  // Warm up the input path: the very first CDP touch dispatch on a fresh
  // headless page lands hundreds of ms late (shader/JIT jank), which would
  // stretch an intended quick tap past the 400ms long-press threshold — the
  // classifier would be RIGHT to call that a long-press. One throwaway tap on
  // empty space flushes the cold path so subsequent gestures land promptly.
  await tap(400, 650)
  await settle(page)

  // --- 1. quick tap on the cop → compact CHIP -----------------------------
  const cop = await at(page, 2)
  await tap(cop.x, cop.y)
  await settle(page)
  let p = await popup(page)
  p.visible && p.mode === 'chip' ? ok(`tap → chip (“${p.title}”)`) : fail(`tap should open a chip, got ${JSON.stringify(p)}`)
  p.title.includes('Cop') ? ok('chip is themed-titled Cop') : fail(`chip title: “${p.title}”`)
  p.selected.includes(2) ? ok('tapped cop is Entity.selected') : fail(`selected: ${p.selected}`)
  p.ringPresent ? ok('highlight ring present') : fail('no selection ring')
  onScreen(p) ? ok('chip fully on-screen') : fail(`chip rect off-screen: ${JSON.stringify(p.rect)}`)
  await shot(page, 'chip-npc')

  // --- 2. tap the CHIP itself → expands to the full card ------------------
  await tap(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2)
  await settle(page)
  p = await popup(page)
  p.visible && p.mode === 'card' ? ok('chip tap expanded to full card') : fail(`chip should expand, got mode=${p.mode}`)
  p.hp.length > 0 ? ok(`card shows hp bar (${p.hp})`) : fail('no hp bar on NPC card')
  p.tagline.length > 0 ? ok(`card shows live AI state: “${p.tagline}”`) : fail('no AI tagline')
  p.text.includes('Toward you') ? ok('card shows stance toward the player') : fail(`card text: ${p.text}`)
  await shot(page, 'card-npc-expanded')

  // --- 3. tap empty space → dismissed -------------------------------------
  await tap(640, 650) // street south of the scene
  await settle(page)
  p = await popup(page)
  !p.visible && p.selected.length === 0 ? ok('tap on empty space dismissed popup + selection') : fail(`not dismissed: ${JSON.stringify(p)}`)

  // --- 4. LONG-PRESS a thug → full card straight away, live AI state ------
  const thug = await at(page, 3)
  await touchStart([{ x: thug.x, y: thug.y }])
  // Poll (still held): the long-press timer fires at 400ms after the pointer-
  // down actually lands, and the card paints on the NEXT animation frame — a
  // fixed sleep races both under headless dispatch lag.
  const heldVisible = await page
    .waitForFunction(
      () => {
        const c = document.querySelector('.inspect-card')
        return !!c && c.style.display !== 'none' && c.dataset.mode === 'card'
      },
      { timeout: 2000 },
    )
    .then(() => true)
    .catch(() => false)
  p = await popup(page)
  heldVisible ? ok('long-press opened the full card WHILE HELD') : fail(`long-press hold: ${JSON.stringify(p)}`)
  await touchEnd()
  await settle(page)
  p = await popup(page)
  p.visible && p.mode === 'card' ? ok('card persists after release') : fail('card vanished on release')
  p.title.includes('Thug') ? ok('card titled Thug') : fail(`title: “${p.title}”`)
  p.text.includes('Faction') && p.text.includes('Nature') ? ok('NPC rows (Faction/Nature) present') : fail(`rows: ${p.text}`)
  p.hasThumb ? ok('sprite thumbnail rendered') : fail('no sprite thumbnail on card')
  await shot(page, 'card-npc-longpress')

  // --- 5. kill the inspected thug → destroyed state, then auto-close ------
  await page.evaluate(() => window.__verb('kill 3'))
  await page.waitForTimeout(400) // < DESTROYED_TICKS (1.2s) — still lingering
  p = await popup(page)
  p.visible && /destroyed/i.test(p.text) ? ok('death mid-inspect shows destroyed state') : fail(`destroyed state: ${JSON.stringify(p)}`)
  await shot(page, 'card-destroyed')
  await page.waitForTimeout(1400) // past the lingering window
  p = await popup(page)
  !p.visible ? ok('destroyed card auto-closed') : fail('destroyed card never closed')

  // --- 6. drag (>12px) never inspects — it IS the stick -------------------
  const before = await page.evaluate(() => {
    const e = window.__world.entities.find((x) => x.id === 1)
    return { x: e.pos.x, y: e.pos.y }
  })
  // Start over thug 5 but nudged into the LEFT (move-stick) half, then drag:
  // the press starts on an entity yet must never inspect — it becomes the stick.
  const t5 = await at(page, 5)
  const sx = Math.min(t5.x - 25, 620)
  await touchStart([{ x: sx, y: t5.y }])
  for (let i = 1; i <= 6; i++) await touchMove([{ x: sx, y: t5.y + i * 12 }]) // pull DOWN — walk south
  await page.waitForTimeout(600) // held long past the long-press threshold
  await touchEnd()
  await settle(page)
  p = await popup(page)
  !p.visible ? ok('a drag never inspects (press became the stick)') : fail('drag opened a popup')
  const after = await page.evaluate(() => {
    const e = window.__world.entities.find((x) => x.id === 1)
    return { x: e.pos.x, y: e.pos.y }
  })
  const moved = Math.hypot(after.x - before.x, after.y - before.y)
  moved > 0.3 ? ok(`the drag DROVE the stick (player moved ${moved.toFixed(2)} tiles) — no input stolen`) : fail(`player did not move (${moved})`)

  // --- 7. two-finger pinch never inspects ---------------------------------
  const mid = { x: 320, y: 360 } // LEFT half (pinch = two fingers, same half)
  await touchStart([{ x: mid.x - 40, y: mid.y }])
  await touchStart([{ x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y }])
  for (let i = 1; i <= 5; i++)
    await touchMove([{ x: mid.x - 40 - i * 10, y: mid.y }, { x: mid.x + 40 + i * 10, y: mid.y }])
  await touchEnd()
  await settle(page)
  p = await popup(page)
  !p.visible ? ok('a pinch never inspects (second finger disqualifies)') : fail('pinch opened a popup')

  // --- 8. inspect at zoom extremes (0.5× and 4×) --------------------------
  // Bring the player back to the scene (the drag test walked them away) so the
  // camera frames the entities we tap at 4×.
  await page.evaluate(() => window.__verb('teleport 1 20 11'))
  await page.evaluate(() => window.__zoom(0.5, true))
  await settle(page, 400)
  const gangOut = await at(page, 4)
  await touchStart([{ x: gangOut.x, y: gangOut.y }])
  await page.waitForTimeout(550)
  await touchEnd()
  await settle(page)
  p = await popup(page)
  p.visible && p.mode === 'card' && p.title.includes('Gangster')
    ? ok('long-press inspects at 0.5× zoom (grown pick radius)')
    : fail(`zoom-out inspect: ${JSON.stringify({ mode: p.mode, title: p.title })}`)
  onScreen(p) ? ok('zoomed-out card clamped on-screen') : fail(`card off-screen: ${JSON.stringify(p.rect)}`)
  await shot(page, 'card-zoom-out')

  await page.evaluate(() => window.__zoom(4, true))
  await settle(page, 400)
  const med = await at(page, 6)
  await tap(med.x, med.y)
  await settle(page)
  p = await popup(page)
  p.visible && p.title.includes('Grenade') ? ok('tap inspects the grenade at 4× zoom') : fail(`zoom-in inspect: ${JSON.stringify({ mode: p.mode, title: p.title })}`)
  await shot(page, 'chip-item-zoom-in')
  // Expand to show the item card (heal stat).
  await tap(p.rect.x + p.rect.w / 2, p.rect.y + p.rect.h / 2)
  await settle(page)
  p = await popup(page)
  p.mode === 'card' && p.text.includes('Heal') ? ok('item card shows the heal stat') : fail(`item card: ${p.text}`)
  await shot(page, 'card-item')
  await page.evaluate(() => window.__zoom(1, true))
  await tap(640, 650)
  await settle(page)

  await page.close()
  await touchCtx.close()

  // ========================================================================
  // DESKTOP CONTEXT — mouse click → card, ✕, drag-no-inspect, mission locate.
  // ========================================================================
  const deskCtx = await browser.newContext({ viewport: SIZE })
  const desk = await deskCtx.newPage()
  desk.on('pageerror', (e) => errs.push(String(e)))
  desk.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))
  await boot(desk)

  const dcop = await at(desk, 2)
  await desk.mouse.click(dcop.x, dcop.y)
  await settle(desk)
  p = await popup(desk)
  p.visible && p.mode === 'card' ? ok('desktop click opens the FULL card directly') : fail(`desktop click: ${JSON.stringify(p)}`)
  p.hasClose ? ok('card has a ✕ close button') : fail('no close button')
  await shot(desk, 'desktop-card')

  // ✕ dismisses.
  const closeBox = await desk.evaluate(() => {
    const b = document.querySelector('[data-inspect-close]').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  await desk.mouse.click(closeBox.x, closeBox.y)
  await settle(desk)
  p = await popup(desk)
  !p.visible ? ok('✕ closed the card') : fail('✕ did not close the card')

  // A mouse drag (camera-feeling gesture) never inspects.
  const dthug = await at(desk, 5)
  await desk.mouse.move(dthug.x, dthug.y)
  await desk.mouse.down()
  await desk.mouse.move(dthug.x + 80, dthug.y + 40, { steps: 5 })
  await desk.mouse.up()
  await settle(desk)
  p = await popup(desk)
  !p.visible ? ok('mouse drag never inspects') : fail('mouse drag opened a popup')

  // Mission target: make the gangster the objective, inspect it, use LOCATE.
  await desk.evaluate(() => {
    window.__world.mission.template = 'assassinate'
    window.__world.mission.description = 'Purge the Mireclaw Alpha'
    window.__world.mission.complete = false
    window.__world.mission.targetEntityId = 4
  })
  await settle(desk)
  const dgang = await at(desk, 4)
  await desk.mouse.click(dgang.x, dgang.y)
  await settle(desk)
  p = await popup(desk)
  p.visible && p.hasMission ? ok('mission-target card offers the locate action') : fail(`mission card: ${JSON.stringify(p)}`)
  await shot(desk, 'mission-card')

  // Whisk the target far away MID-INSPECT: the card must degrade gracefully
  // (stay fully on-screen, clamped) — and locate must now really pan.
  await desk.evaluate(() => window.__verb('teleport 4 44 34'))
  await settle(desk)
  p = await popup(desk)
  p.visible && onScreen(p) ? ok('card follows a teleported (off-screen) entity, clamped on-screen') : fail(`card after teleport: ${JSON.stringify(p.rect)}`)
  const farBefore = await desk.evaluate(() => {
    const e = window.__world.entities.find((x) => x.id === 4)
    const s = window.__project(e.pos.x, e.pos.y)
    return Math.hypot(s.x - innerWidth / 2, s.y - innerHeight / 2)
  })
  const locBox = await desk.evaluate(() => {
    const b = document.querySelector('[data-inspect-mission]').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })
  await desk.mouse.click(locBox.x, locBox.y)
  await desk.waitForTimeout(1600) // let the focus glide play
  const centered = await desk.evaluate(() => {
    const e = window.__world.entities.find((x) => x.id === 4)
    const s = window.__project(e.pos.x, e.pos.y)
    return Math.hypot(s.x - innerWidth / 2, s.y - innerHeight / 2)
  })
  centered < 200 && farBefore > 400
    ? ok(`locate glided the camera to the far target (${Math.round(farBefore)}px → ${Math.round(centered)}px from centre)`)
    : fail(`camera focus: ${Math.round(farBefore)}px → ${Math.round(centered)}px off-centre`)
  await shot(desk, 'mission-focused')

  await desk.close()
  await deskCtx.close()
  await browser.close()

  // ---- video: mux the touch context's webm → mp4 and verify it is real ----
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  let mp4Bytes = 0
  if (webm) {
    const webmPath = join(OUT, 'inspect-ui.webm')
    const mp4 = join(OUT, 'inspect-ui.mp4')
    renameSync(join(videoDir, webm), webmPath)
    try {
      execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
        '-movflags', '+faststart', mp4], { stdio: 'ignore' })
      mp4Bytes = statSync(mp4).size
      if (mp4Bytes < 100_000) fail(`mp4 only ${mp4Bytes} bytes`)
      if (SHARE) cpSync(mp4, join(SHARE, 'inspect-ui.mp4'))
    } catch (e) {
      fail(`ffmpeg mux failed: ${e.message}`)
    }
    rmSync(webmPath, { force: true })
  } else fail('no webm recorded')
  rmSync(videoDir, { recursive: true, force: true })

  if (errs.length) for (const e of errs) fail(`page error: ${e}`)

  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    for (const s of shots) cpSync(join(OUT, s), join(SHARE, s))
  }

  console.log(`\n[inspect-ui] ${shots.length} screenshots, video ${(mp4Bytes / 1024).toFixed(0)} KB`)
  for (const s of shots) console.log(`  ${s} (${statSync(join(OUT, s)).size} bytes)`)
  if (failures.length) {
    console.error(`\n[inspect-ui] ${failures.length} FAILURE(S)`)
    process.exitCode = 1
  } else console.log('\n[inspect-ui] OK — all assertions passed')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
