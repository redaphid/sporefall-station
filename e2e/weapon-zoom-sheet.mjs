// Held-weapon ZOOM SHEET: every armed archetype x 5 drawn facings x {idle, walk,
// aim, attack}, rendered by the real game (the built bundle, the pixi entity
// layer, the theme loader) at play zoom 1 on a 2x device, so one hi-res art
// pixel is one screenshot pixel, then cropped per character and blown up 4x
// nearest-neighbour. One PNG per pose: rows are archetypes, columns facings.
//
//   BASE_URL=http://localhost:4891 node e2e/weapon-zoom-sheet.mjs OUT_DIR \
//     [--theme swampspace-hires] [--weapons PACK_DIR] [--label after]
//
// --weapons PACK_DIR test-drives weapon art that is not in the pack yet: the
// page's theme manifest is patched in flight to map every
// `weapon-<id>-<view>-<state>-<n>.png` in PACK_DIR to its
// `weapon.<id>.<view>-<state>-<n>` key, and PACK_DIR/weapons.json is merged in
// as the manifest's `weapons` (grip/muzzle) section. Nothing is written to the
// pack. Without it the sheet shows exactly what the pack ships.
//
// Serve a build first (e.g. `pnpm exec vite build && pnpm exec vite preview
// --port 4891`). Needs python3 + Pillow for the compose step.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const OUT = argv[0]
if (!OUT || OUT.startsWith('--')) {
  console.error('usage: node e2e/weapon-zoom-sheet.mjs OUT_DIR [--theme id] [--weapons PACK_DIR] [--label name]')
  process.exit(2)
}
const BASE = process.env.BASE_URL ?? 'http://localhost:4891'
const THEME = flag('theme', 'swampspace-hires')
const WEAPONS_DIR = flag('weapons', undefined)
const LABEL = flag('label', 'sheet')
mkdirSync(OUT, { recursive: true })

// The armed cast: archetype and the weapon its table (or the player) carries.
const CAST = [
  ['player', 'pistol'],
  ['drowner', 'pistol'],
  ['bellwether', 'pistol'],
  ['acolyte', 'pistol'],
  ['mutant', 'wrench'],
  ['warden', 'wrench'],
  ['shopkeeper', 'wrench'],
  ['breacher', 'wrench'],
]
const FACINGS = [
  ['s', Math.PI / 2],
  ['se', Math.PI / 4],
  ['e', 0],
  ['ne', -Math.PI / 4],
  ['n', -Math.PI / 2],
]
const POSES = ['idle', 'walk', 'aim', 'attack']

const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 4.5, y: 11.5 }
  p.prevPos = { ...p.pos }
  p.facing = Math.PI / 2
  p.health.hp = p.health.max
  const cells = []
  let id = w.nextId
  CAST.forEach(([arch, weapon], row) =>
    FACINGS.forEach(([dir, facing], col) => {
      const x = 7.5 + col * 2
      const y = 4.4 + row * 2.05
      cells.push({ id, arch, dir, row, col, x, y })
      w.entities.push({
        id: id++,
        kind: 'npc',
        archetype: arch,
        pos: { x, y },
        prevPos: { x, y },
        vel: { x: 0, y: 0 },
        intent: { x: 0, y: 0 },
        speed: 0,
        radius: 0.35,
        facing,
        health: { hp: 30, max: 30, iframes: 0 },
        combat: { weapon, cooldown: 0 },
        status: { stun: 0, sleep: 0, hitFlashUntil: 0, cloakUntil: 0 },
        ai: { mode: 'idle', faction: 'civ', home: { x, y }, thinkAt: 1e9, sightRange: 1 },
      })
    }),
  )
  w.nextId = id
  w.entities = w.entities.filter((e) => e.playerCtl || cells.some((c) => c.id === e.id))
  return { world: w, cells }
}

/** Weapon art from PACK_DIR as manifest patches. */
const weaponPatch = () => {
  if (!WEAPONS_DIR) return undefined
  const sprites = {}
  for (const f of readdirSync(WEAPONS_DIR)) {
    const m = f.match(/^weapon-([A-Za-z]+)-(e|se|s|ne|n)-(idle|attack)-(\d)\.png$/)
    if (m) sprites[`weapon.${m[1]}.${m[2]}-${m[3]}-${m[4]}`] = `/__weapons/${f}`
  }
  const pts = join(WEAPONS_DIR, 'weapons.json')
  return { sprites, weapons: existsSync(pts) ? JSON.parse(readFileSync(pts, 'utf8')) : {} }
}

