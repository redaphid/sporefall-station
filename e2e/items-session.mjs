// @ts-check
// Parity M6 proof: drives the item-breadth loadout in a real browser with real
// KEYBOARD input and asserts, per category, that a representative item produces
// its effect: freeze grenade ⇒ frozen NPC, chloroform ⇒ sleeping NPC, molotov ⇒
// fire on the ground, shotgun ⇒ a spread of pellets. Each item runs from a fresh
// scenario load. Records a video + a screenshot per item.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-items')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[items-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-items-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

const world = (page) =>
  page.evaluate(() => {
    const v = window.__sporefall.renderView()
    const s = v.self
    const npcs = []
    let fires = 0
    let projectiles = 0
    for (const e of v.entities) {
      if (e.dead) continue
      if (e.kind === 'fire') fires += 1
      if (e.kind === 'projectile') projectiles += 1
      if (e.kind === 'npc') npcs.push({ id: e.id, frozen: !!(e.fx && e.fx.frozen), sleep: e.status ? e.status.sleep : 0 })
    }
    return {
      slots: (s.playerCtl.inventory || []).map((x) => x.itemId),
      weapon: s.combat ? s.combat.weapon : null,
      npcs,
      fires,
      projectiles,
    }
  })

const ready = async (page, scenario) => {
  await page.goto(`${BASE}/?mode=solo&scenario=${scenario}&e2e=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sporefall
    return !!s && !!s.renderView && !!s.renderView().self
  }, { timeout: 20000 })
  await sleep(300)
}

/** Equip the slot holding `itemId` by pressing its hotbar digit. */
const equip = async (page, itemId) => {
  const st = await world(page)
  const idx = st.slots.indexOf(itemId)
  if (idx < 0) throw new Error(`loadout missing ${itemId}`)
  await page.keyboard.press(`Digit${idx + 1}`)
  await sleep(120)
}

const main = async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
  const context = await browser.newContext({
    viewport: { width: 900, height: 700 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 900, height: 700 } },
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    pageErrors.push(String(e))
    log('PAGE ERROR:', String(e))
  })
  page.on('console', (m) => {
    if (m.type() === 'error') log('console.error:', m.text())
  })

  // FREEZE GRENADE ⇒ frozen NPC
  await ready(page, 'items')
  await equip(page, 'freezeGrenade')
  await page.keyboard.press('KeyQ')
  await sleep(900)
  let st = await world(page)
  await screenshot(page, 'freeze-grenade')
  check(st.npcs.some((n) => n.frozen), 'freeze grenade freezes an NPC')

  // CHLOROFORM ⇒ sleeping NPC
  await ready(page, 'items')
  await equip(page, 'chloroform')
  await page.keyboard.press('KeyQ')
  await sleep(900)
  st = await world(page)
  await screenshot(page, 'chloroform')
  check(st.npcs.some((n) => n.sleep > 0), 'chloroform puts an NPC to sleep')

  // MOLOTOV ⇒ fire on the ground
  await ready(page, 'items')
  await equip(page, 'molotov')
  await page.keyboard.press('KeyQ')
  await sleep(1000)
  st = await world(page)
  await screenshot(page, 'molotov-fire')
  check(st.fires > 0, 'molotov starts a fire on the target tile')

  // SHOTGUN ⇒ spread of pellets. Sample fast right after firing and grab the
  // peak count / a frame with the fan mid-flight (pellets are small and quick).
  await ready(page, 'items')
  await equip(page, 'shotgun')
  await page.keyboard.press('Space')
  let peak = 0
  for (let i = 0; i < 10; i++) {
    const cur = await world(page)
    if (cur.projectiles >= peak) {
      peak = cur.projectiles
      if (peak > 1) await screenshot(page, 'shotgun-spread')
    }
    await sleep(30)
  }
  if (peak <= 1) await screenshot(page, 'shotgun-spread')
  // More than one pellet per trigger pull is the shotgun's signature (a pistol
  // fires exactly one). The exact 5-pellet fan is pinned by the unit test; here
  // the live count is throttled by browser sampling latency.
  check(peak > 1, `shotgun fires more than one pellet per shot (peak ${peak} in flight)`)

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-items-clip.webm'))
    log('video ->', join(OUT, 'parity-items-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: freeze + chloroform + molotov + shotgun verified, zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
