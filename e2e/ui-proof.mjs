// UI-proof recorder for the playtest touch/HUD fixes (#2 no ATK button, #3 compact
// button cluster, #4 hide-under-controller, #5 restart-when-downed). These are pure
// DOM overlays, so instead of driving the full game we bundle the REAL modules
// (createTouch / createScreens) with esbuild, mount them in a phone-sized page, and
// screenshot / record the exact states. No mocked markup — the same code the app runs.
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''
mkdirSync(OUT, { recursive: true })

// Bundle the real UI factories into one browser IIFE exposing them on window.
const entry = `
  import { createTouch } from './src/input/touch'
  import { createScreens } from './src/ui/screens'
  window.__mkTouch = createTouch
  window.__mkScreens = createScreens
`
const bundled = await build({
  stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'ui-proof-entry.ts' },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'error',
})
const js = bundled.outputFiles[0].text

const PHONE = { width: 412, height: 892 }
const page404 = `<!doctype html><html><head><meta charset=utf8><style>
  html,body{margin:0;height:100%;background:radial-gradient(#1a1f2b,#0a0c12);overflow:hidden;font-family:system-ui}
  #app{position:absolute;inset:0}
  .cap{position:absolute;top:14px;left:50%;transform:translateX(-50%);color:#ffd76a;font:700 15px system-ui;
       background:#0009;padding:6px 14px;border-radius:20px;white-space:nowrap;z-index:99}
</style></head><body><div id="app"></div></body></html>`

// A RenderView rich enough for computeTouchLabels + the hotbar (slotted 40-round
// pistol, a throwable so THRW lights, an ability off cooldown).
const viewSrc = (over = {}) => ({
  entities: [], events: [], tick: 0, floor: 1, missionText: 'Reach the exit', missionComplete: false,
  gameOver: false,
  level: { w: 40, h: 40, exit: { x: 20, y: 20 } },
  self: {
    id: 1, pos: { x: 5, y: 5 }, dead: false,
    combat: { weapon: 'pistol', cooldown: 0 },
    playerCtl: {
      playerId: 0, abilityCooldown: 0, cash: 0, crimeUntilTick: 0, activeSlot: 0,
      inventory: [{ itemId: 'pistol', qty: 40 }, { itemId: 'molotov', qty: 2 }],
    },
  },
  ...over,
})

const shots = []
const record = async (name, caption, viewport, drive) => {
  const videoDir = join(OUT, `video-${name}`)
  rmSync(videoDir, { recursive: true, force: true })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport, recordVideo: { dir: videoDir, size: viewport } })
  const page = await context.newPage()
  await page.setContent(page404)
  await page.addScriptTag({ content: js })
  await page.evaluate((c) => {
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = c
    document.body.appendChild(cap)
  }, caption)
  await drive(page, name)
  await page.waitForTimeout(500)
  await page.close(); await context.close(); await browser.close()

  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  if (webm) {
    const webmPath = join(OUT, `${name}.webm`)
    const mp4 = join(OUT, `${name}.mp4`)
    renameSync(join(videoDir, webm), webmPath)
    execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-vf', `scale=${viewport.width}:${viewport.height}`, '-movflags', '+faststart', mp4], { stdio: 'ignore' })
    rmSync(webmPath, { force: true })
    console.log(`[${name}] ${mp4} (${(statSync(mp4).size / 1024).toFixed(0)} KB)`)
  }
  rmSync(videoDir, { recursive: true, force: true })
}

// (b)+(c): the touch layout — NO ATK button, a compact bottom-right cluster; then
// deflect the aim stick to show that AIMING FIRES (the sole attack path).
await record('ui-touch-layout', 'Twin-stick: aim joystick FIRES · no ATK button · compact USE/THRW/SPC/ROLL', PHONE, async (page, name) => {
  await page.evaluate((v) => {
    const t = window.__mkTouch(document.getElementById('app'))
    window.__touch = t
    t.update(v)
  }, viewSrc())
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, `${name}-01-buttons.png`) })
  shots.push(`${name}-01-buttons.png`)
  // Deflect the right (aim) stick hard-right → firing. Show the popped-up nub.
  await page.evaluate(() => {
    const app = document.getElementById('app')
    const zone = [...app.querySelectorAll('div')].find((z) => z.style.width === '50%' && z.style.right === '0px')
    zone.setPointerCapture = () => {}
    const PE = window.PointerEvent
    const cx = 300, cy = 620
    zone.dispatchEvent(new PE('pointerdown', { pointerId: 1, clientX: cx, clientY: cy, bubbles: true }))
    zone.dispatchEvent(new PE('pointermove', { pointerId: 1, clientX: cx + 70, clientY: cy - 20, bubbles: true }))
    window.__fired = window.__touch.sample().attack
  })
  await page.waitForTimeout(400)
  const fired = await page.evaluate(() => window.__fired)
  await page.screenshot({ path: join(OUT, `${name}-02-aim-fires.png`) })
  shots.push(`${name}-02-aim-fires.png`)
  console.log(`[${name}] aim-deflection produced attack=${fired}`)
})

// (d): the same controls HIDE the instant a controller is active.
await record('ui-controller-hide', 'Buttons/joysticks HIDE when a controller is active', PHONE, async (page, name) => {
  await page.evaluate((v) => {
    const t = window.__mkTouch(document.getElementById('app'))
    window.__touch = t; t.update(v)
  }, viewSrc())
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, `${name}-01-touch-visible.png`) })
  shots.push(`${name}-01-touch-visible.png`)
  await page.evaluate(() => window.__touch.setVisible(false)) // gamepad joins
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(OUT, `${name}-02-hidden-under-pad.png`) })
  shots.push(`${name}-02-hidden-under-pad.png`)
  await page.evaluate(() => window.__touch.setVisible(true)) // pad leaves → back
  await page.waitForTimeout(400)
})

// (e): the restart affordance appears while the local player is DOWNED (not just
// at game-over), so a host/solo player can bail immediately.
await record('ui-restart-when-downed', 'Restart available the moment you are DOWNED (host/solo)', PHONE, async (page, name) => {
  await page.evaluate((v) => {
    const s = window.__mkScreens(document.getElementById('app'), () => { window.__restarted = true })
    window.__screens = s
    s.update(v) // alive first
  }, viewSrc())
  await page.waitForTimeout(200)
  await page.evaluate((v) => window.__screens.update(v), viewSrc({
    self: { id: 1, pos: { x: 5, y: 5 }, dead: false,
      playerCtl: { playerId: 0, activeSlot: 0, cash: 120, inventory: [],
        downed: { bleedTicks: 780, reviveProgress: 0 } } },
  }))
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, `${name}-01-downed-restart.png`) })
  shots.push(`${name}-01-downed-restart.png`)
})

// Copy every artifact to the share dir for the coordinator.
if (SHARE) {
  mkdirSync(SHARE, { recursive: true })
  for (const f of readdirSync(OUT)) {
    if (f.startsWith('ui-') && (f.endsWith('.png') || f.endsWith('.mp4'))) cpSync(join(OUT, f), join(SHARE, f))
  }
}
console.log('[ui-proof] screenshots:', shots.join(', '))
