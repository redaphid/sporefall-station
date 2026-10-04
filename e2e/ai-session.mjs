// @ts-check
// Parity M8 proof: drives the ai-goals scenario in a real browser and asserts
// the desirability arbitration — a full-health acolyte chooses BATTLE and
// closes on the player, a badly wounded acolyte chooses FLEE and runs away,
// and a calm warden INVESTIGATEs a noise (moves toward it). Video + screenshots.
import { chromium } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-ai')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'
const CHROME = process.env.PW_CHROME

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[ai-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `parity-ai-${String(shot).padStart(2, '0')}-${label}.png`
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
    const v = window.__sporefall.renderView()
    const self = { x: v.self.pos.x, y: v.self.pos.y, hp: v.self.health ? v.self.health.hp : null }
    const npcs = []
    for (const e of v.entities) {
      if (e.kind !== 'npc' || e.dead || !e.ai) continue
      npcs.push({ id: e.id, faction: e.ai.faction, goal: e.ai.goal, hp: e.health ? e.health.hp : null, x: e.pos.x, y: e.pos.y, distToPlayer: Math.hypot(e.pos.x - self.x, e.pos.y - self.y) })
    }
    return { self, npcs }
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

  await page.goto(`${BASE}/?mode=solo&scenario=ai-goals&e2e=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sporefall
    return !!s && !!s.renderView && !!s.renderView().self && !!window.__debug
  }, { timeout: 20000 })
  await sleep(300)

  const start = await readWorld(page)
  // The scenario's two acolytes are the ones standing right next to the player;
  // the two nearest ferals are them (any populated acolytes are far off).
  const nearFerals = start.npcs.filter((n) => n.faction === 'feral').sort((a, b) => a.distToPlayer - b.distToPlayer).slice(0, 2)
  const healthy0 = nearFerals.reduce((a, b) => (b.hp > a.hp ? b : a))
  const wounded0 = nearFerals.reduce((a, b) => (b.hp < a.hp ? b : a))
  log('start', JSON.stringify({ healthy0, wounded0 }))

  // Let the acolytes act on their goals for a moment.
  await sleep(1200)
  const mid = await readWorld(page)
  const healthy1 = mid.npcs.find((n) => n.id === healthy0.id)
  const wounded1 = mid.npcs.find((n) => n.id === wounded0.id)
  await screenshot(page, 'battle-vs-flee')
  log('after', JSON.stringify({ healthy1, wounded1 }))

  check(!!healthy1 && healthy1.goal === 'battle', 'the healthy acolyte chose BATTLE')
  check(mid.self.hp < start.self.hp, `the battling acolyte engaged and hurt the player (hp ${start.self.hp} -> ${mid.self.hp})`)
  check(!!wounded1 && wounded1.goal === 'flee', 'the wounded acolyte chose FLEE')
  check(!!wounded1 && wounded1.distToPlayer > wounded0.distToPlayer, 'the wounded acolyte ran away from the player')

  // Noise: make a racket a few tiles from the calm warden; it should investigate.
  const wardenBefore = (await readWorld(page)).npcs.find((n) => n.faction === 'warden')
  const noiseAt = { x: wardenBefore.x + 3, y: wardenBefore.y }
  const distBefore = Math.hypot(wardenBefore.x - noiseAt.x, wardenBefore.y - noiseAt.y)
  await page.evaluate((n) => window.__debug.noise(n.x, n.y), noiseAt)
  await sleep(1500)
  const wardenAfter = (await readWorld(page)).npcs.find((n) => n.faction === 'warden')
  const distAfter = wardenAfter ? Math.hypot(wardenAfter.x - noiseAt.x, wardenAfter.y - noiseAt.y) : Infinity
  await screenshot(page, 'investigate-noise')
  log('warden', JSON.stringify({ wardenBefore, wardenAfter, distBefore, distAfter }))

  check(!!wardenAfter && distAfter < distBefore - 0.5, `the warden moved toward the noise (${distBefore.toFixed(1)} -> ${distAfter.toFixed(1)})`)

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (webm) {
    renameSync(join(VIDEO_DIR, webm), join(OUT, 'parity-ai-clip.webm'))
    log('video ->', join(OUT, 'parity-ai-clip.webm'))
  } else {
    log('WARNING: no webm produced')
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: battle/flee/investigate goal arbitration verified, zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
