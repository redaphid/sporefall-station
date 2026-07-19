// Headless frame-time comparison for the backbuffer shader-FX pipeline.
// Boots the showcase scenario (fires + grenades + a crowd — a busy frame) at a
// phone viewport, uncaps vsync, samples 600 requestAnimationFrame deltas per
// mode (full / reduced / off), and reports mean/median/p95.
//
// Assumption documented for the report: headless desktop GL is NOT a phone GPU
// — absolute numbers only bound the CPU+driver cost; the relative on/off delta
// is the signal. Fill-rate on a phone is mitigated separately by the pipeline's
// resolution scale (0.75x logical, under the DPR<=2 canvas).
//
// Serve first (any port):  BASE_URL=http://localhost:4972 node scripts/test/shaderfx-perf.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const FRAMES = Number(process.env.PERF_FRAMES ?? 600)
const VIEW = { width: 412, height: 915 } // phone-ish portrait

const stats = (deltas) => {
  const s = [...deltas].sort((a, b) => a - b)
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  // p10 approximates the uncontended cost on a loaded shared box: frames that
  // dodged the scheduler show what the pipeline itself costs.
  return { mean, p10: pick(0.1), median: pick(0.5), p95: pick(0.95), n: s.length }
}

// Default launch: on this box that keeps HARDWARE WebGL (the vsync-uncapping
// flags force a SwiftShader fallback, which measures the CPU rasterizer, not
// the pipeline). rAF is then vsync-capped — the signal is whether each mode
// HOLDS the 60Hz budget (median ~16.7ms, low p95), not raw throughput.
const browser = await chromium.launch({ headless: true })

// One live page per mode; sampling INTERLEAVED in rounds so background load
// (a shared dev box) drifts across all three modes equally instead of biasing
// whichever mode ran last.
const MODES = ['full', 'reduced', 'off']
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3)
const pages = {}
for (const fx of MODES) {
  const ctx = await browser.newContext({ viewport: VIEW })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/?mode=solo&e2e=1&seed=42&scenario=showcase&fx=${fx}`, { waitUntil: 'networkidle' })
  await page.bringToFront()
  await page.waitForFunction(() => (window.__world?.tick ?? 0) > 30, null, { timeout: 120000 })
  pages[fx] = page
}

const deltasByMode = Object.fromEntries(MODES.map((m) => [m, []]))
for (let round = 0; round < ROUNDS; round++) {
  for (const fx of MODES) {
    await pages[fx].bringToFront() // backgrounded pages get throttled rAF
    const chunk = await pages[fx].evaluate(
      (n) =>
        new Promise((res) => {
          const out = []
          let last = performance.now()
          const loop = () => {
            const now = performance.now()
            out.push(now - last)
            last = now
            if (out.length >= n) return res(out)
            requestAnimationFrame(loop)
          }
          requestAnimationFrame(loop)
        }),
      Math.ceil(FRAMES / ROUNDS),
    )
    deltasByMode[fx].push(...chunk)
  }
}

const results = {}
for (const fx of MODES) {
  const fxState = await pages[fx].evaluate(() => {
    const gl =
      document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
    return { ...window.__fx, gl: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl ? 'masked' : 'none' }
  })
  results[fx] = { ...stats(deltasByMode[fx]), fx: fxState }
  await pages[fx].context().close()
}
await browser.close()

let failed = false
console.log(`gl renderer: ${results.full.fx.gl}`)
for (const [fx, r] of Object.entries(results)) {
  console.log(
    `fx=${fx.padEnd(7)} mean=${r.mean.toFixed(2)}ms p10=${r.p10.toFixed(2)}ms median=${r.median.toFixed(2)}ms ` +
      `p95=${r.p95.toFixed(2)}ms (n=${r.n}) [mode=${r.fx.mode} active=${r.fx.active} failed=${r.fx.failed}]`,
  )
  // The HARD gate is correctness: the pipeline must be live and unfailed.
  if (r.fx.failed) failed = true
  if ((fx === 'off') === r.fx.active) failed = true
}
// Perf verdict is ADVISORY on a shared/loaded box (means are scheduler noise);
// p10 of the delta is the closest headless proxy for the pipeline's own cost.
const meanDelta = results.full.mean - results.off.mean
const p10Delta = results.full.p10 - results.off.p10
console.log(`full-vs-off delta: mean=${meanDelta.toFixed(2)}ms p10=${p10Delta.toFixed(2)}ms per frame`)
if (p10Delta > 4) console.warn(`WARN: p10 delta ${p10Delta.toFixed(2)}ms exceeds the 4ms headless budget — investigate`)
process.exit(failed ? 1 : 0)
