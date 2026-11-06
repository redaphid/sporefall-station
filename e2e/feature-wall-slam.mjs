// #173 wall slam: a body thrown hard into a wall slams, crumples and slumps.
//
// Stage: the walled room east of the lot in combat-stage (walls x 46 and 53,
// y 3 and 14). The player stands in the middle at (49.5, 9); a sleeping
// mutant stands near each wall and a heavy round (its full hp, max hp the
// same: force 1) throws it into that wall, one beat at a time (SHOTS):
//   east   into the east wall (x 53), seen in profile
//   west   into the west wall (x 46), in profile, mirrored
//   north  into the north wall (y 3), face-on
//   south  into the south wall (y 14), from behind
//   corner into the south-west corner, two faces at once
//
// Two passes over the same deterministic run, as feature-death-tumble.mjs:
// `record()` for the clip, then one tick per screenshot for the 4x strips
// (scripts/test/slam-strip.py).
//
// Env: BASE_URL (served dist), E2E_OUT, SLAM_STEP_OUT (stepped frames dir).
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BASE, OUT, record } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const STEP_OUT = process.env.SLAM_STEP_OUT ?? join(OUT, 'wall-slam-steps')
const ZOOM = Number(process.env.SLAM_ZOOM ?? 1)

const PLAYER = { x: 49.5, y: 9 }
/** Each victim stands 0.45 tiles (plus its footprint) off its wall. */
export const VICTIMS = [
  { tag: 'east', x: 52.0, y: 5.5, hp: 24, max: 24 },
  { tag: 'west', x: 48.0, y: 7.5, hp: 24, max: 24 },
  { tag: 'north', x: 50.5, y: 4.75, hp: 24, max: 24 },
  { tag: 'south', x: 50.5, y: 13.25, hp: 24, max: 24 },
  { tag: 'corner', x: 47.85, y: 13.4, hp: 24, max: 24 },
]
/** [tick, label, rounds: [start, velocity tiles/s, damage]]. */
const SHOTS = [
  [20, 'east', [[{ x: 50.6, y: 5.5 }, { x: 14, y: 0 }, 24]]],
  [90, 'west', [[{ x: 49.4, y: 7.5 }, { x: -14, y: 0 }, 24]]],
  [160, 'north', [[{ x: 50.5, y: 6.15 }, { x: 0, y: -14 }, 24]]],
  [230, 'south', [[{ x: 50.5, y: 11.85 }, { x: 0, y: 14 }, 24]]],
  [300, 'corner', [[{ x: 48.85, y: 12.4 }, { x: -9.9, y: 9.9 }, 24]]],
]
const TOTAL = 370

const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  const proto = w.entities.find((e) => e.archetype === 'mutant')
  p.pos = { ...PLAYER }
  p.prevPos = { ...PLAYER }
  p.facing = 0
  const mutants = VICTIMS.map((v, i) => {
    const m = JSON.parse(JSON.stringify(proto))
    m.id = 200 + i
    m.pos = { x: v.x, y: v.y }
    m.prevPos = { x: v.x, y: v.y }
    m.health.hp = v.hp
    if (v.max) m.health.max = v.max
    if (v.arch) m.archetype = v.arch
    // Asleep: they stand where they are put (sleeping NPCs skip AI).
    m.status.sleep = 100000
    m.ai.home = { x: v.x, y: v.y }
    // Face the player, the way a guard would.
    m.facing = Math.atan2(PLAYER.y - v.y, PLAYER.x - v.x)
    return m
  })
  w.nextId = Math.max(w.nextId, 300)
  w.entities = [p, ...mutants]
  return w
}

/** In-page: put a volley in flight (the host world, `?e2e`). */
const shoot = ([, , rounds]) => {
  const w = window.__world
  const owner = w.entities.find((x) => x.playerCtl).id
  for (const [at, vel, dmg, onLand] of rounds) {
    const id = w.nextId++
    const e = {
      id,
      kind: 'projectile',
      archetype: onLand ? 'grenade' : 'projectile',
      pos: { ...at },
      prevPos: { ...at },
      vel: { ...vel },
      intent: { x: 0, y: 0 },
      speed: 0,
      radius: 0.15,
      facing: Math.atan2(vel.y, vel.x),
      projectile: onLand ? { ownerId: owner, damage: 0, ttl: 15, onLand, arc: true } : { ownerId: owner, damage: dmg, ttl: 60 },
    }
    w.entities.push(e)
    w.byId.set(id, e)
  }
}

const params = { mode: 'solo', e2e: '1', world: '@inline', zoom: String(ZOOM) }
const load = async (page) => {
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate((j) => window.__loadWorld(j), stage())
}

const readState = () => ({
  tick: window.__world.tick,
  mutants: window.__world.entities.filter((e) => e.archetype === 'mutant' && !e.dead).length,
  deaths: window.__deaths ?? null,
})

// --- 1) the live clip --------------------------------------------------------
// record() waits for `__scriptTicks` before it stops; with no ?script that is
// 0, so the last still (TOTAL) is what holds the run open to the end.
const ok = await record({
  name: 'wall-slam',
  params,
  beforeTicks: load,
  stills: [
    ...SHOTS.map((s, i) => ({ tick: s[0] - 1, label: `shot-${i}-${s[1]}`, act: (page) => page.evaluate(shoot, s) })),
    { tick: TOTAL, label: 'end' },
  ],
  readState,
  expect: (s) => [s.mutants !== 0 && `${s.mutants} mutants survived: a round missed`].filter(Boolean),
})

// --- 2) the stepped pass ---------------------------------------------------
mkdirSync(STEP_OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(`${BASE}/?${new URLSearchParams(params)}`, { waitUntil: 'networkidle' })
await load(page)
await page.waitForFunction(() => window.__sporefall !== undefined, { timeout: 20000 })
// The sim only advances when the driver lets it, one tick at a time.
await page.evaluate(() => {
  const s = window.__sporefall
  const orig = s.tick.bind(s)
  window.__go = 0
  s.tick = () => {
    if (window.__go <= 0) return
    window.__go--
    orig()
  }
})
const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
for (let t = await page.evaluate(() => window.__world.tick); t < TOTAL; ) {
  for (const s of SHOTS) if (s[0] - 1 === t) await page.evaluate(shoot, s)
  await page.evaluate(() => (window.__go = 1))
  await page.waitForFunction((t0) => window.__world.tick > t0, t, { timeout: 10000 })
  t = await page.evaluate(() => window.__world.tick)
  await frame()
  await page.screenshot({ path: join(STEP_OUT, `t${String(t).padStart(4, '0')}.png`) })
}
const final = await page.evaluate(readState)
await browser.close()
console.log(`[wall-slam] stepped frames in ${STEP_OUT}; final ${JSON.stringify(final)}`)
if (final.mutants !== 0) errs.push(`stepped pass: ${final.mutants} mutants survived`)
if (errs.length) {
  for (const e of errs) console.error(`[wall-slam] FAIL: ${e}`)
  process.exitCode = 1
}
if (!ok) process.exitCode = 1