const { world, cells } = stage()
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const page = await context.newPage()
page.on('console', (m) => {
  if (m.type() === 'warning' && m.text().includes('[theme]')) console.log('  page:', m.text())
})
const patch = weaponPatch()
if (patch) {
  await page.route(`**/themes/${THEME}/manifest.json`, async (route) => {
    const res = await route.fetch()
    const m = await res.json()
    Object.assign((m.sprites ??= {}), patch.sprites)
    m.weapons = { ...(m.weapons ?? {}), ...patch.weapons }
    await route.fulfill({ response: res, json: m })
  })
  await page.route('**/__weapons/*', (route) =>
    route.fulfill({ path: join(WEAPONS_DIR, decodeURIComponent(route.request().url().split('/__weapons/')[1])) }),
  )
  console.log(`[zoom-sheet] injected ${Object.keys(patch.sprites).length} weapon frames from ${WEAPONS_DIR}`)
}
const url = `${BASE}/?mode=solo&e2e=1&world=@inline&zoom=1&fx=off&theme=${THEME}`
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
await page.evaluate((j) => window.__loadWorld(j), world)
await page.waitForFunction(() => window.__world && window.__world.tick > 5 && typeof window.__renderedProject === 'function', {
  timeout: 20000,
})

// Hold every cell in its pose each frame: facing, engagement, walking in place.
await page.evaluate((cellList) => {
  window.__pose = 'idle'
  const byId = new Map(cellList.map((c) => [c.id, c]))
  const hold = () => {
    const w = window.__world
    for (const e of w.entities) {
      const c = byId.get(e.id)
      if (!c) continue
      const walking = window.__pose === 'walk'
      e.facing = c.facing
      e.ai.mode = window.__pose === 'aim' ? 'aggro' : 'idle'
      e.ai.thinkAt = 1e9
      const vx = Math.cos(c.facing) * 0.05
      const vy = Math.sin(c.facing) * 0.05
      if (walking) {
        // Step in place: a small forward stride each frame, snapped back home.
        if (Math.hypot(e.pos.x - c.x, e.pos.y - c.y) > 0.4) {
          e.pos.x = c.x
          e.pos.y = c.y
        }
        e.prevPos.x = e.pos.x - vx
        e.prevPos.y = e.pos.y - vy
        e.pos.x += vx
        e.pos.y += vy
      } else {
        e.pos.x = e.prevPos.x = c.x
        e.pos.y = e.prevPos.y = c.y
      }
    }
    requestAnimationFrame(hold)
  }
  hold()
}, cells.map((c) => ({ ...c, facing: FACINGS[c.col][1] })))

const waitTicks = (n) =>
  page.evaluate(
    (k) =>
      new Promise((res) => {
        const t0 = window.__world.tick
        const poll = () => (window.__world.tick >= t0 + k ? res() : requestAnimationFrame(poll))
        poll()
      }),
    n,
  )

const meta = { label: LABEL, theme: THEME, weapons: WEAPONS_DIR ?? null, dpr: 2, facings: FACINGS.map((f) => f[0]), rows: CAST, poses: {} }
for (const pose of POSES) {
  await page.evaluate((p) => (window.__pose = p === 'attack' ? 'aim' : p), pose)
  await waitTicks(pose === 'walk' ? 5 : 12)
  if (pose === 'attack') {
    // Fire: the renderer reads a cooldown rise as the attack starting.
    await page.evaluate(() => {
      for (const e of window.__world.entities) if (e.kind === 'npc') e.combat.cooldown = (e.combat.cooldown ?? 0) + 40
    })
    await waitTicks(2)
  }
  const shot = join(OUT, `${LABEL}-${pose}-raw.png`)
  await page.screenshot({ path: shot })
  // Feet of every cell in screenshot px (CSS px x dpr), read off the live transform.
  const feet = await page.evaluate(
    (list) =>
      list.map((c) => {
        const e = window.__world.entities.find((x) => x.id === c.id)
        const p = window.__renderedProject(e.pos.x, e.pos.y + 0.5)
        return { id: c.id, row: c.row, col: c.col, x: p.x * 2, y: p.y * 2 }
      }),
    cells,
  )
  meta.poses[pose] = { raw: shot, feet }
}
writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify(meta, null, 1))
await browser.close()

execFileSync('python3', [join(__dirname, 'weapon_zoom_compose.py'), join(OUT, `${LABEL}.json`)], { stdio: 'inherit' })
