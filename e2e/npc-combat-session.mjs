// @ts-check
// Combat-AI proof: boots the `npc-combat` scenario — a ring of ARMED, HOSTILE
// NPCs (bat/knife/pistol/shotgun/machinegun/sledgehammer/freeze-ray/flamethrower)
// around a tanky player — in a real pixi build and asserts that they ACQUIRE the
// player, CONVERGE on them, FIRE bullets, and DEAL damage. Captures a video +
// labelled screenshots and copies them to the scratchpad share dir.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readdirSync, renameSync, cpSync, statSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4897'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-npc-combat')
const SHARE = process.env.E2E_SHARE ?? ''
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '20260715'
const SIZE = { width: 1000, height: 760 }

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[npc-combat ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

let shot = 0
const screenshot = async (page, label) => {
  shot += 1
  const name = `npc-combat-${String(shot).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: join(OUT, name) })
  log('screenshot', name)
  return name
}

const readWorld = (page) =>
  page.evaluate(() => {
    const v = window.__sporefall.renderView()
    const self = { x: v.self.pos.x, y: v.self.pos.y, hp: v.self.health ? v.self.health.hp : null }
    const npcs = []
    let bullets = 0
    for (const e of v.entities) {
      if (e.kind === 'projectile') bullets += 1
      if (e.kind !== 'npc' || e.dead || !e.combat) continue
      npcs.push({
        id: e.id,
        weapon: e.combat.weapon,
        goal: e.ai ? e.ai.goal : null,
        x: e.pos.x,
        y: e.pos.y,
        distToPlayer: Math.hypot(e.pos.x - self.x, e.pos.y - self.y),
      })
    }
    return { self, npcs, bullets }
  })

const avgDist = (s) => s.npcs.reduce((a, n) => a + n.distToPlayer, 0) / Math.max(1, s.npcs.length)
const minDist = (s) => s.npcs.reduce((m, n) => Math.min(m, n.distToPlayer), Infinity)

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: VIDEO_DIR, size: SIZE } })
  const page = await context.newPage()
  page.on('pageerror', (e) => { pageErrors.push(String(e)); log('PAGE ERROR:', String(e)) })
  page.on('console', (m) => m.type() === 'error' && log('console.error:', m.text()))

  await page.goto(`${BASE}/?mode=solo&scenario=npc-combat&e2e=1&seed=${SEED}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const c = document.querySelector('#app canvas')
    return !!c && c.clientWidth > 100 && c.clientHeight > 100
  }, { timeout: 20000 })
  await page.waitForFunction(() => {
    const s = window.__sporefall
    return !!s && !!s.renderView && !!s.renderView().self
  }, { timeout: 20000 })
  await sleep(300)

  const start = await readWorld(page)
  await screenshot(page, 'ring-of-enemies')
  log('start', JSON.stringify({ hp: start.self.hp, weapons: [...new Set(start.npcs.map((n) => n.weapon))], avg: avgDist(start).toFixed(1) }))
  const distinctWeapons = new Set(start.npcs.map((n) => n.weapon))

  // A beat in: the ring has acquired the player and committed to the attack.
  await sleep(500)
  const early = await readWorld(page)
  log('early', JSON.stringify({ hp: early.self.hp, goals: early.npcs.map((n) => n.goal), avg: avgDist(early).toFixed(1) }))

  // Poll while the swarm converges and fires; track peak bullets, grab a mid shot.
  let sawBullets = start.bullets
  let sawBattle = early.npcs.some((n) => n.goal === 'battle')
  for (let i = 0; i < 12; i++) {
    await sleep(250)
    const s = await readWorld(page)
    sawBullets = Math.max(sawBullets, s.bullets)
    if (s.npcs.some((n) => n.goal === 'battle')) sawBattle = true
    if (i === 2) await screenshot(page, 'converging-and-firing')
  }

  await sleep(600)
  const end = await readWorld(page)
  await screenshot(page, 'swarmed')
  log('end', JSON.stringify({ hp: end.self.hp, avg: avgDist(end).toFixed(1), sawBullets }))

  check(distinctWeapons.size >= 5, `the ring carries a spread of weapons (${distinctWeapons.size} distinct: ${[...distinctWeapons].join(', ')})`)
  check(sawBattle, 'the ring committed to BATTLE against the player')
  check(minDist(end) < 3.2, `melee NPCs closed into the player (nearest ${minDist(start).toFixed(1)} -> ${minDist(end).toFixed(1)})`)
  check(avgDist(end) < avgDist(start), `the swarm pressed in on the player, ranged holding a standoff (avg dist ${avgDist(start).toFixed(1)} -> ${avgDist(end).toFixed(1)})`)
  check(sawBullets > 0, `ranged NPCs fired bullets down the shared projectile path (peak ${sawBullets} in flight)`)
  check(end.self.hp < start.self.hp, `the player took damage from the swarm (hp ${start.self.hp} -> ${end.self.hp})`)

  await page.close()
  await context.close()
  await browser.close()

  // Mux webm -> mp4 so it plays anywhere.
  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  let mp4 = ''
  if (webm) {
    const webmPath = join(OUT, 'npc-combat.webm')
    mp4 = join(OUT, 'npc-combat.mp4')
    renameSync(join(VIDEO_DIR, webm), webmPath)
    execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
      `scale=${SIZE.width}:${SIZE.height}:force_original_aspect_ratio=decrease,pad=${SIZE.width}:${SIZE.height}:(ow-iw)/2:(oh-ih)/2`,
      '-movflags', '+faststart', mp4], { stdio: 'ignore' })
    rmSync(webmPath, { force: true })
    log('video ->', mp4, `(${(statSync(mp4).size / 1024).toFixed(0)} KB)`)
  } else {
    failures.push('no webm produced')
  }
  rmSync(VIDEO_DIR, { recursive: true, force: true })

  // Copy stills + mp4 to the scratchpad share dir for the caller.
  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    for (const f of readdirSync(OUT)) if (f.endsWith('.png') || f.endsWith('.mp4')) cpSync(join(OUT, f), join(SHARE, f))
    log('copied stills + mp4 ->', SHARE)
  }

  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`)
  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: armed hostile NPCs acquired, converged, fired, and damaged the player — zero page errors')
}

main().catch((e) => { console.error(e); process.exit(1) })
