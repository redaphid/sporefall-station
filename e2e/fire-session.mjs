// @ts-check
// Parity M3 proof: drives the ?scenario=fire demo in a real browser, records a
// video + labeled screenshots, and asserts the three acceptance checks live:
//   (a) fire spread to an adjacent flammable entity (>1 fire cell exists),
//   (b) a burning NPC's hp strictly decreased over time,
//   (c) a screenshot showing the fire on screen.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-fire')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[fire-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-fire-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
  return name
}

const readFire = (page) =>
  page.evaluate(() => {
    const v = window.__sor.renderView()
    let fires = 0
    let npc = null
    for (const e of v.entities) {
      if (e.dead) continue
      if (e.kind === 'fire') fires += 1
      // The scenario's flammable bystander — track it specifically.
      if (e.kind === 'npc' && e.flammable && e.health) {
        npc = { hp: e.health.hp, burning: !!(e.fx && e.fx.burning) }
      }
    }
    return { tick: v.tick, fires, npc }
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

  const url = `${BASE}/?mode=solo&class=soldier&scenario=fire&e2e=1&seed=${SEED}`
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
  log('canvas + sim ready')

  const start = await readFire(page)
  log('start', JSON.stringify(start))
  if (!start.npc) throw new Error('fire scenario did not spawn a flammable NPC')
  await screenshot(page, 'ignite')

  let maxFires = start.fires
  let maxHp = start.npc.hp
  let minHp = start.npc.hp
  let sawBurningNpc = start.npc.burning
  let spreadShot = false
  let burnShot = false

  for (let i = 0; i < 50; i++) {
    await sleep(200)
    const st = await readFire(page)
    maxFires = Math.max(maxFires, st.fires)
    if (st.npc) {
      maxHp = Math.max(maxHp, st.npc.hp)
      minHp = Math.min(minHp, st.npc.hp)
      if (st.npc.burning) sawBurningNpc = true
    }
    if (maxFires > 1 && !spreadShot) { await screenshot(page, 'spread'); spreadShot = true }
    if (sawBurningNpc && !burnShot) { await screenshot(page, 'burn'); burnShot = true }
    log('tick', st.tick, 'fires', st.fires, 'npcHp', st.npc ? st.npc.hp : 'gone', 'burning', st.npc ? st.npc.burning : false)
    if (!st.npc && sawBurningNpc) break
  }

  await screenshot(page, 'aftermath')
  log('summary', JSON.stringify({ maxHp, minHp, maxFires, sawBurningNpc }))

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-fire-clip.webm'))
    log('video ->', join(OUT, 'parity-fire-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  const failures = []
  if (maxFires <= 1) failures.push(`fire did not spread (max fires ${maxFires})`)
  if (!sawBurningNpc) failures.push('NPC never caught fire')
  if (!(minHp < maxHp)) failures.push(`NPC hp did not decrease (${maxHp} -> ${minHp})`)
  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAIL:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: fire spread to', maxFires, 'cells, NPC burned, hp', maxHp, '->', minHp, ', zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
