// @ts-check
// Parity M9 proof: drives the objects scenario in a real browser with real
// KEYBOARD input and asserts: using a vending machine dispenses an item, shooting
// a crate breaks it and drops loot, and shooting a barrel chain-detonates the row
// (barrels destroyed, fire ignited, the bystander hurt). Video + screenshots.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-obj')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[obj-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-obj-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

const readWorld = (page) =>
  page.evaluate(() => {
    const v = window.__sor.renderView()
    const self = { x: v.self.pos.x, y: v.self.pos.y }
    let barrels = 0
    let crate = false
    let fires = 0
    const pickups = []
    const civs = []
    for (const e of v.entities) {
      if (e.dead) continue
      if (e.kind === 'fire') fires += 1
      if (e.archetype === 'barrel') barrels += 1
      if (e.archetype === 'crate') crate = true
      if (e.kind === 'pickup') pickups.push({ itemId: e.pickup.itemId, x: e.pos.x })
      if (e.kind === 'npc' && e.ai && e.ai.faction === 'civ') civs.push({ id: e.id, x: e.pos.x, hp: e.health ? e.health.hp : null })
    }
    return { self, barrels, crate, fires, pickups, civs }
  })

const shoot = async (page, n, gap = 300) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Space')
    await sleep(gap)
  }
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

  await page.goto(`${BASE}/?mode=solo&scenario=objects&e2e=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sor
    return !!s && !!s.renderView && !!s.renderView().self
  }, { timeout: 20000 })
  await sleep(400)

  const start = await readWorld(page)
  // The scenario bystander is spawned after the populated crowd, so it has the
  // highest id among civilians; track it by id through the blast.
  const bystander = start.civs.slice().sort((a, b) => b.id - a.id)[0]
  log('start', JSON.stringify({ barrels: start.barrels, crate: start.crate, bystander, pickups: start.pickups.length }))
  await screenshot(page, 'scene')
  check(start.barrels === 3 && start.crate, 'scene has 3 barrels and a crate')

  // USE: the vending machine (adjacent west) dispenses a burger — an item that
  // never appears in the level's own loot, so its presence is unambiguous.
  await page.keyboard.press('KeyE')
  await sleep(300)
  const afterUse = await readWorld(page)
  await screenshot(page, 'vending-used')
  check(afterUse.pickups.some((p) => p.itemId === 'burger'), 'using the vending machine dispensed a burger')

  // BREAK: shoot the crate (nearest thing east) — it drops loot.
  const pickupsBeforeCrate = afterUse.pickups.length
  await shoot(page, 3)
  const afterCrate = await readWorld(page)
  await screenshot(page, 'crate-loot')
  check(!afterCrate.crate, 'the crate was destroyed by gunfire')
  check(afterCrate.pickups.length > pickupsBeforeCrate, 'the broken crate dropped a loot pickup')

  // CHAIN: keep shooting east — the bullets reach the barrel row and detonate it.
  await shoot(page, 6, 250)
  await sleep(500)
  const afterBarrels = await readWorld(page)
  await screenshot(page, 'barrel-explosion')
  const bystanderAfter = bystander ? afterBarrels.civs.find((c) => c.id === bystander.id) : undefined
  log('after barrels', JSON.stringify({ barrels: afterBarrels.barrels, fires: afterBarrels.fires, bystanderAfter }))
  check(afterBarrels.barrels <= 1, 'the barrel row chain-detonated (barrels destroyed)')
  check(afterBarrels.fires > 0, 'the explosion ignited fire')
  check(!!bystander && (!bystanderAfter || bystanderAfter.hp < bystander.hp), 'the blast killed or hurt the nearby bystander')

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-obj-clip.webm'))
    log('video ->', join(OUT, 'parity-obj-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: vending use + crate loot + barrel chain-explosion verified, zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
