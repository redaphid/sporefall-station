// GROUP SET-PIECES IN A REAL BROWSER: the two raid beats the owner played on
// the live site and saw nothing of, driven the way a person plays them.
//
//   tide-sappers — sealed in a building, every door locked; the Blast Diver
//                  plants a charge on a door, backs off and blows it, and the
//                  raid comes in.
//   tide-medic   — wounded grunts fall back to the Bog Mender, are healed to
//                  80%, and walk back in.
//
// Each runs twice: a player who touches nothing, and one who strafes (WASD)
// and holds fire (Space) with the mouse on the nearest raider. The page is
// sampled every animation frame from `window.world` (door state, the raid's
// charge, raider hp / `healing`), so the verdict is the sim's own state, not a
// pixel guess. Budgets are in SIM TICKS (30/s), so a slow software-rendered
// headless browser is judged on game time, not wall time.
//
// Run: ./e2e/run-group-scenarios.sh            (builds, serves, verifies)
//      BASE_URL=https://sporefall.hypnodroid.com node e2e/group-scenarios.mjs
// Stills + video land in $E2E_OUT/group-scenarios/.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4981'
const OUT = join(process.env.E2E_OUT ?? join(__dirname, 'output'), 'group-scenarios')
const S = 30
const BUDGET = 15 * S
const RUN_TICKS = Number(process.env.RUN_TICKS ?? 20 * S)
const VIEW = { width: 844, height: 390 }
const ONLY = process.env.ONLY // e.g. "tide-medic:fight"

mkdirSync(OUT, { recursive: true })
const failures = []
const fail = (m) => (console.error(`  FAIL — ${m}`), failures.push(m))
const ok = (m) => console.log(`  ok — ${m}`)

