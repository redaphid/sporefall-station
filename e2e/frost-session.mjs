// @ts-check
// Parity M4 proof: drives the frost + wet-electric interaction scenarios in a
// real browser, records a video + labeled screenshots, and asserts live:
//   FROST:        a frozen NPC hit once shatters (hp 0 + shattered); an
//                 unfrozen twin hit once survives.
//   WET-ELECTRIC: zapping one wet NPC chains to and damages the adjacent wet NPC.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-frost')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[frost-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-frost-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

const npcs = (page) =>
  page.evaluate(() => {
    const v = window.__sporefall.renderView()
    const out = []
    for (const e of v.entities) {
      if (e.kind !== 'npc') continue
      out.push({
        id: e.id,
        x: e.pos.x,
        y: e.pos.y,
        hp: e.health ? e.health.hp : null,
        frozen: !!(e.fx && e.fx.frozen),
        wet: !!(e.fx && e.fx.wet),
        electrified: !!(e.fx && e.fx.electrified),
        shattered: !!e.shattered,
        dead: !!e.dead,
      })
    }
    return out
  })

const ready = async (page, url) => {
  log('navigate', url)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sporefall
    return !!s && !!s.renderView && !!s.renderView().self && !!window.__debug
  }, { timeout: 20000 })
  await sleep(300)
}

/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

const runFrost = async (page) => {
  await ready(page, `${BASE}/?mode=solo&scenario=frost&e2e=1&seed=${SEED}`)
  const before = await npcs(page)
  const frozen = before.find((n) => n.frozen)
  if (!frozen) throw new Error('frost scenario: no frozen NPC found')
  // Twin: nearest non-frozen NPC to the frozen one (the scenario's other bystander).
  const twin = before
    .filter((n) => !n.frozen && n.id !== frozen.id)
    .sort((a, b) => Math.hypot(a.x - frozen.x, a.y - frozen.y) - Math.hypot(b.x - frozen.x, b.y - frozen.y))[0]
  if (!twin) throw new Error('frost scenario: no twin NPC found')
  log('frozen', frozen.id, 'twin', twin.id, 'twinHp', twin.hp)
  await screenshot(page, 'frozen-and-twin')

  const frozenRes = await page.evaluate((id) => window.__debug.hit(id, 1), frozen.id)
  const twinRes = await page.evaluate((id) => window.__debug.hit(id, 1), twin.id)
  log('after hit — frozen', JSON.stringify(frozenRes), 'twin', JSON.stringify(twinRes))
  await screenshot(page, 'after-shatter')

  check(frozenRes && frozenRes.shattered === true && frozenRes.hp === 0, 'frozen NPC shatters on impact (hp 0 + shattered)')
  check(twinRes && twinRes.shattered === false && twinRes.dead === false && twinRes.hp === twin.hp - 1, 'unfrozen twin survives the same hit')
}

const runWetElectric = async (page) => {
  await ready(page, `${BASE}/?mode=solo&scenario=wet-electric&e2e=1&seed=${SEED}`)
  const before = (await npcs(page)).filter((n) => n.wet).sort((a, b) => a.x - b.x)
  if (before.length < 2) throw new Error('wet-electric scenario: need >=2 wet NPCs')
  const near = before[0]
  const neighbor = before[1]
  log('wet cluster', before.map((n) => n.id), 'zapping', near.id, 'neighborHp', neighbor.hp)
  await screenshot(page, 'wet-cluster')

  await page.evaluate((id) => window.__debug.shock(id), near.id)
  await sleep(150)
  const after = await npcs(page)
  const nb = after.find((n) => n.id === neighbor.id)
  log('after zap — neighbor', JSON.stringify(nb))
  await screenshot(page, 'chain')

  check(!!nb && nb.electrified === true, 'shock chains: adjacent wet NPC is electrified')
  check(!!nb && nb.hp !== null && nb.hp < neighbor.hp, `adjacent wet NPC took chain damage (${neighbor.hp} -> ${nb ? nb.hp : 'gone'})`)
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

  await runFrost(page)
  await runWetElectric(page)

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-frost-clip.webm'))
    log('video ->', join(OUT, 'parity-frost-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: frost shatter + wet-electric chain verified, zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
