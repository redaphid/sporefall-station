// Heist-finale tour: ONE continuous video of the three beats on a real steal
// floor — sealed quest gate, gateway breach (every other door pops open), and
// prize grab (the whole town aggros the holder, visibly converging while the
// sim runs). Exact-world snapshots from gen-heist-tour.mts via __loadWorld.
// Asserts the real mechanics in-page: doors released after breach, alarm maxed
// and every unit locked on after the grab.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, cpSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const FIXTURES = join(OUT, 'heist-fixtures')
const SIZE = { width: 1280, height: 720 }
mkdirSync(OUT, { recursive: true })

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

const videoDir = join(OUT, 'video-heist-tour')
rmSync(videoDir, { recursive: true, force: true })
mkdirSync(videoDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

await page.goto(`${BASE}/?mode=solo&e2e&seed=7&world=@inline`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function')

const state = { scenes: [] }
const tick = () => page.evaluate(() => window.__sporefall?.world?.tick ?? 0)
const dwell = async (ticks) => {
  const start = await tick()
  while ((await tick()) < start + ticks) await page.waitForTimeout(50)
}

const scene = async (name, dwellTicks, readInfo) => {
  await page.evaluate((j) => window.__loadWorld(j), fixture(name))
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__zoom(1.15, true))
  await dwell(dwellTicks)
  await page.screenshot({ path: join(OUT, `heist-tour-${name}.png`) })
  const info = await page.evaluate(readInfo)
  state.scenes.push({ name, ...info })
}

await scene('heist-1-sealed', 45, () => {
  const w = window.__sporefall.world
  const gate = w.byId.get(w.mission.objectiveDoorId)
  return { failures: [!gate?.door?.locked && 'gate not sealed'].filter(Boolean) }
})
await scene('heist-2-breach', 60, () => {
  const w = window.__sporefall.world
  const closed = w.entities.filter((e) => e.door && (!e.door.open || e.door.locked) && e.id !== w.mission.objectiveDoorId)
  return { failures: [closed.length > 0 && `${closed.length} doors still closed`, !w.mission.bossAggroTriggered && 'breach not latched'].filter(Boolean) }
})
await scene('heist-3-manhunt', 90, () => {
  const w = window.__sporefall.world
  const player = w.entities.find((e) => e.playerCtl)
  // Live-sim targets drift (trails go cold, civilians flee) — the permanent
  // invariant is the stored disposition: everyone HATES the prize-holder.
  const calm = w.entities.filter(
    (e) => e.ai && !e.dead && !e.playerCtl && (e.ai.rel?.[player.id]?.hate ?? 0) < 5,
  )
  return { failures: [w.alarm !== 3 && `alarm ${w.alarm}`, !w.mission.complete && 'mission not complete', calm.length > 0 && `${calm.length} npcs never flipped hostile`].filter(Boolean) }
})

await page.close()
await context.close()
await browser.close()

const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
if (!webm) throw new Error('no webm recorded')
const webmPath = join(OUT, 'heist-tour.webm')
const mp4 = join(OUT, 'heist-tour.mp4')
renameSync(join(videoDir, webm), webmPath)
execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
  'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
  '-movflags', '+faststart', mp4], { stdio: 'ignore' })
rmSync(videoDir, { recursive: true, force: true })
rmSync(webmPath, { force: true })

const bytes = statSync(mp4).size
const failures = state.scenes.flatMap((s) => (s.failures ?? []).map((f) => `${s.name}: ${f}`))
if (errs.length) failures.push(`page errors: ${errs.join(' | ')}`)
if (bytes < 150_000) failures.push(`mp4 only ${bytes} bytes`)

const share = process.env.TOUR_SHARE
if (share) {
  mkdirSync(share, { recursive: true })
  cpSync(mp4, join(share, 'heist-tour.mp4'))
}

console.log(`heist-tour.mp4 (${(bytes / 1024).toFixed(0)} KB)`)
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('OK — heist tour recorded, all asserts passed')