// Runs IN the page: one sample per animation frame, straight off window.world.
const SAMPLER = () => {
  const out = (window.__gs = { samples: [], charge: null, breach: null, heals: [] })
  let last = -1
  const step = () => {
    const w = window.world
    if (w && w.tick !== last) {
      last = w.tick
      const g = w.groups?.list?.[0]
      const raiders = w.entities.filter((e) => !e.dead && e.ai?.group)
      const p = w.entities.find((e) => e.playerCtl)
      const doors = w.entities.filter((e) => e.door && !e.dead && e.door.locked !== undefined)
      if (g?.chargeAt !== undefined && !out.charge) out.charge = { tick: w.tick, doorId: g.doorId, chargeAt: g.chargeAt }
      if (out.charge && !out.breach) {
        const d = w.byId.get(out.charge.doorId)
        if (d?.door?.open) out.breach = { tick: w.tick }
      }
      for (const ev of w.events ?? []) if (ev.type === 'heal') out.heals.push({ tick: w.tick, to: ev.entityId })
      out.samples.push({
        tick: w.tick,
        phase: g?.phase,
        mission: w.mission?.complete,
        alert: w.mission?.alertTick,
        player: p && { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2) },
        doors: doors.map((d) => ({ id: d.id, open: d.door.open, locked: d.door.locked })),
        raiders: raiders.map((e) => ({
          id: e.id,
          role: e.ai.group.role,
          x: +e.pos.x.toFixed(2),
          y: +e.pos.y.toFixed(2),
          hp: e.health?.hp,
          max: e.health?.max,
          healing: !!e.ai.healing,
        })),
      })
    }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// No GPU by default: on WSL every GL-backed headless launch (default, ANGLE/
// SwiftShader, in-process GPU) hangs page.goto, so the verdict runs on the sim
// with pixi unable to draw (stills come out as HUD over black). On a host with
// working GL, CHROME_ARGS="" gets real stills and video.
const CHROME_ARGS = process.env.CHROME_ARGS ?? '--disable-gpu --disable-software-rasterizer'
const browser = await chromium.launch({ args: CHROME_ARGS.split(' ').filter(Boolean) })
/** pixi's own complaint when there is no GL context at all: environmental. */
const NO_GL = /updateRenderable/

const run = async (scenario, mode) => {
  const label = `${scenario}-${mode}`
  console.log(`\n[${label}]`)
  const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: join(OUT, 'video', label), size: VIEW } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${BASE}/?mode=solo&seed=3&scenario=${scenario}&e2e=1`)
  await page.waitForFunction(() => window.world && window.world.tick > 0, null, { timeout: 60_000 })
  await page.evaluate(SAMPLER)
  const tick = () => page.evaluate(() => window.world.tick)
  const t0 = await tick()
  const shots = new Set()
  const still = async (name) => {
    if (shots.has(name)) return
    shots.add(name)
    await page.screenshot({ path: join(OUT, `${label}-${name}.png`) })
  }
  const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA']
  let k = -1
  if (mode === 'fight') await page.keyboard.down('Space')
  for (;;) {
    const now = await tick()
    if (now - t0 >= RUN_TICKS) break
    if (mode === 'fight') {
      const leg = Math.floor((now - t0) / 45) % 4
      if (leg !== k) {
        if (k >= 0) await page.keyboard.up(keys[k])
        k = leg
        await page.keyboard.down(keys[k])
      }
      const at = await page.evaluate(() => {
        const w = window.world
        const p = w.entities.find((e) => e.playerCtl)
        let best = null
        let bd = Infinity
        for (const e of w.entities) {
          if (e.dead || !e.ai?.group) continue
          const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y)
          if (d < bd) (bd = d), (best = e)
        }
        return best && window.__renderedProject(best.pos.x, best.pos.y)
      })
      if (at) await page.mouse.move(at.x, at.y)
    }
    const gs = await page.evaluate(() => ({ charge: !!window.__gs.charge, breach: !!window.__gs.breach, heals: window.__gs.heals.length }))
    if (gs.charge) await still('1-charge-planted')
    if (gs.breach) await still('2-door-blown')
    if (gs.heals >= 1) await still('1-first-heal')
    if (gs.heals >= 4) await still('2-heals')
    if (now - t0 >= 2 * S) await still('0-opening')
    await page.waitForTimeout(120)
  }
  if (mode === 'fight') {
    await page.keyboard.up('Space')
    if (k >= 0) await page.keyboard.up(keys[k])
  }
  await still('3-end')
  const gs = await page.evaluate(() => window.__gs)
  await ctx.close()
  const real = errors.filter((e) => !(CHROME_ARGS.includes('--disable-gpu') && NO_GL.test(e)))
  if (real.length) fail(`${label}: page errors: ${real.slice(0, 3).join(' | ')}`)
  return { gs, t0 }
}

const judgeSappers = (label, { gs, t0 }) => {
  const first = gs.samples[0]
  const closedAtStart = first.doors.filter((d) => d.locked && !d.open).map((d) => d.id)
  console.log(`  start: tick ${first.tick}, locked+closed doors ${closedAtStart.length}, phase ${first.phase}, mission complete ${first.mission}`)
  const earlyOpen = gs.samples.find(
    (s) => (!gs.charge || s.tick < gs.charge.tick) && s.doors.some((d) => closedAtStart.includes(d.id) && (d.open || !d.locked)),
  )
  if (earlyOpen) fail(`${label}: a sealed door opened before any charge (tick ${earlyOpen.tick}, alert ${earlyOpen.alert})`)
  else ok('every sealed door held until the charge')
  if (!gs.charge) return fail(`${label}: no charge was ever planted`)
  const planted = gs.charge.tick - t0
  planted <= BUDGET ? ok(`charge planted ${(planted / S).toFixed(1)}s in`) : fail(`${label}: charge planted late (${(planted / S).toFixed(1)}s)`)
  if (!gs.breach) return fail(`${label}: the charged door never blew`)
  const blown = gs.breach.tick - t0
  blown <= BUDGET ? ok(`door blown ${(blown / S).toFixed(1)}s in`) : fail(`${label}: door blown late (${(blown / S).toFixed(1)}s)`)
  const lastS = gs.samples.at(-1)
  const near = gs.samples.some(
    (s) => s.tick > gs.breach.tick && s.raiders.some((r) => Math.hypot(r.x - s.player.x, r.y - s.player.y) < 5),
  )
  near ? ok('the raid came through to the player') : fail(`${label}: nobody came through the breach`)
  console.log(`  end: phase ${lastS.phase}, ${lastS.raiders.length} raiders alive`)
}

const judgeMedic = (label, { gs, t0 }, strict) => {
  const first = gs.samples[0]
  const grunts = first.raiders.filter((r) => r.role === 'grunt')
  const medic = first.raiders.find((r) => r.role === 'medic')
  // A fall-back is a RUN the player can watch, not a grunt already standing in
  // the medic's reach (the live build spawned them in one knot).
  const far = grunts.filter((g) => medic && Math.hypot(g.x - medic.x, g.y - medic.y) > 3.2)
  far.length === grunts.length
    ? ok(`all ${grunts.length} wounded grunts start out of the medic's reach, so the fall-back is visible`)
    : fail(`${label}: ${grunts.length - far.length}/${grunts.length} grunts start inside the medic's reach (no fall-back to see)`)
  console.log(`  start: ${grunts.map((g) => `${g.id} ${g.hp}/${g.max}`).join(', ')}`)
  const within = gs.samples.filter((s) => s.tick - t0 <= BUDGET)
  const cycles = grunts.filter((g) => {
    const mine = within.filter((s) => s.phase !== 'routed').map((s) => s.raiders.find((r) => r.id === g.id)).filter(Boolean)
    const fell = mine.findIndex((r) => r.healing)
    if (fell < 0) return false
    const back = mine.findIndex((r, i) => i > fell && !r.healing)
    return back > 0 && mine[back].hp / mine[back].max >= 0.8 && gs.heals.some((h) => h.to === g.id)
  })
  const need = strict ? grunts.length : 1
  cycles.length >= need
    ? ok(`${cycles.length}/${grunts.length} grunts fell back, were healed to 80% and rejoined inside 15s (${gs.heals.length} heals)`)
    : fail(`${label}: only ${cycles.length}/${grunts.length} full heal cycles inside 15s (need ${need}; ${gs.heals.length} heals)`)
}

const CASES = [
  ['tide-sappers', 'idle'],
  ['tide-sappers', 'fight'],
  ['tide-medic', 'idle'],
  ['tide-medic', 'fight'],
].filter(([s, m]) => !ONLY || ONLY === `${s}:${m}`)

console.log(`group scenarios against ${BASE}`)
for (const [scenario, mode] of CASES) {
  const r = await run(scenario, mode)
  const label = `${scenario}-${mode}`
  if (scenario === 'tide-sappers') judgeSappers(label, r)
  else judgeMedic(label, r, mode === 'idle')
}
await browser.close()
if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nall group-scenario beats landed')
