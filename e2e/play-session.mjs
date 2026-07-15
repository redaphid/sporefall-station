import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '424242'

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

const pageErrors = []
let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `web-e2e-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
}

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    pageErrors.push(String(e))
    log('PAGE ERROR:', String(e))
  })
  page.on('console', (m) => {
    if (m.type() === 'error') log('console.error:', m.text())
  })

  const url = `${BASE}/?mode=solo&class=soldier&e2e=1&seed=${SEED}`
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
  await sleep(600)
  await screenshot(page, 'spawn')

  const held = new Set()
  const setKeys = async (want) => {
    for (const k of held) {
      if (want.has(k)) continue
      await page.keyboard.up(k)
      held.delete(k)
    }
    for (const k of want) {
      if (held.has(k)) continue
      await page.keyboard.down(k)
      held.add(k)
    }
  }
  const releaseAll = () => setKeys(new Set())

  const readState = () =>
    page.evaluate(() => {
      const v = window.__sor.renderView()
      const s = v.self
      if (!s) return null
      let npc = null, npcD = 1e9, door = null, doorD = 1e9, item = null, itemD = 1e9
      for (const e of v.entities) {
        if (e.dead || e.id === s.id) continue
        const dx = e.pos.x - s.pos.x, dy = e.pos.y - s.pos.y
        const d = Math.hypot(dx, dy)
        if (e.kind === 'npc' && d < npcD) { npcD = d; npc = { x: e.pos.x, y: e.pos.y, a: e.archetype } }
        if (e.kind === 'door' && d < doorD) { doorD = d; door = { x: e.pos.x, y: e.pos.y, open: !!(e.door && e.door.open) } }
        if (e.kind === 'pickup' && d < itemD) { itemD = d; item = { x: e.pos.x, y: e.pos.y } }
      }
      return {
        self: { x: s.pos.x, y: s.pos.y }, hp: s.health ? s.health.hp : null,
        mission: v.missionText, npc, npcD, door, doorD, item, itemD,
      }
    })

  const keysToward = (from, to) => {
    const want = new Set()
    const dx = to.x - from.x
    const dy = to.y - from.y
    if (dx > 0.25) want.add('KeyD')
    if (dx < -0.25) want.add('KeyA')
    if (dy > 0.25) want.add('KeyS')
    if (dy < -0.25) want.add('KeyW')
    return want
  }

  const start = await readState()
  log('spawn at', start.self, 'mission:', start.mission)

  const roam = [['KeyD'], ['KeyD', 'KeyS'], ['KeyS'], ['KeyA', 'KeyS'], ['KeyA'], ['KeyW']]
  for (const combo of roam) {
    await setKeys(new Set(combo))
    await sleep(650)
  }
  await releaseAll()
  const afterRoam = await readState()
  const moved = Math.hypot(afterRoam.self.x - start.self.x, afterRoam.self.y - start.self.y)
  log('moved distance since spawn:', moved.toFixed(2), 'tiles')
  if (moved < 0.5) throw new Error(`Player did not move (dist ${moved.toFixed(2)}) — input not wired`)
  await screenshot(page, 'move')

  let combatShot = false
  for (let i = 0; i < 55; i++) {
    const st = await readState()
    if (!st || !st.npc) break
    await setKeys(keysToward(st.self, st.npc))
    if (st.npcD < 1.4) {
      await page.keyboard.press('Space')
      if (!combatShot) {
        await screenshot(page, 'combat')
        combatShot = true
      }
    }
    await sleep(200)
  }
  await releaseAll()
  if (!combatShot) await screenshot(page, 'combat')

  let interactShot = false
  for (let i = 0; i < 45; i++) {
    const st = await readState()
    if (!st || !st.door) break
    if (st.door.open && st.doorD < 2) break
    await setKeys(keysToward(st.self, st.door))
    if (st.doorD < 1.5) {
      await page.keyboard.press('KeyE')
      if (!interactShot) {
        await screenshot(page, 'interact-door')
        interactShot = true
      }
    }
    await sleep(200)
  }
  await releaseAll()
  if (!interactShot) await screenshot(page, 'interact-door')

  for (let i = 0; i < 30; i++) {
    const st = await readState()
    if (!st) break
    const target = st.item ?? st.npc ?? st.door
    if (!target) {
      await setKeys(new Set(['KeyD']))
      await sleep(200)
      continue
    }
    await setKeys(keysToward(st.self, target))
    if (st.item && st.itemD < 1.2) await page.keyboard.press('KeyE')
    await sleep(200)
  }
  await releaseAll()
  await screenshot(page, 'mission')

  const end = await readState()
  log('ended at', end.self, 'hp:', end.hp, 'mission:', end.mission)

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error('no webm produced')
  renameSync(join(VIDEO_DIR, webm), join(OUT, 'web-game-proof.webm'))
  log('video ->', join(OUT, 'web-game-proof.webm'))

  if (pageErrors.length) throw new Error(`${pageErrors.length} page error(s): ${pageErrors.join(' | ')}`)
  log('SUCCESS: play session complete, zero page errors')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
