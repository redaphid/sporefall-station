// End-to-end proof for shareable debug-state links (`?state=<id>`).
//
// Deliberately not a unit test: it drives the REAL game in a REAL browser
// against the REAL Worker, because the claim being checked ("a friend opening
// this link sees exactly what I saw, and it keeps behaving the same") is a claim
// about a whole system, not a function.
//
//   A. Play solo, capture a state, upload it (real CompressionStream + fetch).
//   B. Open the link in a FRESH browser context — new profile, cold cache,
//      nothing shared with A — and confirm the replay reconverges EXACTLY on the
//      captured frame.
//   C. Open it in a SECOND fresh context and confirm the two restores stay
//      byte-identical as they run on. A state that loads and then drifts is the
//      failure mode this whole feature exists to prevent.
//   D. Prove the check can fail: corrupt one field of a stored payload, load it,
//      and confirm the tool goes RED and names what broke.
//
// Usage: node e2e/state-link-roundtrip.mjs [origin]
import { chromium } from 'playwright'

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:8787'
const SEED = 20260817
const FORWARD_TICKS = 120

const ok = (m) => console.log(`  PASS  ${m}`)
const fail = (m) => {
  console.error(`  FAIL  ${m}`)
  process.exitCode = 1
}

const snapshot = (page) => page.evaluate(() => JSON.parse(window.sporefall.serialize()))

/**
 * First differing path between two snapshots, mirroring `firstDifference` in
 * src/debug/stateLink.ts. Used instead of comparing JSON strings because that
 * is sensitive to KEY ORDER and to absent-vs-undefined — neither of which the
 * sim can tell apart, so both would be false alarms. It also means a failure
 * names the field instead of dumping 80 KiB of JSON.
 */
const firstDiff = (a, b, path = '') => {
  if (a === b) return null
  const both = typeof a === 'object' && typeof b === 'object' && a !== null && b !== null
  if (!both) return a === undefined && b === undefined ? null : { path: path || '<root>', a, b }
  if (Array.isArray(a) !== Array.isArray(b)) return { path: path || '<root>', a: typeof a, b: typeof b }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k)
    if (d) return d
  }
  return null
}

const describeDiff = (d) => `${d.path}: ${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)}`

const worldAtTick = (page, tick) =>
  page
    .waitForFunction((t) => window.world && window.world.tick >= t, tick, { timeout: 30000 })
    .then(() => snapshot(page))

const boot = async (browser, url) => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return { ctx, page, errors }
}

/** Wait for a `?state=` load to finish replaying and publish its verdict. */
const landing = async (page) => {
  await page.waitForFunction(() => window.__stateReplay, null, { timeout: 30000 })
  return page.evaluate(() => window.__stateReplay)
}

