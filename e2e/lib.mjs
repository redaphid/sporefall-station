import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
export const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
// Optional extra copy target (the parent shares these under a scratchpad dir).
const SHARE = process.env.E2E_SHARE ?? ''
const SIZE = { width: 1280, height: 720 }

/** Playwright's browser cache root — where `npx playwright install` lays the
 * bundled binaries down, including its own private ffmpeg build. */
const playwrightBrowsersPath = () => {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright')
  return join(homedir(), '.cache', 'ms-playwright')
}

/**
 * Playwright's OWN bundled ffmpeg, resolved rather than hardcoded.
 *
 * The revision comes from `playwright-core/browsers.json` (the same file the
 * installer reads), so a playwright upgrade that moves `ffmpeg-1011` →
 * `ffmpeg-1012` keeps working. The directory listing is the fallback for the
 * platform-specific executable NAME (`ffmpeg-linux`, `ffmpeg-mac-arm64`,
 * `ffmpeg-win64.exe`), which is not worth restating here.
 */
const bundledFfmpeg = () => {
  const root = playwrightBrowsersPath()
  if (!existsSync(root)) return undefined
  let dirs = []
  try {
    const require = createRequire(import.meta.url)
    const entry = require('playwright-core/browsers.json').browsers.find((b) => b.name === 'ffmpeg')
    if (entry?.revision) dirs.push(`ffmpeg-${entry.revision}`)
  } catch {
    // browsers.json moved or unreadable — the directory scan below still finds it.
  }
  dirs = [...dirs, ...readdirSync(root).filter((d) => d.startsWith('ffmpeg-'))]
  for (const d of dirs) {
    const dir = join(root, d)
    if (!existsSync(dir)) continue
    const exe = readdirSync(dir).find((f) => f.startsWith('ffmpeg-'))
    if (exe) return join(dir, exe)
  }
  return undefined
}

/**
 * The ffmpeg to mux with: `$FFMPEG_PATH`, else one on PATH, else playwright's.
 *
 * PATH COMES FIRST ON PURPOSE. CI installs a full system ffmpeg with apt
 * (.github/workflows/web-e2e.yml) and that is the build these recordings are
 * specified against — it is the only one of the three that can produce the
 * h264 mp4 below. The bundled fallback exists so a DEV BOX with no system
 * ffmpeg still records something real instead of dying on ENOENT; see
 * `canEncodeH264` for what that costs.
 */
export const resolveFfmpeg = () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return 'ffmpeg'
  } catch {
    return bundledFfmpeg()
  }
}

/**
 * Can this ffmpeg actually write the h264 mp4 we ask for?
 *
 * Playwright's bundled build is compiled `--disable-everything` with just
 * enough enabled to WRITE the screencast webm it records (libvpx/VP8 + the
 * webm muxer). It has no libx264 and no mp4 muxer at all, so asking it for one
 * fails — which is a different thing from ffmpeg being missing, and the two
 * want different messages. Probed rather than assumed: a system ffmpeg that
 * happens to be built without libx264 lands here too.
 */
const canEncodeH264 = (bin) => {
  try {
    return execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx264')
  } catch {
    return false
  }
}

/**
 * Playwright's per-context webm → a real h264 mp4 in OUT, cleaning up after
 * itself. Split out of `record()` so the MULTI-PAGE scenarios (co-op needs two
 * or three pages in one context, which `record()`'s single-page shape cannot
 * express) still produce their video through exactly this code path rather than
 * a second, drifting copy of the ffmpeg invocation.
 *
 * `videoDir` is a context's `recordVideo.dir`; the first webm found in it wins,
 * so pass a directory holding only the page you want.
 *
 * DEGRADES, NEVER SKIPS. With no h264-capable ffmpeg the webm playwright
 * already wrote IS the recording and is kept as the deliverable — a real video
 * of the real run, just not remuxed. Returning nothing (or deleting it) would
 * turn "this box cannot transcode" into "there is no proof", which is the one
 * outcome the video mandate exists to prevent. `mp4` is therefore set ONLY when
 * an mp4 genuinely exists; read `video` for the file that was produced.
 *
 * @param {string} name output basename (`${name}.mp4`, or `${name}.webm`)
 * @param {string} videoDir playwright's recordVideo dir, consumed and removed
 * @returns {{video:string, format:'mp4'|'webm', bytes:number, mp4?:string, note?:string}}
 */
