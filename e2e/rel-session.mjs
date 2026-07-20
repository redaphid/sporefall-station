// @ts-check
// Parity M7 proof: drives the relationships scenario in a real browser with real
// KEYBOARD input. The player shoots a civilian in front of two cops and a
// bouncer; the harness asserts the cops (law) flip Neutral -> Hostile and aggro,
// while the unrelated bouncer stays Neutral and calm. Video + before/after shots.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-rel')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[rel-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-rel-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

// Read the scenario NPCs' faction, aggro mode, and disposition toward the player.
const factions = (page) =>
  page.evaluate(() => {
    const v = window.__sporefall.renderView()
    const selfId = v.self.id
    const out = { cops: [], bouncer: null }
    for (const e of v.entities) {
      if (e.kind !== 'npc' || e.dead || !e.ai) continue
      const rel = e.ai.rel && e.ai.rel[selfId]
      const info = { id: e.id, mode: e.ai.mode, code: rel ? rel.code : 'Neutral', dist: Math.hypot(e.pos.x - v.self.pos.x, e.pos.y - v.self.pos.y) }
      if (e.ai.faction === 'cop' && info.dist < 12) out.cops.push(info)
      if (e.ai.faction === 'neutral' && info.dist < 12) out.bouncer = info
    }
    return out
  })

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

  await page.goto(`${BASE}/?mode=solo&scenario=relationships&e2e=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sporefall
    return !!s && !!s.renderView && !!s.renderView().self
  }, { timeout: 20000 })
  await sleep(400)

  const before = await factions(page)
  log('before', JSON.stringify(before))
  await screenshot(page, 'before-calm')
  check(before.cops.length >= 1, 'scenario has cops nearby')
  check(before.cops.every((c) => c.code !== 'Hostile' && c.mode !== 'aggro'), 'cops start neutral and calm')
  check(!!before.bouncer && before.bouncer.code !== 'Hostile', 'bouncer starts neutral')

  // Commit the crime: shoot the civilian in front of the cops.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Space')
    await sleep(250)
  }
  await sleep(1200) // let the cops react and charge
  const after = await factions(page)
  log('after', JSON.stringify(after))
  await screenshot(page, 'cops-hostile')

  check(after.cops.some((c) => c.code === 'Hostile'), 'a witnessing cop turns Hostile after the crime')
  check(after.cops.some((c) => c.mode === 'aggro'), 'a cop aggroes the player after the crime')
  check(!!after.bouncer && after.bouncer.code !== 'Hostile' && after.bouncer.mode !== 'aggro', 'the unrelated bouncer stays neutral and calm')

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-rel-clip.webm'))
    log('video ->', join(OUT, 'parity-rel-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: witnessed crime flipped cops hostile, bouncer stayed neutral, zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
