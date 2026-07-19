// Procedural bullet visuals — the still gallery. One deterministic screenshot
// per SINGLE mod (all 17), several signature 2–3 mod combos, the max-stack
// monster, and the vanilla control. No video: each loadout boots the real pixi
// build with the combat-stage world injected inline, replays the `shooting`
// timeline, and snaps mid-stream at fixed SIM ticks (zoom 3 so the composed
// bullet look reads at a glance). Fails if any page errors or a still is tiny.
import { chromium } from 'playwright'
import { readFileSync, mkdirSync, statSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

const armed = (mods) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = 'machinegun'
  p.playerCtl.inventory = [{ itemId: 'machinegun', qty: 99, ...(mods ? { mods } : {}) }]
  p.playerCtl.activeSlot = 0
  return w
}

const SINGLES = [
  'overload', 'bulk', 'rapid', 'heavy', 'choke', 'velocity', 'glassCannon',
  'frost', 'incendiary', 'shock', 'bounce', 'pierce', 'homing', 'explosive',
  'split', 'lifesteal', 'detonator',
]

const loadouts = [
  { name: 'mod-vanilla', mods: undefined, ticks: [285] },
  ...SINGLES.map((id) => ({ name: `mod-${id}`, mods: [{ id, stacks: 3 }], ticks: [285] })),
  {
    name: 'combo-cryo-lance',
    mods: [{ id: 'frost', stacks: 1 }, { id: 'pierce', stacks: 3 }, { id: 'velocity', stacks: 2 }],
    ticks: [270, 320],
  },
  {
    name: 'combo-tesla-splinter',
    mods: [{ id: 'shock', stacks: 1 }, { id: 'split', stacks: 3 }, { id: 'bounce', stacks: 2 }],
    ticks: [270, 320],
  },
  {
    name: 'combo-prism-seeker',
    mods: [{ id: 'glassCannon', stacks: 2 }, { id: 'homing', stacks: 3 }],
    ticks: [270, 320],
  },
  {
    name: 'combo-vampire-payload',
    mods: [{ id: 'lifesteal', stacks: 3 }, { id: 'detonator', stacks: 2 }, { id: 'incendiary', stacks: 1 }],
    ticks: [270, 320],
  },
  {
    name: 'monster-maxstack',
    mods: SINGLES.map((id) => ({ id, stacks: 5 })),
    ticks: [255, 285, 320],
  },
]

mkdirSync(OUT, { recursive: true })
if (SHARE) mkdirSync(SHARE, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
let failures = 0

for (const lo of loadouts) {
  const page = await context.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))
  const params = new URLSearchParams({ mode: 'solo', e2e: '1', world: '@inline', script: 'shooting', zoom: 3 })
  await page.goto(`${BASE}/?${params}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate((j) => window.__loadWorld(j), armed(lo.mods))
  const tickOf = () => page.evaluate(() => window.__world?.tick ?? 0)
  for (const t of lo.ticks) {
    while ((await tickOf()) < t) await page.waitForTimeout(30)
    const name = `bullet-${lo.name}${lo.ticks.length > 1 ? `-t${t}` : ''}.png`
    const path = join(OUT, name)
    await page.screenshot({ path })
    const bytes = statSync(path).size
    if (bytes < 30_000) {
      console.error(`[shots] FAIL: ${name} only ${bytes} bytes`)
      failures++
    } else {
      console.log(`[shots] ${name} (${(bytes / 1024) | 0} KB)`)
    }
    if (SHARE) cpSync(path, join(SHARE, name))
  }
  if (errs.length) {
    console.error(`[shots] FAIL ${lo.name}: page errors: ${errs.join(' | ')}`)
    failures++
  }
  await page.close()
}

await context.close()
await browser.close()
if (failures) {
  console.error(`[shots] ${failures} failures`)
  process.exitCode = 1
} else {
  console.log(`[shots] OK — ${loadouts.length} loadouts captured`)
}
