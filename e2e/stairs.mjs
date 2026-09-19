// STAIRS — Phase 1 (docs/design/stairs-and-storeys.md): walk up the stair into
// the loft, smash the cache crate, walk back down. Real build, real input, a
// video and labelled stills.
//
// Asserts, in a real browser:
//   1. `?scenario=stairs-demo` lands the player at the ground stair (storey 0)
//   2. walking forward climbs: the player's x jumps into the loft slot (x >= 80)
//   3. holding forward after arriving does not bounce back down
//   4. the loft holds the cache crate and no NPC; the player shoots the crate open
//   5. walking into the upper stair descends to the ground (the walk back over
//      is shortcut by placing the player 3 tiles out, clear of the stair lock)
//
// Run: ./e2e/run-stairs.sh   (or BASE_URL=… node e2e/stairs.mjs against a preview)
// STAIRS_NO_GPU=1 launches Chromium without a GPU (WSL headless dies creating
// one); the sim assertions hold, but the stills/video then show no world.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { muxVideo } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4979'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SEED = Number(process.env.STAIRS_SEED ?? 1)
const FLOOR = Number(process.env.STAIRS_FLOOR ?? 3)
const URL = `/?mode=solo&seed=${SEED}&scenario=stairs-demo&floor=${FLOOR}&e2e`

const failures = []
const fail = (m) => (console.error(`  FAIL — ${m}`), failures.push(m))
const check = (cond, m) => (cond ? console.log(`  ok — ${m}`) : fail(m))

mkdirSync(OUT, { recursive: true })
const videoDir = join(OUT, 'stairs-video')
const browser = await chromium.launch(process.env.STAIRS_NO_GPU ? { args: ['--disable-gpu', '--disable-software-rasterizer'] } : { headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => logs.push(m.text()))
page.on('pageerror', (e) => { logs.push(`pageerror: ${e.message}`); console.log('  ! pageerror', e.message, (e.stack ?? '').split('\n').slice(0, 6).join(' / ')) })

const state = () =>
  page.evaluate(() => {
    const w = window.__world
    if (!w) return null
    const p = w.entities.find((e) => e.playerCtl)
    const up = w.level.stairs?.find((l) => l.from.x < 80)
    return {
      floor: w.floor,
      x: p?.pos.x,
      y: p?.pos.y,
      up,
      loftCrates: w.entities.filter((e) => e.archetype === 'crate' && !e.dead && e.pos.x >= 80).length,
      loftNpcs: w.entities.filter((e) => e.kind === 'npc' && e.pos.x >= 80).length,
      tick: w.tick,
    }
  })

const KEY = { n: 'KeyW', s: 'KeyS', e: 'KeyD', w: 'KeyA' }
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' }
const hold = async (key, ms) => {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
}
const waitFor = async (pred, ms = 6000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await state()
    if (s && pred(s)) return s
    await page.waitForTimeout(50)
  }
  return state()
}
const shot = (label) => page.screenshot({ path: join(OUT, `stairs-${label}.png`) })

await page.goto(BASE + URL, { waitUntil: 'domcontentloaded' })
let s = await waitFor((st) => st.floor === FLOOR && st.up)
console.log('  · landed')
check(s?.floor === FLOOR, `landed on floor ${FLOOR}`)
check(s?.up !== undefined, 'the floor has a stair')
check(s && s.x < 64, `starts on the ground storey (x=${s?.x?.toFixed(2)})`)
await page.waitForTimeout(600)
await shot('1-ground-at-stair')

// The stair is behind the niche opposite its open side: walk against `dir`.
const toward = KEY[OPP[s.up.dir]]
const away = KEY[s.up.dir]
await page.keyboard.down(toward)
s = await waitFor((st) => st.x >= 80, 5000)
await page.keyboard.up(toward)
console.log('  · climbed')
check(s && s.x >= 80, `climbed into the loft (x=${s?.x?.toFixed(2)})`)
check(s?.loftCrates === 1, `the loft holds its cache crate (${s?.loftCrates})`)
check(s?.loftNpcs === 0, `no NPC upstairs (${s?.loftNpcs})`)
await page.waitForTimeout(400)
await shot('2-loft-arrived')

