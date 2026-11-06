// #172 death tumble: a kill THROWS the body (display only).
//
// Stage: the open lot west of the walled block in combat-stage. The player
// stands at (34, 9); sleeping victims stand around it and are killed one beat
// at a time (SHOTS), each a different case of the throw:
//   east-wall    full-damage round east into a mutant flush on the wall (x 46)
//   pistol-plink 14 dmg on a 40-max-hp mutant: under the threshold, the old topple
//   shotgun      five 7-dmg pellets point blank on a 7-hp mutant, fanned south-west
//   sporeling    a pistol round finishing a sporeling (14 / 22 = 0.64)
//   grenade-a..c a grenade onto a cluster of three: radial throws, one tick
//
// Two passes over the same deterministic run:
//   1. `record()`: the live video with stills (the clip).
//   2. A stepped pass: the sim advances exactly one tick per screenshot, so
//      every tick of every tumble is on file for the frame strip
//      (scripts/test/tumble-strip.py builds the 4x nearest sheets).
//
// Env: BASE_URL (served dist), E2E_OUT, TUMBLE_STEP_OUT (stepped frames dir).
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BASE, OUT, record } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const STEP_OUT = process.env.TUMBLE_STEP_OUT ?? join(OUT, 'death-tumble-steps')
const ZOOM = Number(process.env.TUMBLE_ZOOM ?? 1)

const PLAYER = { x: 34, y: 9 }
/** Every victim, asleep where it is put. `arch` overrides the art (a cloned
 * mutant drawn as that archetype); `max` overrides max hp. */
export const VICTIMS = [
  { tag: 'east-wall', x: 45.55, y: 9, hp: 24 },
  { tag: 'pistol-plink', x: 34, y: 5, hp: 14, max: 40 },
  { tag: 'shotgun', x: 30, y: 12.5, hp: 7 },
  { tag: 'sporeling', x: 30, y: 9, hp: 14, max: 22, arch: 'sporeling' },
  { tag: 'grenade-a', x: 38, y: 13, hp: 24 },
  { tag: 'grenade-b', x: 38.9, y: 13.3, hp: 24 },
  { tag: 'grenade-c', x: 38.3, y: 13.9, hp: 24 },
]
const ray = (from, deg, speed) => ({ x: Math.cos((deg * Math.PI) / 180) * speed, y: Math.sin((deg * Math.PI) / 180) * speed })
/** [tick, label, rounds: [start, velocity tiles/s, damage, onLand?]]. */
const SHOTS = [
  // A full-damage round into a mutant flush against the block's west wall.
  [20, 'east-wall', [[{ x: 42.5, y: 9 }, { x: 14, y: 0 }, 24]]],
  // A pistol plink (14 of 40 max hp) on a mutant: under the threshold.
  [65, 'pistol-plink', [[{ x: 34, y: 7.6 }, { x: 0, y: -14 }, 14]]],
  // Point-blank shotgun (5 x 7 dmg, 16 tiles/s) finishing a mutant on 7 hp:
  // i-frames void all but the first pellet's hit, so the renderer counts the volley.
  [110, 'shotgun', [-12, -6, 0, 6, 12].map((d) => [{ x: 31.4, y: 11.1 }, ray(0, 135 + d, 16), 7])],
  // A pistol round (14 dmg) finishing a sporeling: 14/22 = 0.64.
  [155, 'sporeling', [[{ x: 32.6, y: 9 }, { x: -14, y: 0 }, 14]]],
  // A grenade lobbed onto the cluster: lands at (38.4, 13.4) after 15 ticks.
  [200, 'grenade', [[{ x: 36, y: 11 }, { x: (2.4 / 15) * 30, y: (2.4 / 15) * 30 }, 0, { kind: 'explode', radius: 1.8, damage: 40 }]]],
]
const TOTAL = 300

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
  name: 'death-tumble',
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
console.log(`[death-tumble] stepped frames in ${STEP_OUT}; final ${JSON.stringify(final)}`)
if (final.mutants !== 0) errs.push(`stepped pass: ${final.mutants} mutants survived`)
if (errs.length) {
  for (const e of errs) console.error(`[death-tumble] FAIL: ${e}`)
  process.exitCode = 1
}
if (!ok) process.exitCode = 1
