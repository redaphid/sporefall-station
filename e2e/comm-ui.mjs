// End-to-end proof of the annotation + selection overlay (#51), rendered by the
// REAL pixi build. Loads the committed `comm-scene` world, draws EVERY annotation
// variety over real sprites via the real `annotate` verb path (window.__annotate),
// screenshots each kind AND a combined scene, then taps an entity to prove the
// player→selection path (highlight ring + inspect card + Entity.selected).
//
// It also enforces LEGIBILITY on every rendered annotation-text element: fully
// on-screen, not clipped, bounded width/line-count, backed/shadowed, ≥12px, and
// non-overlapping — the layout math that guarantees this is unit-tested in
// src/ui/annotationLayout.test.ts; here we assert it on the live DOM.
//
// Serves nothing itself — run via e2e/run-comm-ui.sh (build + preview + ffmpeg).

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

// Must match src/ui/annotationLayout.ts.
const MAX_LABEL_WIDTH = 240
const MAX_LABEL_LINES = 3
const LABEL_LINE_HEIGHT = 16
const MIN_FONT_PX = 12

const failures = []
const fail = (m) => (console.error(`FAIL: ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)

const run = async () => {
  mkdirSync(OUT, { recursive: true })
  const videoDir = join(OUT, 'video-comm-ui')
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
  const page = await context.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

  const url = `${BASE}/?${new URLSearchParams({ mode: 'solo', e2e: '1', world: 'comm-scene' })}`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__world && window.__project && window.__annotate)

  // Resolve the fixture entity ids by archetype so the test is position-stable.
  const ids = await page.evaluate(() => {
    const byArch = {}
    for (const e of window.__world.entities) (byArch[e.archetype] ??= []).push(e.id)
    return { cop: byArch.cop[0], thugA: byArch.thug[0], thugB: byArch.thug[1], gangster: byArch.gangster[0], pickup: byArch['pickup.grenade'][0] }
  })

  const annotate = (arr) => page.evaluate((json) => window.__annotate(json), JSON.stringify(arr))
  const clearAll = () => page.evaluate(() => window.__verb('clearAnnotations'))
  const settle = () => page.waitForTimeout(180)
  const shot = async (label) => {
    await page.screenshot({ path: join(OUT, `comm-${label}.png`) })
    return `comm-${label}.png`
  }
  const shots = []

  // ---- 1. per-kind screenshots (each variety proven unambiguously) ----------
  const perKind = {
    text: [{ kind: 'text', text: 'Claude: sweep this room left to right', color: '#ffd76a' }],
    label: [{ kind: 'label', targetId: ids.cop, text: 'Cop — lawful, hits back' }],
    pin: [{ kind: 'pin', targetId: ids.pickup, text: 'Grenade — grab it' }],
    arrow: [{ kind: 'arrow', x: 26, y: 6, x2: 20, y2: 11, text: 'go here', color: '#7fd17f' }],
    circle: [{ kind: 'circle', x: 20, y: 9, radius: 2.6, text: 'danger zone', color: '#ff6b6b' }],
  }
  for (const [kind, arr] of Object.entries(perKind)) {
    await clearAll()
    await annotate(arr)
    await settle()
    shots.push(await shot(`kind-${kind}`))
  }

  // ---- 2. the ALL-VARIETIES scene (every kind on screen at once, crowded) ----
  await clearAll()
  const scene = [
    { kind: 'text', text: 'Claude: sweep this room left to right', color: '#ffd76a' },
    { kind: 'label', targetId: ids.cop, text: 'Cop — lawful' },
    { kind: 'label', targetId: ids.thugA, text: 'Thug — hostile' },
    { kind: 'label', targetId: ids.thugB, text: 'Thug — flank' },
    { kind: 'label', targetId: ids.gangster, text: 'Gangster — pistol' },
    { kind: 'pin', targetId: ids.pickup, text: 'Grenade — grab it' },
    { kind: 'circle', x: 20, y: 9, radius: 2.6, text: 'danger zone', color: '#ff6b6b' },
    { kind: 'arrow', x: 26, y: 6, x2: 20, y2: 11, text: 'go here', color: '#7fd17f' },
  ]
  const added = await annotate(scene)
  await settle()
  shots.push(await shot('all-varieties'))

  // Assert every kind actually rendered a DOM element.
  const kinds = await page.evaluate(() => ({
    text: document.querySelectorAll('.annotation-text').length,
    pin: document.querySelectorAll('[data-shape^="pin:"]').length,
    circle: document.querySelectorAll('[data-shape^="circle:"]').length,
    arrow: document.querySelectorAll('[data-shape^="arrow:"]').length,
    entityLabels: document.querySelectorAll('.annotation-text[data-target]').length,
  }))
  if (JSON.parse(added).added !== scene.length) fail(`annotate added ${JSON.parse(added).added}, expected ${scene.length}`)
  else ok(`annotate verb added all ${scene.length}`)
  // text elements = banner + 4 entity labels + pin caption + circle caption + arrow caption = 8
  if (kinds.text < 8) fail(`expected ≥8 annotation-text elements, got ${kinds.text}`)
  else ok(`${kinds.text} text captions rendered`)
  for (const [k, n] of Object.entries({ pin: kinds.pin, circle: kinds.circle, arrow: kinds.arrow }))
    n >= 1 ? ok(`${k} shape rendered`) : fail(`${k} shape missing`)
  kinds.entityLabels >= 4 ? ok(`${kinds.entityLabels} entity-anchored labels`) : fail(`only ${kinds.entityLabels} entity labels`)

  // ---- 3. LEGIBILITY assertions on the live DOM (every text element) ----------
  const leg = await page.evaluate(
    (cfg) => {
      const els = [...document.querySelectorAll('.annotation-text')]
      const rects = els.map((el) => el.getBoundingClientRect())
      const vw = window.innerWidth
      const vh = window.innerHeight
      const problems = []
      const items = []
      els.forEach((el, i) => {
        const r = rects[i]
        const cs = getComputedStyle(el)
        const fontPx = parseFloat(cs.fontSize)
        const lineH = parseFloat(cs.lineHeight) || cfg.lineHeight
        const lines = Math.round(el.scrollHeight / lineH)
        const bg = cs.backgroundColor
        const hasBg = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)'
        const hasShadow = (cs.textShadow && cs.textShadow !== 'none') || (cs.webkitTextStrokeWidth && parseFloat(cs.webkitTextStrokeWidth) > 0)
        const t = el.textContent
        if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) problems.push(`offscreen: "${t}" (${r.left|0},${r.top|0},${r.right|0},${r.bottom|0})`)
        if (el.scrollWidth > el.clientWidth + 1) problems.push(`clipX: "${t}"`)
        if (el.scrollHeight > el.clientHeight + 1) problems.push(`clipY: "${t}"`)
        if (r.width > cfg.maxWidth + 1) problems.push(`tooWide ${Math.round(r.width)}px: "${t}"`)
        if (lines > cfg.maxLines) problems.push(`${lines} lines: "${t}"`)
        if (!hasBg && !hasShadow) problems.push(`illegible (no bg/shadow): "${t}"`)
        if (fontPx < cfg.minFont) problems.push(`font ${fontPx}px: "${t}"`)
        items.push({ t, w: Math.round(r.width), h: Math.round(r.height), lines, fontPx })
      })
      // No two text rects overlap by more than a few px.
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i]
          const b = rects[j]
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (ox > 3 && oy > 3) problems.push(`overlap: "${els[i].textContent}" ∩ "${els[j].textContent}" (${ox|0}×${oy|0}px)`)
        }
      // Entity-anchored labels must not cover their target sprite point.
      for (const el of els) {
        const tid = el.dataset.target
        if (!tid) continue
        const e = window.__world.entities.find((x) => x.id === Number(tid))
        if (!e) continue
        const p = window.__project(e.pos.x, e.pos.y)
        const r = el.getBoundingClientRect()
        if (p.x >= r.left - 2 && p.x <= r.right + 2 && p.y >= r.top - 2 && p.y <= r.bottom + 2)
          problems.push(`covers target ${tid}: "${el.textContent}"`)
      }
      return { count: els.length, items, problems }
    },
    { maxWidth: MAX_LABEL_WIDTH, maxLines: MAX_LABEL_LINES, lineHeight: LABEL_LINE_HEIGHT, minFont: MIN_FONT_PX },
  )
  console.log(`  legibility: ${leg.count} text elements`)
  for (const it of leg.items) console.log(`    "${it.t}" ${it.w}×${it.h}px, ${it.lines} line(s), ${it.fontPx}px`)
  if (leg.problems.length) for (const p of leg.problems) fail(`legibility — ${p}`)
  else ok('all annotation text is legible (on-screen, unclipped, bounded, backed, ≥12px, non-overlapping, off-target)')

  // ---- 4. selection: tap an entity → highlight + inspect card + Entity.selected
  const cop = await page.evaluate((id) => {
    const e = window.__world.entities.find((x) => x.id === id)
    return window.__project(e.pos.x, e.pos.y)
  }, ids.cop)
  await page.mouse.move(cop.x, cop.y)
  await page.mouse.down()
  await page.mouse.up()
  await settle()

  const sel = await page.evaluate((id) => {
    const e = window.__world.entities.find((x) => x.id === id)
    const card = document.querySelector('.inspect-card')
    const ring = document.querySelector('.selection-ring')
    return {
      selectedIds: window.__world.entities.filter((x) => x.selected).map((x) => x.id),
      targetSelected: !!(e && e.selected),
      cardVisible: !!card && card.getBoundingClientRect().width > 0,
      cardText: card ? card.textContent : '',
      ringPresent: !!ring,
    }
  }, ids.cop)
  shots.push(await shot('selection'))

  sel.targetSelected ? ok(`tapped entity ${ids.cop} is now selected`) : fail(`tap did not select entity ${ids.cop} (selected: ${sel.selectedIds})`)
  sel.cardVisible ? ok(`inspect card visible: ${JSON.stringify(sel.cardText)}`) : fail('inspect card not visible after tap')
  sel.ringPresent ? ok('selection highlight ring present') : fail('no selection ring after tap')

  // Tapping empty space clears the selection (dismiss).
  await page.mouse.click(20, 700)
  await settle()
  const cleared = await page.evaluate(() => window.__world.entities.filter((x) => x.selected).length)
  cleared === 0 ? ok('tap on empty space cleared the selection') : fail(`selection not cleared (${cleared} still selected)`)

  await page.close()
  await context.close()
  await browser.close()

  // ---- video: mux the recorded webm → mp4 and verify it is real -------------
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
  let mp4Bytes = 0
  if (webm) {
    const webmPath = join(OUT, 'comm-ui.webm')
    const mp4 = join(OUT, 'comm-ui.mp4')
    renameSync(join(videoDir, webm), webmPath)
    try {
      execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
        '-movflags', '+faststart', mp4], { stdio: 'ignore' })
      mp4Bytes = statSync(mp4).size
      if (SHARE) cpSync(mp4, join(SHARE, 'comm-ui.mp4'))
    } catch (e) {
      fail(`ffmpeg mux failed: ${e.message}`)
    }
    rmSync(webmPath, { force: true })
  } else fail('no webm recorded')
  rmSync(videoDir, { recursive: true, force: true })

  if (errs.length) for (const e of errs) fail(`page error: ${e}`)

  // Copy the stills for the coordinator to retrieve.
  if (SHARE) {
    mkdirSync(SHARE, { recursive: true })
    for (const s of shots) cpSync(join(OUT, s), join(SHARE, s))
  }

  console.log(`\n[comm-ui] ${shots.length} screenshots, video ${(mp4Bytes / 1024).toFixed(0)} KB`)
  for (const s of shots) console.log(`  ${s} (${statSync(join(OUT, s)).size} bytes)`)
  if (failures.length) {
    console.error(`\n[comm-ui] ${failures.length} FAILURE(S)`)
    process.exitCode = 1
  } else console.log('\n[comm-ui] OK — all assertions passed')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