// Held input must not bounce us back down.
await hold(toward, 1200)
s = await state()
check(s && s.x >= 80, 'holding forward on arrival does not ping-pong')

// Look around the loft and smash the crate (fire toward it with the gun).
const crate = await page.evaluate(() => {
  const c = window.__world.entities.find((e) => e.archetype === 'crate' && e.pos.x >= 80)
  return c ? { x: c.pos.x, y: c.pos.y } : null
})
if (crate) {
  // Step out of the shaft, then walk-and-fire at the crate (aim follows the
  // move direction with no mouse): along the dominant axis toward it.
  await hold(away, 900)
  // Line up on the crate's column (or row), step back to range, then face it
  // and hold fire.
  const me0 = await state()
  const alongX = Math.abs(crate.x - me0.x) < Math.abs(crate.y - me0.y)
  for (let i = 0; i < 20; i++) {
    const me = await state()
    const off = alongX ? crate.x - me.x : crate.y - me.y
    if (Math.abs(off) < 0.25) break
    await hold(alongX ? (off > 0 ? 'KeyD' : 'KeyA') : off > 0 ? 'KeyS' : 'KeyW', Math.min(300, Math.abs(off) * 200))
  }
  const me = await state()
  const face = alongX ? (crate.y > me.y ? 'KeyS' : 'KeyW') : crate.x > me.x ? 'KeyD' : 'KeyA'
  await hold(face, 60)
  await page.keyboard.down('Space')
  for (let i = 0; i < 30 && (await state()).loftCrates > 0; i++) await page.waitForTimeout(100)
  await page.keyboard.up('Space')
  const after = await state()
  console.log(`  · fired from ${me.x.toFixed(2)},${me.y.toFixed(2)} at crate ${crate.x},${crate.y}; crates left ${after.loftCrates}`)
  await shot('3-loft-cache')
}
s = await state()
check(s?.loftCrates === 0, `the cache crate was smashed (${s?.loftCrates} left)`)

// Back down: go to the loft landing and walk into the upper stair.
await page.evaluate(() => {
  const w = window.__world
  const p = w.entities.find((e) => e.playerCtl)
  const down = w.level.stairs.find((l) => l.from.x >= 80)
  const d = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[down.dir]
  // Two tiles out from the stair, lock clear — the stand-in for "walk back over".
  p.pos = { x: down.from.x + 3 * d[0] + 0.5, y: down.from.y + 3 * d[1] + 0.5 }
  p.prevPos = { ...p.pos }
})
const before = await state()
await page.keyboard.down(toward)
s = await waitFor((st) => st.x < 64, 6000)
await page.keyboard.up(toward)
check(s && s.x < 64, `walked back down to the ground (x=${s?.x?.toFixed(2)}, from ${before?.x?.toFixed(2)})`)
await page.waitForTimeout(500)
await shot('4-back-on-ground')

// Without a GPU (STAIRS_NO_GPU — WSL headless can't create one) the renderer
// has no WebGL: the backbuffer logs its handled fall-back, and pixi's filter
// pipe throws `updateRenderable` of undefined. Both reproduce on the live main
// build under the same launch flags (checked 2026-09-18), so they are exempt
// in that mode only.
const noGpuNoise = (l) =>
  process.env.STAIRS_NO_GPU && (l.startsWith('[backbuffer] render failed') || /reading 'updateRenderable'/.test(l))
const errors = logs.filter((l) => /pageerror|Uncaught|TypeError/.test(l) && !noGpuNoise(l))
check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`)

await ctx.close()
await browser.close()
const { mp4, bytes } = muxVideo('stairs', videoDir)
console.log(`video: ${mp4} (${bytes} bytes)`)
if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nstairs e2e: all green')
