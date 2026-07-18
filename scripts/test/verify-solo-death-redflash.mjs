// #52 proof: drive the REAL solo build to (a) a downed→self-revive and (b) a
// pool-exhausted death→run-over restart overlay, capturing screenshots + a video
// that show the low-health red vignette is NOT stuck on a 0-hp/dead/gameOver
// body. Uses the ?e2e debug surface (window.__sor / window.__debug) on the live
// host world — no page reload, connection-preserving restart flow (#31).
//
//   BASE_URL=http://localhost:4173 node scripts/test/verify-solo-death-redflash.mjs
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.OUT_DIR ?? join(__dirname, '../../e2e/output')
const SHARE =
  process.env.SHARE_DIR ??
  '/tmp/claude-1000/-home-redaphid-Projects-streets-of-rogue-mobile/c1fe7c36-8312-475b-8777-001ccbc9693d/scratchpad/death-fix-shots'
const SIZE = { width: 1280, height: 720 }

mkdirSync(OUT, { recursive: true })
mkdirSync(SHARE, { recursive: true })
const videoDir = join(OUT, 'video-solo-death')
rmSync(videoDir, { recursive: true, force: true })
mkdirSync(videoDir, { recursive: true })

const shots = []
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

const snap = async (label) => {
  const path = join(OUT, `solo-death-${label}.png`)
  await page.screenshot({ path })
  shots.push(path)
}
const tick = () => page.evaluate(() => window.__sor?.world?.tick ?? -1)
const waitTicks = async (n) => {
  const start = await tick()
  while ((await tick()) < start + n) await page.waitForTimeout(30)
}
// Read a compact view of the local player + run state off the live world.
const readState = () =>
  page.evaluate(() => {
    const w = window.__sor.world
    const p = w.entities.find((e) => e.playerCtl)
    return {
      tick: w.tick,
      gameOver: w.gameOver,
      mode: w.mode,
      revivesLeft: w.revivesLeft,
      hp: p?.health?.hp ?? null,
      maxHp: p?.health?.max ?? null,
      downed: !!p?.playerCtl?.downed,
      dead: !!p?.dead,
      restartVisible: (() => {
        const b = document.querySelector('#restart')
        return !!b && getComputedStyle(b).display !== 'none' && b.offsetParent !== null
      })(),
    }
  })

await page.goto(`${BASE}/?e2e&mode=solo&seed=7`, { waitUntil: 'networkidle' })
// Wait for the host world + a player entity to exist.
await page.waitForFunction(() => window.__sor?.world?.entities?.some((e) => e.playerCtl), null, { timeout: 15000 })
await waitTicks(5)
console.log('booted:', JSON.stringify(await readState()))
await snap('01-alive')

// ---- Phase A: down the solo player, prove the red vignette is gated OFF while
// downed, then let the bleed-out self-revive (revive pool still full). ----------
await page.evaluate(() => {
  const w = window.__sor.world
  const p = w.entities.find((e) => e.playerCtl)
  p.health.iframes = 0
  p.health.hp = 1
  window.__pid = p.id
})
await page.evaluate(() => window.__debug.hit(window.__pid, 9999)) // lethal → DOWNED (pool > 0)
await waitTicks(3)
let s = await readState()
check(s.downed && !s.dead, `solo lethal hit → DOWNED, not dead (downed=${s.downed} dead=${s.dead})`)
check(!s.gameOver, 'a lone downed solo player is NOT a run-over (gameOver=false)')
await snap('02-downed')

// Prove DOT can't trap the downed body: keep hitting — must stay downed, timer
// must not re-arm. Then shorten the bleed and let it self-revive.
await page.evaluate(() => {
  const w = window.__sor.world
  const p = w.entities.find((e) => e.playerCtl)
  for (let i = 0; i < 3; i++) window.__debug.hit(window.__pid, 9999)
  p.playerCtl.downed.bleedTicks = 4 // fast-forward the 30s bleed for the video
})
await waitTicks(20)
s = await readState()
check(!s.downed && !s.dead && s.hp > 0, `solo bleed-out SELF-REVIVES (hp=${s.hp}, downed=${s.downed})`)
check(s.revivesLeft < 2, `self-revive spent a comeback (revivesLeft=${s.revivesLeft})`)
await snap('03-revived')

// ---- Phase B: exhaust the revive pool, then a death is a real run-over → the
// connection-preserving restart overlay (no page reload). ----------------------
await page.evaluate(() => {
  const w = window.__sor.world
  const p = w.entities.find((e) => e.playerCtl)
  w.revivesLeft = 0 // comeback economy spent
  p.health.iframes = 0
  p.health.hp = 1
})
await page.evaluate(() => window.__debug.hit(window.__pid, 9999)) // lethal with empty pool → DEATH
await page.waitForFunction(() => window.__sor.world.gameOver === true, null, { timeout: 5000 })
await page.waitForFunction(
  () => {
    const b = document.querySelector('#restart')
    return !!b && b.offsetParent !== null
  },
  null,
  { timeout: 5000 },
)
await waitTicks(2)
s = await readState()
check(s.gameOver, 'pool-exhausted solo death → gameOver=true (run over)')
check(s.restartVisible, 'the in-app restart overlay (#restart "Run it back") is shown')
await snap('04-gameover-restart')

// ---- Restart in place (host restart, transport untouched) clears run state. ---
await page.click('#restart')
await page.waitForFunction(() => window.__sor.world.gameOver === false, null, { timeout: 5000 })
await waitTicks(5)
s = await readState()
check(!s.gameOver && !s.dead && s.hp > 0, `restart cleared state → fresh run (gameOver=${s.gameOver}, hp=${s.hp})`)
await snap('05-restarted')

// ---- Finish: mux the video, copy artifacts to the shared scratchpad dir. ------
const state = await readState()
await page.close()
await context.close()
await browser.close()

const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
let mp4 = null
if (webm) {
  const webmPath = join(OUT, 'solo-death.webm')
  mp4 = join(OUT, 'solo-death.mp4')
  renameSync(join(videoDir, webm), webmPath)
  execFileSync(
    'ffmpeg',
    ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-movflags', '+faststart', mp4],
    { stdio: 'ignore' },
  )
  rmSync(videoDir, { recursive: true, force: true })
  rmSync(webmPath, { force: true })
} else {
  failures.push('no webm recorded')
}

// Copy stills + mp4 to the shared dir the parent reads.
const { cpSync } = await import('node:fs')
for (const p of shots) cpSync(p, join(SHARE, p.split('/').pop()))
if (mp4) cpSync(mp4, join(SHARE, 'solo-death.mp4'))

if (errs.length) console.error('PAGE ERRORS:', errs.join(' | '))
console.log('\nfinal state:', JSON.stringify(state))
console.log('artifacts:')
for (const f of readdirSync(SHARE)) {
  const sz = statSync(join(SHARE, f)).size
  console.log(`  ${f}  ${sz} bytes`)
}
if (failures.length || errs.length) {
  console.error(`\n${failures.length} assertion failure(s), ${errs.length} page error(s)`)
  process.exit(1)
}
console.log('\nALL PROOF ASSERTIONS PASSED')
