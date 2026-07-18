// @ts-check
// Parity M5 proof: drives the inventory/weapons loadout in a real browser with
// real KEYBOARD input, records a video + screenshots, and asserts live:
//   EQUIP:  pressing a hotbar key changes the active weapon.
//   AMMO:   firing the gun decrements its ammo and stops at zero (empty click).
//   THROW:  a thrown molotov leaves the inventory and sets a fire on the ground.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-weapons')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[weapons-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-weapons-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

const state = (page) =>
  page.evaluate(() => {
    const v = window.__sor.renderView()
    const s = v.self
    const slots = (s.playerCtl.inventory || []).map((x) => ({ itemId: x.itemId, qty: x.qty }))
    const ammoOf = (id) => {
      const slot = slots.find((x) => x.itemId === id)
      return slot ? slot.qty : null
    }
    let fires = 0
    for (const e of v.entities) if (e.kind === 'fire' && !e.dead) fires += 1
    return {
      weapon: s.combat ? s.combat.weapon : null,
      activeSlot: s.playerCtl.activeSlot,
      slots,
      pistolAmmo: ammoOf('pistol'),
      molotovs: ammoOf('molotov'),
      fires,
    }
  })

/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
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

  const url = `${BASE}/?mode=solo&scenario=inventory&e2e=1&seed=${SEED}`
  log('navigate', url)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sor
    return !!s && !!s.renderView && !!s.renderView().self
  }, { timeout: 20000 })
  await sleep(400)

  const start = await state(page)
  log('loadout', JSON.stringify(start))
  await screenshot(page, 'loadout')
  check(start.weapon === 'bat', 'starts equipped with the bat (slot 0)')
  check(start.pistolAmmo === 3 && start.molotovs === 2, 'hotbar holds pistol (3) + molotov (2)')

  // EQUIP the pistol via hotbar key "2".
  await page.keyboard.press('Digit2')
  await sleep(200)
  const equipped = await state(page)
  log('after equip 2', JSON.stringify(equipped))
  await screenshot(page, 'pistol-equipped')
  check(equipped.weapon === 'pistol' && equipped.activeSlot === 1, 'pressing 2 equips the pistol')

  // FIRE until empty: hold-tap Space; cooldown is ~0.6s.
  let ammo = equipped.pistolAmmo
  for (let i = 0; i < 8 && ammo > 0; i++) {
    await page.keyboard.press('Space')
    await sleep(700)
    const st = await state(page)
    log('shot', i + 1, 'ammo', st.pistolAmmo)
    ammo = st.pistolAmmo
  }
  const emptied = await state(page)
  await screenshot(page, 'gun-empty')
  check(emptied.pistolAmmo === 0, 'firing drains the magazine to zero')
  // One more trigger pull on the empty gun must not go negative or refill.
  await page.keyboard.press('Space')
  await sleep(400)
  const afterEmpty = await state(page)
  check(afterEmpty.pistolAmmo === 0, 'empty gun cannot fire (ammo stays 0)')
  check(afterEmpty.slots.some((s) => s.itemId === 'pistol'), 'empty gun stays in the inventory')

  // THROW a molotov via key "Q".
  await page.keyboard.press('KeyQ')
  await sleep(1200) // let it fly and land
  const thrown = await state(page)
  log('after throw', JSON.stringify(thrown))
  await screenshot(page, 'molotov-fire')
  check(thrown.molotovs === 1, 'throwing spends one molotov (2 -> 1)')
  check(thrown.fires > 0, 'the thrown molotov lands and starts a fire')

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-weapons-clip.webm'))
    log('video ->', join(OUT, 'parity-weapons-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: equip + ammo + throw verified, zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