const main = async () => {
  const browser = await chromium.launch()

  // ── A. play, then capture ────────────────────────────────────────────────
  const a = await boot(browser, `${ORIGIN}/?mode=solo&seed=${SEED}&debug`)
  await a.page.waitForFunction(() => typeof window.sporefallShare === 'function', null, { timeout: 30000 })
  // Let the ring fill past a full rotation so the capture carries real run-up.
  await worldAtTick(a.page, 90)

  const share = await a.page.evaluate(() => window.sporefallShare('e2e round trip'))
  console.log(`\ncapture: ${share.id}`)

  // Ground truth = exactly what the server stored.
  const res = await fetch(`${ORIGIN}/state/${share.id}`)
  const ctype = res.headers.get('content-type') ?? ''
  ctype.includes('application/json')
    ? ok(`stored payload served as JSON (${ctype})`)
    : fail(`stored payload served as "${ctype}" — SPA fallback?`)
  const payload = await res.json()
  const truth = payload.world
  const capturedTick = truth.tick

  const kib = (n) => (n / 1024).toFixed(1)
  const worldBytes = JSON.stringify(payload.world).length
  const rewindBytes = payload.rewind ? JSON.stringify(payload.rewind).length : 0
  const inputLogBytes = payload.rewind ? JSON.stringify(payload.rewind.frames).length : 0
  console.log(
    `  sizes: world snapshot ${kib(worldBytes)} KiB` +
      ` | rewind start-world ${kib(rewindBytes - inputLogBytes)} KiB` +
      ` | input log ${kib(inputLogBytes)} KiB (${payload.rewind ? payload.rewind.frames.length : 0} ticks)` +
      ` | TOTAL ${kib(share.rawBytes)} KiB raw -> ${kib(share.bytes)} KiB gzip uploaded`,
  )
  payload.rewind ? ok(`link carries ${payload.rewind.frames.length} ticks of run-up`) : fail('no rewind recorded')

  // ── B. fresh browser context opens the link ──────────────────────────────
  const b = await boot(browser, `${ORIGIN}/?state=${share.id}`)
  await b.page.waitForSelector('[data-role="state-replay-banner"]', { timeout: 30000 })
  const during = await b.page.textContent('[data-role="state-replay-banner"]')
  during.includes('REPLAY') ? ok('replay is announced on screen while it runs') : fail(`no replay banner: ${during}`)

  const land = await landing(b.page)
  const after = await b.page.textContent('[data-role="state-replay-banner"]')
  land.ok ? ok(`app self-check: reconverged at tick ${land.tick}`) : fail(`app self-check: ${land.reason}`)
  after.includes('LIVE') ? ok(`banner hands over control: "${after.split('\n')[0]}"`) : fail(`banner: ${after}`)

  // The world the replay LANDED ON must be the captured frame, field for field.
  // Read from __stateReplay, not a later poll: the game resumes ticking the
  // instant control is handed back, so a poll a few frames later legitimately
  // shows a later tick and would fail for the wrong reason.
  const restored = land.world
  const landDiff = firstDiff(restored, truth)
  landDiff
    ? fail(`restored world differs from the capture at ${describeDiff(landDiff)}`)
    : ok('restored world matches the captured frame field-for-field')
  restored.tick === capturedTick ? ok(`tick matches (${capturedTick})`) : fail(`tick ${restored.tick} vs ${capturedTick}`)
  restored.entities.length === truth.entities.length
    ? ok(`entity count matches (${truth.entities.length})`)
    : fail(`entities ${restored.entities.length} vs ${truth.entities.length}`)
  restored.floor === truth.floor ? ok(`floor matches (${truth.floor})`) : fail('floor differs')
  restored.rng === truth.rng ? ok(`RNG cursor matches (${truth.rng})`) : fail(`rng ${restored.rng} vs ${truth.rng}`)
  const hp = (w) =>
    w.entities
      .filter((e) => e.health)
      .map((e) => `${e.id}:${e.health.hp}`)
      .join(',')
  hp(restored) === hp(truth) ? ok('every entity hp matches') : fail('hp differs')
  const pos = (w) => w.entities.map((e) => `${e.id}@${e.pos.x.toFixed(6)},${e.pos.y.toFixed(6)}`).join(' ')
  pos(restored) === pos(truth) ? ok('every entity position matches') : fail('positions differ')

  // ── C. two independent restores must stay identical as they run on ───────
  // Comparing against context A would be racy (A never stopped playing and is
  // now hundreds of ticks ahead). Two fresh contexts from the SAME link is the
  // question that actually matters: do two machines stay in lockstep?
  const c = await boot(browser, `${ORIGIN}/?state=${share.id}`)
  const cLand = await landing(c.page)
  const cDiff = firstDiff(cLand.world, truth)
  cDiff
    ? fail(`second browser landed elsewhere: ${describeDiff(cDiff)}`)
    : ok('a second independent browser lands on the identical frame')

  // B and C were opened seconds apart, so at any wall-clock instant they sit at
  // different ticks and would never coincide if sampled simultaneously. Collect
  // tick -> snapshot from each independently, then compare at a tick they BOTH
  // visited. That compares the same simulated moment on two separate machines,
  // which is the actual claim.
  const sameTick = async (p1, p2, minTick) => {
    const seen = [new Map(), new Map()]
    for (let i = 0; i < 120; i++) {
      const shots = await Promise.all([snapshot(p1), snapshot(p2)])
      shots.forEach((s, n) => seen[n].set(s.tick, s))
      const common = [...seen[0].keys()].filter((t) => t >= minTick && seen[1].has(t)).sort((x, y) => y - x)
      if (common.length) return [seen[0].get(common[0]), seen[1].get(common[0])]
      await new Promise((r) => setTimeout(r, 25))
    }
    return null
  }
  const pair = await sameTick(b.page, c.page, capturedTick + FORWARD_TICKS)
  if (!pair) fail('could not sample both restores at a common tick')
  else {
    const d = firstDiff(pair[0], pair[1])
    d
      ? fail(`restores diverged by tick ${pair[0].tick} at ${describeDiff(d)}`)
      : ok(`two restores STILL identical ${pair[0].tick - capturedTick} ticks past the capture (tick ${pair[0].tick})`)
  }

  // ── D. prove the check can fail ──────────────────────────────────────────
  // Re-upload the SAME capture with ONE sabotaged field: the RNG cursor of the
  // world the replay starts from. Everything still looks right on screen; the
  // replay must refuse to reconverge and say so.
  const sabotaged = JSON.parse(JSON.stringify(payload))
  sabotaged.rewind.world.rng += 1
  const gz = await new Response(
    new Blob([JSON.stringify(sabotaged)]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer()
  const up = await fetch(`${ORIGIN}/state`, { method: 'POST', body: gz })
  const { id: badId } = await up.json()

  const d = await boot(browser, `${ORIGIN}/?state=${badId}`)
  const dLand = await landing(d.page)
  const badBanner = await d.page.textContent('[data-role="state-replay-banner"]')
  !dLand.ok && badBanner.includes('DIVERGED')
    ? ok(`negative control went RED: ${dLand.difference.path} expected ${dLand.difference.expected}, got ${dLand.difference.actual}`)
    : fail(`negative control stayed GREEN — the check cannot fail! banner: ${badBanner}`)

  // A missing id must be a clean, explained failure, not a mystery.
  const miss = await fetch(`${ORIGIN}/state/zzzzzzzzzzzzzzzz`)
  miss.status === 404 && (miss.headers.get('content-type') ?? '').includes('text/plain')
    ? ok('unknown id -> real 404 text/plain (never the SPA shell)')
    : fail(`unknown id -> ${miss.status} ${miss.headers.get('content-type')}`)

  for (const [name, ctx] of [
    ['A', a],
    ['B', b],
    ['C', c],
    ['D', d],
  ])
    if (ctx.errors.length) console.log(`  note: context ${name} console errors: ${ctx.errors.slice(0, 2).join(' | ')}`)

  await browser.close()
  console.log(process.exitCode ? '\nROUND TRIP: FAILED\n' : '\nROUND TRIP: ALL CHECKS PASSED\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
