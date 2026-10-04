import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
export const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
// Optional extra copy target (the parent shares these under a scratchpad dir).
const SHARE = process.env.E2E_SHARE ?? ''
const SIZE = { width: 1280, height: 720 }
// Playwright ships its own ffmpeg, but that build is webm-only (no libx264), so
// a machine without a system ffmpeg can still produce a real video — it just
// stays webm. `E2E_FFMPEG` overrides the binary; `E2E_VIDEO=webm` skips the mux.
const FFMPEG = process.env.E2E_FFMPEG ?? 'ffmpeg'
const WANT_WEBM = process.env.E2E_VIDEO === 'webm'

/**
 * The browser these recordings drive.
 *
 * Default (CI, and any box with a working display-less setup): a headless
 * chromium Playwright launches itself, exactly as before.
 *
 * `E2E_HEADFUL=1` launches the SAME chromium headed — the real compositor path,
 * which is what a human actually sees. It needs a display; on a box whose
 * display server is unusable (WSL2 with a wedged WSLg is the case that forced
 * this), point `E2E_CDP` at an already-running headed browser's DevTools
 * endpoint instead (e.g. a Windows-side `chrome.exe --remote-debugging-port=9333`,
 * reachable from WSL when networkingMode=mirrored) and every recording runs in
 * that real window. The connection is shared across recordings in one process,
 * so the script — not `record()` — owns the browser's lifetime.
 */
let sharedBrowser = null
export const acquireBrowser = async () => {
  if (process.env.E2E_CDP) {
    sharedBrowser ??= await chromium.connectOverCDP(process.env.E2E_CDP)
    return { browser: sharedBrowser, shared: true }
  }
  return { browser: await chromium.launch({ headless: process.env.E2E_HEADFUL !== '1' }), shared: false }
}

/** Release a browser acquired above; shared (CDP) connections outlive the run. */
export const releaseBrowser = async () => {
  if (sharedBrowser) {
    const b = sharedBrowser
    sharedBrowser = null
    await b.close().catch(() => {})
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
 * @param {string} name output basename (`${name}.mp4`)
 * @param {string} videoDir playwright's recordVideo dir, consumed and removed
 * @returns {{mp4:string, bytes:number}}
 */
export const muxVideo = (name, videoDir) => {
  mkdirSync(OUT, { recursive: true })
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error(`${name}: no webm recorded`)
  const webmPath = join(OUT, `${name}.webm`)
  const mp4 = join(OUT, `${name}.mp4`)
  renameSync(join(videoDir, webm), webmPath)
  rmSync(videoDir, { recursive: true, force: true })
  if (WANT_WEBM) return { mp4: webmPath, bytes: statSync(webmPath).size }
  execFileSync(FFMPEG, ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-movflags', '+faststart', mp4], { stdio: 'ignore' })
  rmSync(webmPath, { force: true })
  return { mp4, bytes: statSync(mp4).size }
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
 *          readState:() => any, expect:(s:any)=>string[], ignoreConsole?:RegExp,
 *          beforeTicks?:(page:import('playwright').Page)=>Promise<void>}} spec
 */
export const record = async (spec) => {
  mkdirSync(OUT, { recursive: true })
  const url = `${BASE}/?${new URLSearchParams(spec.params)}`
  const videoDir = join(OUT, `video-${spec.name}`)
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })

  const { browser, shared } = await acquireBrowser()
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
  const page = await context.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !spec.ignoreConsole?.test(m.text()) && errs.push(`console: ${m.text()}`))

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
  if (!shared) await browser.close()

  const { mp4, bytes } = muxVideo(spec.name, videoDir)
  const failures = [...spec.expect(state)]
  if (errs.length) failures.push(`page errors: ${errs.join(' | ')}`)
  if (bytes < 100_000) failures.push(`mp4 only ${bytes} bytes`)

  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    cpSync(mp4, join(SHARE, `${spec.name}.mp4`))
    for (const s of spec.stills) cpSync(join(OUT, `${spec.name}-${s.label}.png`), join(SHARE, `${spec.name}-${s.label}.png`))
  }

  console.log(`\n[${spec.name}] ${mp4} (${(bytes / 1024).toFixed(0)} KB)`)
  console.log(`[${spec.name}] state: ${JSON.stringify(state)}`)
  if (failures.length) {
    for (const f of failures) console.error(`[${spec.name}] FAIL: ${f}`)
    process.exitCode = 1
    return false
  }
  console.log(`[${spec.name}] OK — all asserts passed`)
  return true
}