export const muxVideo = (name, videoDir) => {
  mkdirSync(OUT, { recursive: true })
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error(`${name}: no webm recorded`)
  const webmPath = join(OUT, `${name}.webm`)
  const mp4 = join(OUT, `${name}.mp4`)
  renameSync(join(videoDir, webm), webmPath)

  const bin = resolveFfmpeg()
  const keepWebm = (note) => {
    rmSync(videoDir, { recursive: true, force: true })
    return { video: webmPath, format: 'webm', bytes: statSync(webmPath).size, note }
  }
  if (!bin) return keepWebm('no ffmpeg found (PATH, $FFMPEG_PATH or playwright) — kept the raw webm')
  if (!canEncodeH264(bin)) return keepWebm(`${bin} has no libx264/mp4 support — kept the raw webm`)

  execFileSync(bin, ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-movflags', '+faststart', mp4], { stdio: 'ignore' })
  rmSync(videoDir, { recursive: true, force: true })
  rmSync(webmPath, { force: true })
  return { video: mp4, format: 'mp4', bytes: statSync(mp4).size, mp4 }
}

/**
 * Deterministic e2e recording. Drives the real pixi build with a scripted input
 * timeline (?script=…), snaps labelled stills at fixed SIM TICKS (not wall-clock),
 * asserts on the final world state, then muxes webm→mp4 and verifies it is real.
 *
 * An optional `beforeTicks(page)` hook runs once after navigation but before any
 * ticks are awaited — used by the exact-world recipe to push an inline WorldJson
 * into `window.__loadWorld` (boot blocks on it, so injection precedes tick 0).
 *
 * A still may also carry an `act(page)` hook — run when its tick is reached,
 * BEFORE the screenshot (with a short settle so the DOM it changed renders).
 * This is how UI e2es tap real DOM (mission panel, buttons) at deterministic
 * sim times without any pixel math.
 *
 * @param {{name:string, params:object,
 *          stills:{tick:number,label:string,act?:(page:import('playwright').Page)=>Promise<void>}[],
 *          readState:() => any, expect:(s:any)=>string[],
 *          beforeTicks?:(page:import('playwright').Page)=>Promise<void>}} spec
 */
export const record = async (spec) => {
  mkdirSync(OUT, { recursive: true })
  const url = `${BASE}/?${new URLSearchParams(spec.params)}`
  const videoDir = join(OUT, `video-${spec.name}`)
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
  const page = await context.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

  const tick = () => page.evaluate(() => window.__world?.tick ?? 0)
  await page.goto(url, { waitUntil: 'networkidle' })
  await spec.beforeTicks?.(page)

  for (const s of spec.stills) {
    while ((await tick()) < s.tick) await page.waitForTimeout(40)
    if (s.act) {
      await s.act(page)
      await page.waitForTimeout(250) // let the acted-on DOM/camera settle before the shot
    }
    await page.screenshot({ path: join(OUT, `${spec.name}-${s.label}.png`) })
  }

  const total = await page.evaluate(() => window.__scriptTicks ?? 0)
  while ((await tick()) < total) await page.waitForTimeout(100)
  await page.waitForTimeout(600)

  const state = await page.evaluate(spec.readState)
  await page.close()
  await context.close()
  await browser.close()

  const { video, format, bytes, note } = muxVideo(spec.name, videoDir)
  const failures = [...spec.expect(state)]
  if (errs.length) failures.push(`page errors: ${errs.join(' | ')}`)
  if (bytes < 100_000) failures.push(`video only ${bytes} bytes`)

  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    cpSync(video, join(SHARE, `${spec.name}.${format}`))
    for (const s of spec.stills) cpSync(join(OUT, `${spec.name}-${s.label}.png`), join(SHARE, `${spec.name}-${s.label}.png`))
  }

  if (note) console.log(`[${spec.name}] NOTE: ${note}`)
  console.log(`\n[${spec.name}] ${video} (${(bytes / 1024).toFixed(0)} KB)`)
  console.log(`[${spec.name}] state: ${JSON.stringify(state)}`)
  if (failures.length) {
    for (const f of failures) console.error(`[${spec.name}] FAIL: ${f}`)
    process.exitCode = 1
    return false
  }
  console.log(`[${spec.name}] OK — all asserts passed`)
  return true
}
