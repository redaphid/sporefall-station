// Live-drive verification for the join-flow rework: ANY input joins an exposed
// pad (including pure stick movement), and the joining input is inert until
// released — joining with the special/grenade button must never throw a
// grenade, and joining with Start must never pause.
//
// Boots the REAL app (vite preview over dist/) in Chromium with a mutable fake
// pad behind navigator.getGamepads. Spins its OWN server on a unique port and
// refuses to reuse someone else's.
//
//   pnpm run build && node scripts/test/gamepad-join-live.mjs
import { spawn } from 'node:child_process'
import net from 'node:net'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT ?? 4317) // unique to this harness
const BASE = `http://localhost:${PORT}`
const OUT = process.env.OUT_DIR ?? '/tmp/gamepad-join-live'

// --- Own-server check: the port must be FREE, then we start preview ourselves.
const portFree = () =>
  new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(PORT, () => srv.close(() => resolve(true)))
  })
if (!(await portFree())) {
  console.error(`FAIL  port ${PORT} is already in use — refusing to test against a foreign server`)
  process.exit(1)
}
const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
})
const up = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('preview server never came up')
}
await up()

const browser = await chromium.launch({ headless: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

/** Fresh page with a mutable fake pad; `initial` sets the pad's state from the
 * very first poll (so "appears already deflected" is really from-birth). */
const newPage = async (initial = {}) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => check('no page errors', false, String(e)))
  await page.addInitScript((INITIAL) => {
    const mk = (over = {}) => ({
      index: 0,
      id: 'Fake Pad (STANDARD GAMEPAD Vendor: beef Product: cafe)',
      connected: true,
      timestamp: 0,
      mapping: over.mapping ?? 'standard',
      axes: over.axes ?? [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => {
        const v = over.values?.[i] ?? (over.pressed?.includes(i) ? 1 : 0)
        return { pressed: over.pressed?.includes(i) ?? false, touched: v > 0, value: v }
      }),
    })
    window.__pads = [mk(INITIAL)]
    window.__setPad = (over) => {
      window.__pads = [mk(over)]
    }
    navigator.getGamepads = () => window.__pads
  }, initial)
  await page.goto(`${BASE}/?mode=solo&seed=7&e2e`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__world?.tick > 5)
  return page
}

const setPad = (page, over) => page.evaluate((o) => window.__setPad(o), over)
const settle = (page, ms = 300) => page.waitForTimeout(ms)
const snap = (page) =>
  page.evaluate(() => {
    const p = window.__world.entities.find((e) => e.playerCtl)
    return {
      x: p.pos.x,
      y: p.pos.y,
      cooldown: p.playerCtl.abilityCooldown,
      grenades: window.__world.entities.filter((e) => (e.kind ?? '').includes('grenade')).length,
      projectiles: window.__world.entities.filter((e) => e.kind === 'projectile').length,
      tick: window.__world.tick,
    }
  })
const bannerVisible = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('div')].some((d) => d.textContent === 'PAUSED' && d.style.display === 'flex'),
  )
const hintVisible = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('div')].some(
      (d) => d.textContent.startsWith('Controller detected') && d.style.display !== 'none',
    ),
  )

// ------------------------------------------------------------------
// A. Pure stick movement joins the pad; nothing else happens.
{
  const page = await newPage()
  await settle(page, 400) // pad idle: proves neutral, must NOT join
  check('A: unjoined idle pad shows the join hint', await hintVisible(page))
  const before = await snap(page)
  await setPad(page, { axes: [0.95, 0, 0, 0] }) // firm left-stick push, no buttons
  await settle(page, 900)
  const after = await snap(page)
  check('A: stick wiggle alone JOINS and moves the player', after.x !== before.x || after.y !== before.y,
    `pos (${before.x.toFixed(2)},${before.y.toFixed(2)}) -> (${after.x.toFixed(2)},${after.y.toFixed(2)})`)
  check('A: join hint gone once joined', !(await hintVisible(page)))
  check('A: no grenade from the stick join', after.cooldown <= 0 && after.grenades === 0,
    `cooldown=${after.cooldown} grenades=${after.grenades}`)
  check('A: no shots from the stick join', after.projectiles === 0, `${after.projectiles} projectiles`)
  check('A: no pause from the stick join', !(await bannerVisible(page)))
  await setPad(page, {})
  await page.screenshot({ path: `${OUT}/stick-join.png` })
  await page.close()
}

// B. Joining by holding the special/grenade button (X = 2) throws NOTHING —
//    not on the join, not while held — then a fresh press throws normally.
{
  const page = await newPage()
  await setPad(page, { pressed: [2] }) // held special: joins
  await settle(page, 800) // held across many samples — the old bug fired here
  const held = await snap(page)
  check('B: joining with X never throws (held)', held.cooldown <= 0 && held.grenades === 0,
    `cooldown=${held.cooldown} grenades=${held.grenades}`)
  await setPad(page, {}) // release
  await settle(page, 300)
  const released = await snap(page)
  check('B: still nothing on release', released.cooldown <= 0 && released.grenades === 0,
    `cooldown=${released.cooldown} grenades=${released.grenades}`)
  await setPad(page, { pressed: [2] }) // fresh, deliberate press
  await settle(page, 400)
  const thrown = await snap(page)
  check('B: a fresh X press after release DOES fire the special', thrown.cooldown > 0 || thrown.grenades > 0,
    `cooldown=${thrown.cooldown} grenades=${thrown.grenades}`)
  await setPad(page, {})
  await page.close()
}

// C. Joining by holding Start (9) never pauses; a fresh Start press does.
{
  const page = await newPage()
  await setPad(page, { pressed: [9] })
  await settle(page, 700) // held Start across many samples
  check('C: no PAUSED banner while the joining Start is held', !(await bannerVisible(page)))
  await setPad(page, {})
  await settle(page, 200)
  const t1 = (await snap(page)).tick
  await settle(page, 400)
  const t2 = (await snap(page)).tick
  check('C: sim runs after the Start join', t2 > t1, `tick ${t1} -> ${t2}`)
  await setPad(page, { pressed: [9] }) // deliberate pause
  await settle(page, 300)
  check('C: a fresh Start press pauses', await bannerVisible(page))
  await setPad(page, {})
  await page.close()
}

// D. Adversarial: a pad appearing ALREADY deflected (resting-trigger shape on
//    the move axes) must never join by itself.
{
  const pinned = { mapping: '', axes: [0, -1, 0, 0, 0, 0, 0, 0] }
  const page = await newPage(pinned) // deflected from the very first poll
  await settle(page, 1200)
  const s = await snap(page)
  const before = { x: s.x, y: s.y }
  await settle(page, 700)
  const t = await snap(page)
  check('D: an axis pinned at -1 with no neutral proof never joins/moves',
    before.x === t.x && before.y === t.y, JSON.stringify({ before, after: { x: t.x, y: t.y } }))
  check('D: hint still up — the pad is exposed but unjoined', await hintVisible(page))
  await page.close()
}

await browser.close()
server.kill()
console.log(results.join('\n'))
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
