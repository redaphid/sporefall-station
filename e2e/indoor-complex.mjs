// Indoor complex (floors 3+) visual evidence: loads exact-world snapshots
// (scripts/test/gen-indoor-tour.mts) into the live build via __loadWorld and
// captures each biome close-up and zoomed out, then lets the director scene
// RUN so its vent swarm + lights-out fire on camera. Asserts the loaded worlds
// really are complex floors with the right biome, the director fired its
// events, and nothing errored. Records one continuous video alongside.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const FIXTURES = process.env.INDOOR_FIXTURES ?? join(__dirname, 'output', 'indoor-fixtures')
const OUT = process.env.INDOOR_OUT ?? join(__dirname, 'out')
const SIZE = { width: 1280, height: 720 }
mkdirSync(OUT, { recursive: true })

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
const videoDir = join(OUT, 'video-indoor')
rmSync(videoDir, { recursive: true, force: true })
mkdirSync(videoDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
const page = await context.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

await page.goto(`${BASE}/?mode=solo&e2e&seed=3&world=@inline`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function')

const tick = () => page.evaluate(() => window.__sporefall?.world?.tick ?? 0)
const dwell = async (ticks) => {
  const start = await tick()
  const deadline = Date.now() + 20000
  while ((await tick()) < start + ticks && Date.now() < deadline) await page.waitForTimeout(50)
}
const failures = []
const shots = []
const shot = async (file) => {
  const path = join(OUT, file)
  await page.screenshot({ path })
  shots.push(path)
}

const BIOME = { 'indoor-1-habitation': 'habitation', 'indoor-2-flooded': 'flooded', 'indoor-3-reactor': 'reactor', 'indoor-4-overgrown': 'overgrown' }
for (const [name, biome] of Object.entries(BIOME)) {
  await page.evaluate((j) => window.__loadWorld(j), fixture(name))
  await page.waitForTimeout(300)
  const info = await page.evaluate(() => {
    const w = window.__sporefall.world
    return { floor: w.floor, biome: w.level.complex?.biome, modules: w.level.buildings.length, roles: [...new Set(w.level.buildings.map((b) => b.role))] }
  })
  if (info.floor < 3) failures.push(`${name}: floor ${info.floor} is not a complex floor`)
  if (info.biome !== biome) failures.push(`${name}: biome ${info.biome} != ${biome}`)
  await page.evaluate(() => window.__zoom(1.4, true))
  await dwell(30)
  await shot(`${name}-close.png`)
  await page.evaluate(() => window.__zoom(0.5))
  await dwell(45)
  await shot(`${name}-overview.png`)
  console.log(`${name}: floor ${info.floor} ${info.biome}, ${info.modules} modules [${info.roles.join(',')}]`)
}

// Director scene: let it run until the swarm and the blackout have both fired.
await page.evaluate((j) => window.__loadWorld(j), fixture('indoor-5-director'))
await page.evaluate(() => {
  window.__indoorSeen = []
  const loop = () => {
    const w = window.__sporefall?.world
    if (w) for (const e of w.events) if (['ventSwarm', 'lightsOut', 'ambush'].includes(e.type)) window.__indoorSeen.push(e.type)
    requestAnimationFrame(loop)
  }
  loop()
})
await page.evaluate(() => window.__zoom(1.0, true))
await dwell(55)
await shot('indoor-5-director-swarm.png')
await dwell(40)
await shot('indoor-5-director-lightsout.png')
await page.evaluate(() => window.__zoom(0.6))
await dwell(30)
await shot('indoor-5-director-lightsout-wide.png')
const seen = await page.evaluate(() => ({ events: window.__indoorSeen, director: window.__sporefall.world.director }))
if (!seen.director) failures.push('director state missing after load')
const fired = new Set(seen.events)
if (!fired.has('ventSwarm') && !(seen.director?.spawned?.length > 0)) failures.push('vent swarm never fired')
if (!fired.has('lightsOut') && !seen.director?.dark) failures.push('lights-out never fired')
console.log(`director: events seen [${[...fired].join(',')}], dark=${JSON.stringify(seen.director?.dark)}, spawned=${seen.director?.spawned?.length}`)

await page.close()
await context.close()
await browser.close()

const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'))
if (webm) {
  const webmPath = join(OUT, 'indoor-complex.webm')
  renameSync(join(videoDir, webm), webmPath)
  try {
    execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(OUT, 'indoor-complex.mp4')], { stdio: 'ignore' })
    rmSync(webmPath, { force: true })
    console.log(`indoor-complex.mp4 (${(statSync(join(OUT, 'indoor-complex.mp4')).size / 1024).toFixed(0)} KB)`)
  } catch {
    console.log('ffmpeg unavailable; kept indoor-complex.webm')
  }
}
rmSync(videoDir, { recursive: true, force: true })

if (errs.length) failures.push(`page errors: ${errs.join(' | ')}`)
for (const s of shots) console.log(`shot: ${s}`)
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('OK - indoor complex captured, all asserts passed')
