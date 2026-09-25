// @ts-check
// Parity M4 proof: drives the frost + wet-electric interaction scenarios in a
// real browser, records a video + labeled screenshots, and asserts live:
//   FROST:        a frozen NPC hit once takes the blow x SHATTER_DAMAGE_MULT
//                 and, on a 25hp bystander, gibs (dead + shattered); an
//                 unfrozen twin takes the base blow and survives.
//   WET-ELECTRIC: zapping one wet NPC chains to and damages the adjacent wet NPC.
import { acquireBrowser, releaseBrowser } from './lib.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4890'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-frost')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'

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

  // One pistol round (14) into each. Shattering multiplies it by 5, which is
  // lethal to a 25hp bystander; the twin eats the plain 14 and walks.
  const DMG = 14
  const MULT = 5
  const frozenRes = await page.evaluate(([id, d]) => window.__debug.hit(id, d), [frozen.id, DMG])
  const twinRes = await page.evaluate(([id, d]) => window.__debug.hit(id, d), [twin.id, DMG])
  log('after hit — frozen', JSON.stringify(frozenRes), 'twin', JSON.stringify(twinRes))
  await screenshot(page, 'after-shatter')

  check(frozenRes && frozenRes.shattered === true && frozenRes.dead === true, 'frozen NPC shatters on impact (dead + ice gib)')
  check(twinRes && twinRes.shattered === false && twinRes.dead === false && twinRes.hp === twin.hp - DMG, `unfrozen twin takes only the base blow (${twin.hp} -> ${twin.hp - DMG})`)
  // The regression the owner reported: the shatter must be a MULTIPLIED BLOW,
  // not an execute. Prove it on a body the multiplied blow cannot kill.
  const tank = await page.evaluate((d) => {
    const v = window.__sporefall.renderView()
    const t = v.entities.find((e) => e.kind === 'npc' && !e.dead)
    if (!t) return null
    window.__debug.freeze(t.id)
    const before = t.health ? t.health.hp : 0
    window.__world.byId.get(t.id).health.hp = 400
    window.__world.byId.get(t.id).health.max = 400
    window.__world.byId.get(t.id).health.iframes = 0
    const res = window.__debug.hit(t.id, d)
    return { before, ...res }
  }, DMG)
  log('400hp frozen body after one shatter:', JSON.stringify(tank))
  check(!!tank && tank.dead === false && tank.hp === 400 - DMG * MULT, `a 400hp frozen body SURVIVES the shatter, down ${DMG * MULT} (was an instant kill)`)
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
  // Same browser seam as `record()`: headless by default, headed on
  // E2E_HEADFUL=1, or an already-running headed browser via E2E_CDP (see the
  // acquireBrowser doc in lib.mjs — WSLg can leave no usable local display).
  const { browser, shared } = await acquireBrowser()
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
  if (shared) await releaseBrowser()
  else await browser.close()

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
