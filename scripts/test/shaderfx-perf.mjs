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

// HARDWARE GL IS MANDATORY for this to mean anything. Playwright's default
// headless Chromium falls back to SwiftShader (a CPU rasterizer): every mode
// then runs at ~8fps and the full-vs-off delta measures software rasterization
// of a full-screen fragment shader — a number with no bearing on a phone GPU.
// `--use-gl=angle --use-angle=gl` binds the real device (verified by the
// UNMASKED_RENDERER printed below; the run FAILS if it reads SwiftShader).
//
// CRITICAL: exactly ONE page is alive at a time. Headless Chromium throttles
// requestAnimationFrame in every non-foreground page to ~1Hz, and
// `bringToFront()` does NOT lift it — keeping three pages open and switching
// between them silently measures the throttler instead of the pipeline (it
// turns a ~90s run into a ~30min one). Sampling stays INTERLEAVED in rounds
// so background load on a shared box drifts across all three modes equally;
// each round just boots the page it needs and closes it again.
// PERF_UNCAP=1 additionally releases the 60Hz vsync cap. Capped, every mode
// reports ~16.7ms and the only question answered is "does it hold 60fps?";
// uncapped, rAF free-runs and the per-frame delta is the pipeline's ACTUAL
// cost — the number that says how much headroom a slower GPU would keep.
// (Both keep hardware GL; uncapping does not force the software fallback.)
const UNCAP = process.env.PERF_UNCAP === '1'
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=gl',
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(UNCAP ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ],
})

const MODES = ['full', 'reduced', 'off']
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 3)

const sample = async (fx, n) => {
  const ctx = await browser.newContext({ viewport: VIEW })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/?mode=solo&e2e=1&seed=42&scenario=showcase&fx=${fx}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => (window.__world?.tick ?? 0) > 30, null, { timeout: 120000 })
  const deltas = await page.evaluate(
    (count) =>
      new Promise((res) => {
        const out = []
        let last = performance.now()
        const loop = () => {
          const now = performance.now()
          out.push(now - last)
          last = now
          if (out.length >= count) return res(out)
          requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      }),
    n,
  )
  const fxState = await page.evaluate(() => {
    const gl =
      document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
    return { ...window.__fx, gl: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl ? 'masked' : 'none' }
  })
  await ctx.close()
  return { deltas, fxState }
}

const deltasByMode = Object.fromEntries(MODES.map((m) => [m, []]))
const fxByMode = {}
const perRound = Math.ceil(FRAMES / ROUNDS)
for (let round = 0; round < ROUNDS; round++) {
  for (const fx of MODES) {
    const { deltas, fxState } = await sample(fx, perRound)
    deltasByMode[fx].push(...deltas)
    fxByMode[fx] = fxState // identical every round; last one wins
  }
}
await browser.close()

const results = Object.fromEntries(MODES.map((fx) => [fx, { ...stats(deltasByMode[fx]), fx: fxByMode[fx] }]))

let failed = false
console.log(`gl renderer: ${results.full.fx.gl}`)
console.log(`vsync: ${UNCAP ? 'UNCAPPED (deltas = real per-frame cost)' : 'capped at 60Hz (deltas ≈ 16.7ms by construction)'}`)
// Guard the measurement itself: a SwiftShader/software renderer makes every
// number below meaningless as a GPU proxy, so refuse to report it as one.
if (/swiftshader|software/i.test(String(results.full.fx.gl))) {
  console.error('FAIL: software rasterizer — these timings are not a GPU measurement. Fix the GL flags.')
  failed = true
}
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
