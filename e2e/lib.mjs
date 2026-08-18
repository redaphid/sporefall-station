import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
export const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
// Optional extra copy target (the parent shares these under a scratchpad dir).
const SHARE = process.env.E2E_SHARE ?? ''
const SIZE = { width: 1280, height: 720 }

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
  execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-movflags', '+faststart', mp4], { stdio: 'ignore' })
  rmSync(videoDir, { recursive: true, force: true })
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

/**
 * Take the stairs, the way the game does: unlock the exit and stand a live
 * player on the exit tile, then let the HOST's own missionSystem call nextFloor.
 * No test-only backdoor — the transition is one the sim genuinely produced, so
 * the floor a client has to match is a real floor.
 *
 * Shared because a floor change is the biggest state transition in the game and
 * every multiplayer proof needs to trigger one: offline-coop.mjs (BLE-shaped,
 * over BroadcastChannel) and ws-multiplayer.mjs (the relay) must exercise the SAME
 * transition, or the two transports are being judged against different games.
 *
 * Re-applied every poll because the movement systems keep running underneath;
 * once the floor HAS changed we touch nothing, since re-unlocking the new
 * floor's exit would immediately take a second staircase and overshoot.
 *
 * @param {import('playwright').Page} page a page running an authoritative world
 * @param {number} ms give-up budget
 * @returns {Promise<number>} the floor now (unchanged if it never advanced)
 */
export const advanceHostFloor = async (page, ms = 20000) => {
  const before = await page.evaluate(() => globalThis.world?.floor ?? 0)
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const now = await page.evaluate((from) => {
      const w = globalThis.world
      if (!w) return 0
      if (w.floor !== from) return w.floor
      w.mission.exitUnlocked = true
      for (const e of w.entities) {
        if (!e.playerCtl || e.dead || e.playerCtl.downed) continue
        e.pos.x = w.level.exit.x + 0.5
        e.pos.y = w.level.exit.y + 0.5
        e.prevPos.x = e.pos.x
        e.prevPos.y = e.pos.y
        break
      }
      return w.floor
    }, before)
    if (now > before) return now
    await sleep(100)
  }
  return before
}
