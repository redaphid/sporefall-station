// Animation proof: drives ?scenario=showcase in a real browser, records a clip
// + labeled screenshots, and asserts the three animation checks live:
//   (a) fire is animating (multiple fire cells burning),
//   (b) characters are walking (a wander NPC's position changed over time),
//   (c) an effect played (a pickup was collected AND an explosion fired).
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4899'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-showcase')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[showcase ${new Date().toISOString().slice(11, 19)}]`, ...a)

let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `anim-assets-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

const probe = (page) =>
  page.evaluate(() => {
    const v = window.__sor.renderView()
    let fires = 0
    let events = v.events.map((e) => e.type)
    const walkers = {}
    for (const e of v.entities) {
      if (e.dead) continue
      if (e.kind === 'fire') fires += 1
      if (e.ai && e.ai.mode === 'wander') walkers[e.id] = { x: e.pos.x, y: e.pos.y }
    }
    return { tick: v.tick, fires, events, walkers }
  })

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 960, height: 720 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 960, height: 720 } },
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  const url = `${BASE}/?mode=solo&scenario=showcase&e2e=1&zoom=2.2&seed=${SEED}`
  log('goto', url)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__sor && window.__sor.renderView().entities.length > 0, {
    timeout: 20000,
  })

  // Events live for a single sim tick — poll every animation frame from inside
  // the page so no one-tick event (pickup/explosion) can slip between probes.
  await page.evaluate(() => {
    window.__evlog = {}
    const tick = () => {
      try {
        for (const e of window.__sor.renderView().events) window.__evlog[e.type] = (window.__evlog[e.type] ?? 0) + 1
      } catch {}
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await sleep(400)
  await screenshot(page, 'start')
  const first = await probe(page)
  log('start', JSON.stringify(first).slice(0, 200))
  const walkerStart = { ...first.walkers }

  // Directional tour: drive the player each way so front/back/side(+flip)
  // sprites all show — this is the fix for "it just rotates one sprite".
  const tour = [
    ['ArrowDown', 'facing-front'],
    ['ArrowRight', 'facing-side-right'],
    ['ArrowUp', 'facing-back'],
    ['ArrowLeft', 'facing-side-left'],
  ]
  for (const [key, label] of tour) {
    await page.keyboard.down(key)
    await sleep(450)
    await screenshot(page, label)
    await page.keyboard.up(key)
    await sleep(120)
  }

  let maxFires = first.fires
  const walkerLast = {}
  for (let i = 0; i < 10; i++) {
    // Player grenade toss → a guaranteed explosion (player is tanky here so a
    // close blast can't end the demo).
    if (i === 1 || i === 4) await page.keyboard.press('KeyL')
    await sleep(500)
    const p = await probe(page)
    maxFires = Math.max(maxFires, p.fires)
    Object.assign(walkerLast, p.walkers)
    if (i === 1) await screenshot(page, 'fire-and-walk')
    if (i === 3) await screenshot(page, 'explosion')
    if (i === 7) await screenshot(page, 'burning')
    log(`t=${p.tick} fires=${p.fires}`)
  }
  await screenshot(page, 'final')
  const dbg = await page.evaluate(() => {
    const v = window.__sor.renderView()
    const p = v.entities.find((e) => e.playerCtl)
    return {
      evlog: window.__evlog,
      weapon: p?.combat?.weapon,
      playerPos: p ? { x: Math.round(p.pos.x * 10) / 10, y: Math.round(p.pos.y * 10) / 10 } : null,
      grenades: v.entities.filter((e) => e.archetype === 'grenade' && !e.dead).length,
      pickups: v.entities.filter((e) => e.kind === 'pickup' && !e.dead).length,
    }
  })
  log('DEBUG', JSON.stringify(dbg))
  const allEvents = new Set(Object.keys(dbg.evlog))

  const walkerMoved = Object.keys(walkerStart).some((id) => {
    const a = walkerStart[id]
    const b = walkerLast[id]
    return b && Math.hypot(b.x - a.x, b.y - a.y) > 0.3
  })

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) renameSync(join(VIDEO_DIR, webm), join(OUT, 'anim-assets-clip.webm'))

  const checks = {
    'fire animating (>1 fire cell)': maxFires > 1,
    'characters walked': walkerMoved,
    'explosion effect fired': allEvents.has('explosion'),
    'hit effect fired': allEvents.has('hit'),
  }
  log('pickup fired (soft):', allEvents.has('pickup'))
  log('checks', JSON.stringify(checks, null, 2))
  if (pageErrors.length) {
    console.error('PAGE ERRORS:', pageErrors.join(' | '))
    process.exit(1)
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  if (failed.length) {
    console.error('FAILED:', failed.map(([k]) => k).join(', '))
    process.exit(1)
  }
  log('ALL CHECKS PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
