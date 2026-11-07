// Capture a playable scenario's card screenshot: boot `?play=<id>&demo` in a
// headless Chromium against the built game, let the scenario's own demo bot
// drive the real sim up to its `shot.tick` (held there exactly: the sim is
// gated tick by tick), zoom the camera, and save public/playable/<id>.webp.
//
//   pnpm run build
//   node scripts/playable/capture.mjs <id> [<id> ...] [--tick N] [--zoom Z]
//   node scripts/playable/capture.mjs --all
//
// --tick/--zoom override the entry's `shot` for a try; put the value you keep
// into the entry. BASE_URL points at an already-served build; without it the
// script serves ./dist itself with `vite preview`. Also writes a 3x
// nearest-neighbour crop of the frame centre to e2e/output/playable/<id>-zoom.png
// for the by-eye check.
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer, preview } from 'vite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'public/playable')
const ZOOM_OUT = join(ROOT, 'e2e/output/playable')
const VIEW = { width: 800, height: 450 }

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args.splice(i, 2)[1]) : undefined
}
const tickOverride = flag('--tick')
const zoomOverride = flag('--zoom')
const all = args.includes('--all')
const ids = args.filter((a) => !a.startsWith('--'))

// The registry is TypeScript behind import.meta.glob: load it through Vite.
const loader = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true } })
const { PLAYABLES } = await loader.ssrLoadModule('/src/playable/registry.ts')
await loader.close()
const wanted = all ? PLAYABLES : ids.map((id) => PLAYABLES.find((p) => p.id === id) ?? (() => { throw new Error(`no playable "${id}"`) })())
if (wanted.length === 0) throw new Error('usage: capture.mjs <id> [...] [--tick N] [--zoom Z] | --all')

let server
let base = process.env.BASE_URL
if (!base) {
  server = await preview({ root: ROOT, preview: { port: 4317, strictPort: false }, logLevel: 'error' })
  base = server.resolvedUrls.local[0].replace(/\/$/, '')
}

mkdirSync(OUT, { recursive: true })
mkdirSync(ZOOM_OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
let failed = 0
for (const p of wanted) {
  const tick = tickOverride ?? p.shot.tick
  const zoom = zoomOverride ?? p.shot.zoom ?? 1
  const page = await browser.newPage({ viewport: VIEW })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  // Gate the sim from the instant the session is published: every tick past
  // `hold` is refused, so the world stops exactly on the shot tick.
  await page.addInitScript((hold) => {
    let session
    Object.defineProperty(window, '__sporefall', {
      configurable: true,
      get: () => session,
      set: (s) => {
        session = s
        const orig = s.tick.bind(s)
        s.tick = (...a) => (s.world.tick >= hold ? undefined : orig(...a))
      },
    })
  }, tick)
  await page.goto(`${base}/?play=${encodeURIComponent(p.id)}&demo&e2e=1`, { waitUntil: 'networkidle' })
  try {
    await page.waitForFunction((t) => window.__world?.tick === t, tick, { timeout: 60000 })
    await page.evaluate((z) => window.__zoom?.(z, true), zoom)
    await page.waitForTimeout(600) // camera settles, sprites bake
    const png = await page.screenshot()
    // Encode in the page: Chromium writes webp, no image tooling needed here.
    const webp = await page.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      c.getContext('2d').drawImage(img, 0, 0)
      const zoomed = document.createElement('canvas')
      const cw = 220
      const ch = 124
      zoomed.width = cw * 3
      zoomed.height = ch * 3
      const zc = zoomed.getContext('2d')
      zc.imageSmoothingEnabled = false
      zc.drawImage(c, (img.width - cw) / 2, (img.height - ch) / 2, cw, ch, 0, 0, cw * 3, ch * 3)
      return { webp: c.toDataURL('image/webp', 0.78).split(',')[1], zoom: zoomed.toDataURL('image/png').split(',')[1] }
    }, png.toString('base64'))
    const file = join(OUT, `${p.id}.webp`)
    writeFileSync(file, Buffer.from(webp.webp, 'base64'))
    writeFileSync(join(ZOOM_OUT, `${p.id}-zoom.png`), Buffer.from(webp.zoom, 'base64'))
    console.log(`${p.id}: tick ${tick} zoom ${zoom} -> ${file} (${(statSync(file).size / 1024).toFixed(0)} KB)`)
  } catch (e) {
    failed++
    console.error(`${p.id}: FAILED ${e.message}`)
  }
  if (errs.length) {
    failed++
    console.error(`${p.id}: page errors: ${errs.join(' | ')}`)
  }
  await page.close()
}
await browser.close()
await server?.close()
process.exitCode = failed ? 1 : 0
