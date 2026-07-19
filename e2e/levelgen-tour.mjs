// Levelgen-architecture tour: ONE continuous video visiting the new set-pieces
// on themed floors — bunker airlock, hallway spine, courtyard pit, bevelled
// corners — by pushing exact-world snapshots (gen-levelgen-tour.mts) into the
// live build via window.__loadWorld, with annotation labels narrating each stop
// and __zoom flipping between overview and street level. Asserts the loaded
// worlds really carry the archetypes and that nothing errored.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, cpSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const FIXTURES = join(OUT, 'tour-fixtures')
const SIZE = { width: 1280, height: 720 }
mkdirSync(OUT, { recursive: true })

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

const videoDir = join(OUT, 'video-levelgen-tour')
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
const tick = () => page.evaluate(() => window.__sor?.world?.tick ?? 0)
const dwell = async (ticks) => {
  const start = await tick()
  while ((await tick()) < start + ticks) await page.waitForTimeout(50)
}

let first = true
const scene = async (name, expectFn) => {
  const json = fixture(name)
  if (first) {
    await page.evaluate((j) => window.__loadWorld(j), json)
    first = false
  } else {
    await page.evaluate((j) => window.__loadWorld(j), json)
  }
  await page.waitForTimeout(300)
  // Street-level look, then pull out to the district overview, back in.
  await page.evaluate(() => window.__zoom(1.6, true))
  await dwell(45)
  await page.screenshot({ path: join(OUT, `levelgen-tour-${name}-close.png`) })
  await page.evaluate(() => window.__zoom(0.55))
  await dwell(60)
  await page.screenshot({ path: join(OUT, `levelgen-tour-${name}-overview.png`) })
  await page.evaluate(() => window.__zoom(1.3))
  await dwell(45)
  const info = await page.evaluate(() => {
    const w = window.__sor.world
    return {
      floor: w.floor,
      theme: w.level.theme,
      pois: [...new Set(w.level.buildings.map((b) => b.poi).filter(Boolean))],
      annotations: w.annotations.length,
      maxTile: Math.max(...w.level.tiles),
    }
  })
  state.scenes.push({ name, ...info, failures: expectFn(info) })
}

await scene('tour-1-bunker', (i) =>
  [i.floor !== 3 && 'floor', i.theme !== 'industrial' && 'theme', !i.pois.includes('bunker') && 'no bunker', i.annotations < 4 && 'labels'].filter(Boolean),
)
await scene('tour-2-hallway', (i) => [!i.pois.includes('hallway') && 'no hallway'].filter(Boolean))
await scene('tour-3-courtyard', (i) => [!i.pois.includes('courtyard') && 'no courtyard'].filter(Boolean))
await scene('tour-4-corners', (i) =>
  [i.floor !== 5 && 'floor', i.maxTile < 6 && 'no bevelled corner tiles in level'].filter(Boolean),
)

await page.close()
await context.close()
await browser.close()

const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
if (!webm) throw new Error('no webm recorded')
const webmPath = join(OUT, 'levelgen-tour.webm')
const mp4 = join(OUT, 'levelgen-tour.mp4')
renameSync(join(videoDir, webm), webmPath)
execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
  'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
  '-movflags', '+faststart', mp4], { stdio: 'ignore' })
rmSync(videoDir, { recursive: true, force: true })
rmSync(webmPath, { force: true })

const bytes = statSync(mp4).size
const failures = state.scenes.flatMap((s) => s.failures.map((f) => `${s.name}: ${f}`))
if (errs.length) failures.push(`page errors: ${errs.join(' | ')}`)
if (bytes < 200_000) failures.push(`mp4 only ${bytes} bytes`)

const share = process.env.TOUR_SHARE
if (share) {
  mkdirSync(share, { recursive: true })
  cpSync(mp4, join(share, 'levelgen-tour.mp4'))
}

console.log(`levelgen-tour.mp4 (${(bytes / 1024).toFixed(0)} KB)`)
for (const s of state.scenes) console.log(`  ${s.name}: floor ${s.floor} ${s.theme} pois=[${s.pois.join(',')}]`)
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('OK — levelgen tour recorded, all asserts passed')
