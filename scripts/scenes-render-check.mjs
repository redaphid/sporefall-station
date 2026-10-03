#!/usr/bin/env node
// Open /scenes.html at a phone viewport, follow every card into its scene, and
// check each one actually renders: the world canvas is not one flat colour, the
// HUD is up, and `window.world` holds that scene's map and cast. Writes a PNG
// per scene (landscape, as the game is played) plus the gallery (portrait and
// landscape), and report.json, to e2e/output/scenes/.
//
//   node scripts/scenes-render-check.mjs [--base http://localhost:4991] [--cdp http://localhost:9222]
//
// Headless Chromium on WSL has no working WebGL (the tab crashes or draws
// black), so point --cdp (or E2E_CDP) at a headed Chrome started with
// --remote-debugging-port. The check opens its own browser context there and
// closes it at the end; it never touches the browser's other tabs.
// Exit code 0 only when every scene passes.

import { chromium } from 'playwright'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const BASE = arg('base', process.env.BASE_URL ?? 'http://localhost:4991')
const CDP = arg('cdp', process.env.E2E_CDP)
const OUT = arg('out', join(ROOT, 'e2e/output/scenes'))
const SETTLE_TICKS = Number(arg('ticks', 120))
// The gallery is read upright; the game is played with the phone on its side.
const PORTRAIT = { width: 412, height: 915 }
const LANDSCAPE = { width: 915, height: 412 }

/** Thresholds for "the canvas shows a world": at least this share of pixels
 * differs clearly from the most common colour, and the luminance spread is wide
 * enough that it is not a flat fill or a faint gradient. */
const MIN_NON_BACKGROUND = 0.15
const MIN_LUMA_STDDEV = 12

const scenesOnDisk = readdirSync(join(ROOT, 'scripts/saves'))
  .filter((f) => f.endsWith('.mts') && f !== 'lib.mts')
  .map((f) => f.replace(/\.mts$/, ''))
  .sort()
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'src/game/__fixtures__', `${name}.json`), 'utf8'))

