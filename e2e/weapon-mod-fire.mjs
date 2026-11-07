// The gun promises the shot: the player fires one weapon under several mod
// builds, and each still shows the held art (mod attachments + coloured
// accent) next to the projectiles that build actually fires, in the real game
// (built bundle, `?script=shooting`, combat-stage fixture). One row per build,
// several stills across the shot; cropped around the player and blown up 4x.
//
//   BASE_URL=http://localhost:4893 node e2e/weapon-mod-fire.mjs OUT_DIR [--weapon rivetDriver]
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const OUT = argv[0]
const flag = (n, d) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : d)
const WEAPON = flag('weapon', 'rivetDriver')
const BASE = process.env.BASE_URL ?? 'http://localhost:4891'
mkdirSync(OUT, { recursive: true })

const BUILDS = [
  ['unmodded', []],
  ['frost', [{ id: 'frost', stacks: 2 }]],
  ['incendiary', [{ id: 'incendiary', stacks: 2 }]],
  ['shock', [{ id: 'shock', stacks: 2 }]],
  ['explosive', [{ id: 'explosive', stacks: 2 }]],
  ['explosive+frost+incendiary', [{ id: 'explosive', stacks: 1 }, { id: 'frost', stacks: 1 }, { id: 'incendiary', stacks: 1 }]],
]
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const world = (mods) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = WEAPON
  p.loadout = { inventory: [{ itemId: WEAPON, qty: 200, mods }], activeSlot: 0 }
  // Shots fly their full range (nothing to stop them), so one is always in flight.
  w.entities = w.entities.filter((e) => e.kind !== 'npc')
  return w
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })).newPage()
const shots = []
for (const [label, mods] of BUILDS) {
  const url = `${BASE}/?${new URLSearchParams({ mode: 'solo', e2e: '1', world: '@inline', script: 'shooting', zoom: '1' })}`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate((j) => window.__loadWorld(j), world(mods))
  await page.waitForFunction(() => window.__world && window.__world.tick > 2 && typeof window.__renderedProject === 'function')
  for (let k = 0; k < 2; k++) {
    // wait until a projectile of ours is in flight, then shoot the frame
    // `shooting` holds fire from tick 220 (scripted.ts); with the lane clear a
    // shot is always in flight until it stops at tick 380.
    for (let t0 = Date.now(); ; await page.waitForTimeout(250)) {
      const [tick, shots, dbg] = await page.evaluate(() => [window.__world.tick, window.__world.entities.filter((e) => e.kind === 'projectile').length, JSON.stringify(window.__world.entities.find((e) => e.playerCtl)?.combat) + location.search])
      if (process.env.DBG) console.log(tick, shots, dbg)
      if (tick > 240 + k * 7 && shots > 0) break
      if (Date.now() - t0 > 90000 || tick > 380) throw new Error(`${label}: no shot in flight (tick ${tick})`)
    }
    const at = await page.evaluate(() => {
      const p = window.__world.entities.find((e) => e.playerCtl)
      return window.__renderedProject(p.pos.x, p.pos.y)
    })
    const file = join(OUT, `${label}-${k}.png`)
    await page.screenshot({ path: file })
    shots.push({ label, k, file, x: at.x * 2, y: at.y * 2 })
  }
}
await browser.close()
writeFileSync(join(OUT, 'shots.json'), JSON.stringify(shots, null, 1))
execFileSync('python3', [join(__dirname, 'weapon_mod_fire_compose.py'), OUT], { stdio: 'inherit' })
