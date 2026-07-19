// Camera zoom e2e: pinch/scrollwheel view zoom (feat/camera-zoom).
//
// Records one continuous solo session (script=demo) while driving the REAL
// input paths:
//   1. scroll-wheel zoom in/out over the canvas (cursor-anchored),
//   2. smooth __zoom sweeps for the video narrative,
//   3. stills at min / default / max zoom,
//   4. tap-to-inspect at zoom 0.5 / 1 / 3 — the classic screen→world picking bug,
//   5. a second, touch-enabled page: a REAL two-finger pinch (CDP synthesized)
//      on the right half must zoom in without firing or moving the player.
//
// Zoom is measured through the live camera via __project: two world points one
// tile apart project TILE_PX*zoom px apart — no test-only state exposed.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''
const SIZE = { width: 1280, height: 720 }
const TILE_PX = 32

mkdirSync(OUT, { recursive: true })
const fail = []
const errs = []

/** Live zoom, measured through the real camera projection. */
const measureZoom = async (page) => {
  const d = await page.evaluate(() => {
    const a = window.__project(50, 50)
    const b = window.__project(51, 50)
    return b.x - a.x
  })
  return d / TILE_PX
}
const tick = (page) => page.evaluate(() => window.__world?.tick ?? 0)
const untilTick = async (page, t) => {
  while ((await tick(page)) < t) await page.waitForTimeout(40)
}
const shot = (page, label) => page.screenshot({ path: join(OUT, `zoom-${label}.png`) })

const browser = await chromium.launch({ headless: true })

// ---------- part 1: recorded wheel/inspect session ----------
const videoDir = join(OUT, 'video-zoom')
rmSync(videoDir, { recursive: true, force: true })
mkdirSync(videoDir, { recursive: true })
const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
const page = await ctx.newPage()
page.on('pageerror', (e) => errs.push(String(e)))

await page.goto(`${BASE}/?e2e=1&mode=solo&script=demo&seed=7`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__project === 'function', { timeout: 20000 })
await untilTick(page, 40)

// -- scroll wheel over the canvas: in, then out; cursor-anchored --
await page.mouse.move(640, 340)
const z0 = await measureZoom(page)
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(80)
}
await page.waitForTimeout(900) // let the smoothing settle
const zIn = await measureZoom(page)
if (!(zIn > z0 * 1.5)) fail.push(`wheel-in: zoom ${z0} -> ${zIn}, expected a real increase`)
await shot(page, 'wheel-in')

for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, 120)
  await page.waitForTimeout(80)
}
await page.waitForTimeout(900)
const zOut = await measureZoom(page)
if (!(zOut < zIn)) fail.push(`wheel-out: zoom ${zIn} -> ${zOut}, expected a decrease`)
await shot(page, 'wheel-out')

// -- smooth sweeps for the video: far out, all the way in, back to default --
for (const z of [0.5, 4, 1]) {
  await page.evaluate((v) => window.__zoom(v), z)
  await page.waitForTimeout(1200)
}

// -- run the rest of the demo script at default zoom, then inspect-test idle --
const total = await page.evaluate(() => window.__scriptTicks ?? 0)
await untilTick(page, total)
await page.waitForTimeout(400)

// -- tap-to-inspect must resolve at every zoom level (screen→world picking) --
const player = JSON.parse(await page.evaluate(() => window.__verb('entities'))).find((e) => e.playerCtl)
for (const z of [0.5, 1, 3]) {
  await page.evaluate((v) => window.__zoom(v, true), z)
  await page.waitForTimeout(300)
  const pos = JSON.parse(await page.evaluate((id) => window.__verb(`get ${id}`), player.id)).pos
  const p = await page.evaluate(({ x, y }) => window.__project(x, y), pos)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  const selected = JSON.parse(await page.evaluate((id) => window.__verb(`get ${id}`), player.id)).selected
  if (!selected) fail.push(`tap-to-inspect missed the player at zoom ${z}`)
  await page.evaluate((id) => window.__verb(`set ${id} {"selected":false}`), player.id)
}

// -- stills at the three canonical zoom levels --
for (const [z, label] of [[0.5, 'min'], [1, 'default'], [4, 'max']]) {
  await page.evaluate((v) => window.__zoom(v, true), z)
  await page.waitForTimeout(400)
  const measured = await measureZoom(page)
  if (Math.abs(measured - z) > 0.01) fail.push(`still ${label}: measured zoom ${measured}, want ${z}`)
  await shot(page, label)
}

await page.close()
await ctx.close()

// mux the session video like lib.mjs does
const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
if (!webm) fail.push('no webm recorded')
else {
  const webmPath = join(OUT, 'zoom-session.webm')
  const mp4 = join(OUT, 'zoom-session.mp4')
  renameSync(join(videoDir, webm), webmPath)
  execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-movflags', '+faststart', mp4], { stdio: 'ignore' })
  rmSync(webmPath, { force: true })
  const bytes = statSync(mp4).size
  if (bytes < 100_000) fail.push(`mp4 only ${bytes} bytes`)
}
rmSync(videoDir, { recursive: true, force: true })

// ---------- part 2: a REAL two-finger pinch on a touch device ----------
const tctx = await browser.newContext({ viewport: SIZE, hasTouch: true })
const tpage = await tctx.newPage()
tpage.on('pageerror', (e) => errs.push(String(e)))
await tpage.goto(`${BASE}/?e2e=1&mode=solo&seed=7`, { waitUntil: 'networkidle' })
await tpage.waitForFunction(() => typeof window.__project === 'function', { timeout: 20000 })
await tpage.waitForTimeout(500)

const before = JSON.parse(await tpage.evaluate(() => window.__verb('entities'))).find((e) => e.playerCtl)
const zPre = await measureZoom(tpage)
// Two fingers spreading apart on the RIGHT half (aim-stick territory): the fresh
// stick claim must convert to a pinch — zoom in, no fire, no movement.
const cdp = await tctx.newCDPSession(tpage)
await cdp.send('Input.synthesizePinchGesture', {
  x: 900,
  y: 300,
  scaleFactor: 2.5,
  relativeSpeed: 400,
  gestureSourceType: 'touch',
})
await tpage.waitForTimeout(900)
const zPinch = await measureZoom(tpage)
if (!(zPinch > zPre * 1.2)) fail.push(`pinch: zoom ${zPre} -> ${zPinch}, expected a real increase`)
await shot(tpage, 'pinch')

const after = JSON.parse(await tpage.evaluate((id) => window.__verb(`get ${id}`), before.id))
const moved = Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y)
if (moved > 0.05) fail.push(`pinch moved the player ${moved} tiles — stick input leaked`)
const shots = JSON.parse(await tpage.evaluate(() => window.__verb('entities'))).filter(
  (e) => e.kind === 'projectile' && e.projectile?.ownerId === before.id,
)
if (shots.length > 0) fail.push(`pinch fired ${shots.length} player projectile(s)`)

await tpage.close()
await tctx.close()
await browser.close()

if (errs.length) fail.push(`page errors: ${errs.join(' | ')}`)

if (SHARE) {
  mkdirSync(SHARE, { recursive: true })
  for (const f of readdirSync(OUT)) if (f.startsWith('zoom-') || f === 'zoom-session.mp4') cpSync(join(OUT, f), join(SHARE, f))
}

if (fail.length) {
  for (const f of fail) console.error('[zoom] FAIL:', f)
  process.exitCode = 1
} else {
  console.log('[zoom] OK — wheel in/out, anchored zoom, inspect at 0.5/1/3, stills, real pinch')
}
