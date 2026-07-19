// Live-drive verification for the gamepad L2-fire / Start-pause / simplify change.
// Boots the REAL app (vite preview build) in Chromium, stubs navigator.getGamepads
// with a mutable fake pad, and observes the world + PAUSED banner.
//
//   node scripts/test/gamepad-live.mjs        (expects BASE_URL, default :4180)
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4180'
const OUT = process.env.OUT_DIR ?? '/tmp/gamepad-live'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

// A mutable fake pad behind the real Gamepad API surface the app polls.
await page.addInitScript(() => {
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
  window.__pads = [mk()]
  window.__setPad = (over) => { window.__pads = [mk(over)] }
  navigator.getGamepads = () => window.__pads
})

const results = []
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

await page.goto(`${BASE}/?mode=solo&seed=7&e2e`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__world?.tick > 5)

const world = (expr) => page.evaluate(expr)
const setPad = (over) => page.evaluate((o) => window.__setPad(o), over)
const settle = (ms = 300) => page.waitForTimeout(ms)
const bannerVisible = () =>
  page.evaluate(() => [...document.querySelectorAll('div')].some((d) => d.textContent === 'PAUSED' && d.style.display === 'flex'))

// 1. Join with Start (button 9): must join WITHOUT pausing (the old bug).
await setPad({ pressed: [9] })
await settle()
await setPad({})
await settle()
const t1 = await world(() => window.__world.tick)
await settle(400)
const t2 = await world(() => window.__world.tick)
check('Start press joins without pausing (tick keeps advancing)', t2 > t1, `tick ${t1} -> ${t2}, banner=${await bannerVisible()}`)
check('no PAUSED banner after the joining Start press', !(await bannerVisible()))

// 2. Right stick deflection alone: aims, but must NOT fire (buttons-only model).
await setPad({ axes: [0, 0, 0.95, 0] })
await settle(500)
const shotsFromStick = await world(() => window.__world.entities.filter((e) => e.kind === 'projectile').length)
await setPad({})
check('deflected right stick alone fires nothing', shotsFromStick === 0, `${shotsFromStick} projectiles`)

// 3. Hold L2 (button 6): the player must shoot.
await setPad({ pressed: [6], axes: [0, 0, 0.95, 0] })
await settle(700)
const shotsFromL2 = await world(() => window.__world.entities.filter((e) => e.kind === 'projectile').length)
await setPad({})
await settle()
check('holding L2 fires projectiles', shotsFromL2 > 0, `${shotsFromL2} projectiles in flight`)

// 3b. Analog-only L2 (value 0.8, pressed false) also fires.
await settle(600) // let old bullets die
await setPad({ values: { 6: 0.8 }, axes: [0, 0, 0.95, 0] })
await settle(700)
const shotsAnalog = await world(() => window.__world.entities.filter((e) => e.kind === 'projectile').length)
await setPad({})
await settle()
check('analog L2 (value 0.8, pressed=false) fires', shotsAnalog > 0, `${shotsAnalog} projectiles`)

// 4. Start (deliberate, post-join): pauses — banner shows, tick freezes.
await setPad({ pressed: [9] })
await settle()
await setPad({})
const tp1 = await world(() => window.__world.tick)
await settle(500)
const tp2 = await world(() => window.__world.tick)
check('Start pauses: sim tick frozen', tp1 === tp2, `tick ${tp1} -> ${tp2}`)
check('PAUSED banner visible', await bannerVisible())
await page.screenshot({ path: `${OUT}/paused.png` })

// 5. Start again: resumes.
await setPad({ pressed: [9] })
await settle()
await setPad({})
const tr1 = await world(() => window.__world.tick)
await settle(500)
const tr2 = await world(() => window.__world.tick)
check('Start again resumes: tick advances', tr2 > tr1, `tick ${tr1} -> ${tr2}`)
check('banner gone after resume', !(await bannerVisible()))

// 6. Adversarial raw pad: mapping '', 8 axes, triggers resting at -1 on axes 2/3.
//    Must be COMPLETELY inert (the shipped-bug repro, live).
await setPad({ mapping: '', axes: [0, 0, -1, -1, 0, 0, 0, 0], pressed: [0] }) // join with A
await settle()
await setPad({ mapping: '', axes: [0, 0, -1, -1, 0, 0, 0, 0] })
await settle(300)
const before = await world(() => {
  const p = window.__world.entities.find((e) => e.playerCtl)
  return { x: p.pos.x, y: p.pos.y, shots: window.__world.entities.filter((e) => e.kind === 'projectile').length }
})
await settle(700)
const after = await world(() => {
  const p = window.__world.entities.find((e) => e.playerCtl)
  return { x: p.pos.x, y: p.pos.y, shots: window.__world.entities.filter((e) => e.kind === 'projectile').length }
})
check('raw pad with trigger axes resting at -1 stays inert (no move, no fire)',
  before.x === after.x && before.y === after.y && after.shots === 0,
  JSON.stringify({ before, after }))

// 7. Raw pad L2 button still fires (same shared map).
await setPad({ mapping: '', axes: [0, 0, -1, -1, 0, 0, 0, 0], pressed: [6] })
await settle(700)
const rawShots = await world(() => window.__world.entities.filter((e) => e.kind === 'projectile').length)
await setPad({})
check('raw pad L2 button fires', rawShots > 0, `${rawShots} projectiles`)

console.log(results.join('\n'))
if (errs.length) { console.log('PAGE ERRORS:', errs.join(' | ')); process.exitCode = 1 }
await browser.close()
