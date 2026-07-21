// Art-audit scene shots: load a fixture world into the live build, teleport the
// player through hand-picked tile situations (street, interior, grass, exit…),
// and screenshot each at a readable zoom. Used to evaluate theme art contrast
// (docs/genesis-upgrade.md). Not a pass/fail e2e — a camera rig.
//
//   THEME=swampspace-hires PREFIX=before node e2e/scene-shots.mjs
//
// Scenes can be overridden with SCENES='[{"label":"street","x":30,"y":40,"zoom":2}]'.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4891'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const THEME = process.env.THEME ?? 'swampspace-hires'
const PREFIX = process.env.PREFIX ?? 'scene'
const SIZE = { width: 1280, height: 720 }
mkdirSync(OUT, { recursive: true })

const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

// Default tour: overview + the situations the art audit cares about. x/y are
// tile coords in the combat-stage level (seed pinned by the fixture).
const DEFAULT_SCENES = [
  { label: 'overview', x: 10, y: 11, zoom: 0.5 },
  { label: 'park', x: 10, y: 11, zoom: 1.6 },
]
const SCENES = process.env.SCENES ? JSON.parse(process.env.SCENES) : DEFAULT_SCENES

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: SIZE })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

await page.goto(`${BASE}/?mode=solo&e2e=1&world=@inline&theme=${THEME}`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
await page.evaluate((j) => window.__loadWorld(j), base)
await page.waitForTimeout(1500) // theme art + first frames

for (const s of SCENES) {
  await page.evaluate(({ x, y }) => {
    const w = window.__world
    const p = w.entities.find((e) => e.playerCtl)
    p.pos = { x, y }
    p.prevPos = { x, y }
  }, s)
  await page.evaluate((z) => window.__zoom(z, true), s.zoom ?? 1.6)
  await page.waitForTimeout(700) // camera settle
  await page.screenshot({ path: join(OUT, `${PREFIX}-${THEME}-${s.label}.png`) })
  console.log(`shot ${PREFIX}-${THEME}-${s.label}.png`)
}

if (errs.length) console.error('page errors:', errs.join(' | '))
await browser.close()