/** Decode a PNG in the page (no image library needed) and measure the region. */
const pixelStats = (page, png, rect) =>
  page.evaluate(
    async ({ b64, rect }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const sx = img.width / window.innerWidth
      const x = Math.max(0, Math.round(rect.x * sx))
      const y = Math.max(0, Math.round(rect.y * sx))
      const w = Math.min(img.width - x, Math.round(rect.width * sx))
      const h = Math.min(img.height - y, Math.round(rect.height * sx))
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d')
      ctx.drawImage(img, x, y, w, h, 0, 0, w, h)
      const d = ctx.getImageData(0, 0, w, h).data
      const hist = new Map()
      let sum = 0
      let sum2 = 0
      const n = w * h
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)
        hist.set(key, (hist.get(key) ?? 0) + 1)
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        sum += l
        sum2 += l * l
      }
      const mode = Math.max(...hist.values())
      const mean = sum / n
      return { nonBackground: 1 - mode / n, lumaStdDev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), meanLuma: mean }
    },
    { b64: png.toString('base64'), rect },
  )

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = CDP ? await chromium.connectOverCDP(CDP) : await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: PORTRAIT, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const report = { base: BASE, via: CDP ? `cdp ${CDP}` : 'headless chromium', gallery: {}, scenes: [] }
  try {
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    await page.goto(`${BASE}/scenes.html`)
    await page.waitForSelector('[data-scene]')
    const gallery = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-scene]')]
      return {
        names: cards.map((a) => a.dataset.scene),
        hrefs: cards.map((a) => a.getAttribute('href')),
        minCardHeight: Math.min(...cards.map((a) => a.getBoundingClientRect().height)),
        minCardWidth: Math.min(...cards.map((a) => a.getBoundingClientRect().width)),
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      }
    })
    await page.screenshot({ path: join(OUT, '00-gallery.png'), fullPage: true })
    await page.screenshot({ path: join(OUT, '00-gallery-fold.png') })
    await page.setViewportSize(LANDSCAPE)
    const landscapeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    await page.screenshot({ path: join(OUT, '00-gallery-landscape.png') })
    gallery.horizontalOverflow = Math.max(gallery.horizontalOverflow, landscapeOverflow)
    report.gallery = {
      ...gallery,
      ok:
        JSON.stringify([...gallery.names].sort()) === JSON.stringify(scenesOnDisk) &&
        gallery.minCardHeight >= 48 &&
        gallery.horizontalOverflow <= 0,
    }
    console.log(`gallery: ${gallery.names.length} cards, min tap height ${gallery.minCardHeight.toFixed(0)}px, overflow ${gallery.horizontalOverflow}px -> ${report.gallery.ok ? 'ok' : 'FAIL'}`)

    for (const [i, name] of gallery.names.entries()) {
      await page.goto(`${BASE}/scenes.html`)
      await page.waitForSelector(`[data-scene="${name}"]`)
      // Follow the card the way a thumb does. The game page's module blocks
      // DOMContentLoaded on some paths, so wait for the commit, not the load.
      await Promise.all([page.waitForURL(`**/?world=${name}`, { waitUntil: 'commit' }), page.tap(`[data-scene="${name}"]`)])
      const booted = await page
        .waitForFunction((t) => (window.world?.tick ?? 0) >= t, SETTLE_TICKS, { timeout: 30000 })
        .then(() => true)
        .catch(() => false)
      const fx = fixture(name)
      const live = await page.evaluate(() => {
        const w = window.world
        if (!w) return null
        const player = w.entities.find((e) => e.playerCtl)
        const canvas = document.querySelector('#app canvas')
        const r = canvas?.getBoundingClientRect()
        return {
          tick: w.tick,
          floor: w.floor,
          levelW: w.level.w,
          levelH: w.level.h,
          player: player ? { x: player.pos.x, y: player.pos.y, hp: player.health?.hp } : null,
          archetypes: [...new Set(w.entities.filter((e) => e.kind === 'npc').map((e) => e.archetype))],
          liveNpcs: w.entities.filter((e) => e.kind === 'npc' && !e.dead).length,
          hud: !!document.querySelector('#hp') && (document.querySelector('#info')?.textContent ?? '').trim().length > 0,
          bootError: document.querySelector('[data-role=boot-error]')?.textContent ?? null,
          hidden: document.hidden,
          canvas: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        }
      })
      const png = await page.screenshot({ path: join(OUT, `${String(i + 1).padStart(2, '0')}-${name}.png`) })
      const stats = live?.canvas ? await pixelStats(page, png, live.canvas) : null
      const wantArch = [...new Set(fx.entities.filter((e) => e.kind === 'npc').map((e) => e.archetype))]
      const checks = {
        booted,
        noBootError: live?.bootError === null,
        visible: live?.hidden === false,
        sceneLevel: live?.floor === fx.floor && live?.levelW === fx.level.rows[0].length && live?.levelH === fx.level.rows.length,
        player: !!live?.player,
        cast: wantArch.every((a) => live?.archetypes.includes(a)) && (live?.liveNpcs ?? 0) > 0,
        hud: !!live?.hud,
        rendered: !!stats && stats.nonBackground >= MIN_NON_BACKGROUND && stats.lumaStdDev >= MIN_LUMA_STDDEV,
      }
      const ok = Object.values(checks).every(Boolean)
      report.scenes.push({ name, ok, checks, stats, live })
      const fails = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
      console.log(
        `${name}: ${ok ? 'ok' : `FAIL (${fails.join(', ')})`} tick=${live?.tick} npcs=${live?.liveNpcs}` +
          (stats ? ` nonBg=${stats.nonBackground.toFixed(2)} lumaSd=${stats.lumaStdDev.toFixed(1)}` : ''),
      )
    }
    // A name no build carries must stop at a visible error, never a fresh run.
    await page.goto(`${BASE}/?world=no-such-scene`, { waitUntil: 'commit' })
    const unknown = await page
      .waitForSelector('[data-role=boot-error]', { timeout: 30000 })
      .then((el) => el.textContent())
      .catch(() => null)
    const ranAnyway = await page.evaluate(() => (window.world?.tick ?? 0) > 0)
    await page.screenshot({ path: join(OUT, '99-unknown-world.png') })
    report.unknownWorld = { message: unknown, ranAnyway, ok: !!unknown?.includes('"no-such-scene"') && !ranAnyway }
    console.log(`unknown ?world=: ${report.unknownWorld.ok ? 'ok' : 'FAIL'} ${JSON.stringify(unknown?.slice(0, 80))}`)
    report.pageErrors = pageErrors
  } finally {
    await context.close()
    if (!CDP) await browser.close()
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  const allOk = report.gallery.ok && report.unknownWorld?.ok && report.scenes.length === scenesOnDisk.length && report.scenes.every((s) => s.ok)
  console.log(`${allOk ? 'PASS' : 'FAIL'}: ${report.scenes.filter((s) => s.ok).length}/${scenesOnDisk.length} scenes; ${join(OUT, 'report.json')}`)
  process.exit(allOk ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
