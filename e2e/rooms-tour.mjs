// Rooms-make-sense tour: ONE continuous video visiting a furnished apartment,
// shop, office and bunker — exact-world snapshots (gen-rooms-tour.mts) pushed
// into the live build via window.__loadWorld, every room labelled with its
// assigned RoomType and signature furnishings pinned. Asserts each loaded
// world really carries typed rooms and in-building furniture, and that nothing
// errored.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, cpSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const FIXTURES = join(OUT, 'rooms-fixtures')
const SIZE = { width: 1280, height: 720 }
mkdirSync(OUT, { recursive: true })

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

const videoDir = join(OUT, 'video-rooms-tour')
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

const scene = async (name, role) => {
  await page.evaluate((j) => window.__loadWorld(j), fixture(name))
  await page.waitForTimeout(300)
  // Close-up on the furnished rooms, then pull back for the whole building.
  await page.evaluate(() => window.__zoom(1.7, true))
  await dwell(50)
  await page.screenshot({ path: join(OUT, `rooms-tour-${name}-close.png`) })
  await page.evaluate(() => window.__zoom(1.0))
  await dwell(60)
  await page.screenshot({ path: join(OUT, `rooms-tour-${name}-building.png`) })
  const info = await page.evaluate((wantRole) => {
    const w = window.__sporefall.world
    const player = w.entities.find((e) => e.playerCtl)
    const bi = w.level.buildings.findIndex(
      (b) =>
        player.pos.x >= b.rect.x && player.pos.x <= b.rect.x + b.rect.w &&
        player.pos.y >= b.rect.y && player.pos.y <= b.rect.y + b.rect.h,
    )
    const b = w.level.buildings[bi]
    const props = w.entities.filter(
      (e) =>
        e.kind === 'interactable' && !e.dead &&
        e.pos.x >= b.rect.x && e.pos.x <= b.rect.x + b.rect.w &&
        e.pos.y >= b.rect.y && e.pos.y <= b.rect.y + b.rect.h,
    )
    return {
      role: b.role, wantRole, roomTypes: b.roomTypes ?? [],
      rooms: b.rooms.length, propCount: props.length, annotations: w.annotations.length,
    }
  }, role)
  state.scenes.push({
    name,
    ...info,
    failures: [
      info.role !== role && `role ${info.role} != ${role}`,
      info.roomTypes.length !== info.rooms && 'rooms without types',
      info.propCount < 1 && 'no furniture in building',
      info.annotations < info.rooms && 'rooms unlabelled',
    ].filter(Boolean),
  })
}

await scene('rooms-1-apartment', 'apartment')
await scene('rooms-2-shop', 'shop')
await scene('rooms-3-office', 'office')
await scene('rooms-4-bunker', 'bunker')

await page.close()
await context.close()
await browser.close()

const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
if (!webm) throw new Error('no webm recorded')
const webmPath = join(OUT, 'rooms-tour.webm')
const mp4 = join(OUT, 'rooms-tour.mp4')
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
  cpSync(mp4, join(share, 'rooms-tour.mp4'))
}

console.log(`rooms-tour.mp4 (${(bytes / 1024).toFixed(0)} KB)`)
for (const s of state.scenes) console.log(`  ${s.name}: ${s.role} rooms=[${s.roomTypes.join(',')}] props=${s.propCount}`)
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('OK — rooms tour recorded, all asserts passed')
