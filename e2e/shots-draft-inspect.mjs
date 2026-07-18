// #53 — still captures for the DRAFT SCREEN and the tap-INSPECT card showing a
// build. Boots the real bundle with a modded shotgun injected (?world=@inline),
// shows the deterministic pick-1-of-3 draft, applies a pick, then selects the
// player so the overlay renders the inspect card listing the gun's mods.
import { chromium } from 'playwright'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SHARE = process.env.E2E_SHARE ?? ''

const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const w = JSON.parse(JSON.stringify(base))
const p = w.entities.find((e) => e.playerCtl)
p.combat.weapon = 'shotgun'
p.playerCtl.inventory = [{ itemId: 'shotgun', qty: 99, mods: [{ id: 'bulk', stacks: 2 }, { id: 'bounce', stacks: 1 }, { id: 'frost', stacks: 1 }, { id: 'lifesteal', stacks: 2 }] }]
p.playerCtl.activeSlot = 0
const pid = p.id

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))

await page.goto(`${BASE}/?e2e=1&mode=solo&world=@inline&seed=7&zoom=2`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
await page.evaluate((j) => window.__loadWorld(j), w)
// boot only defines the e2e hooks AFTER the @inline world injection unblocks it.
await page.waitForFunction(() => typeof window.__draftShow === 'function', { timeout: 20000 })
await page.waitForTimeout(400)

// --- 1) the draft screen (deterministic pick-1-of-3) ---
const offer = JSON.parse(await page.evaluate(() => window.__draftShow(1)))
await page.waitForTimeout(400)
await page.screenshot({ path: join(OUT, 'sig-draft-screen.png') })

// pick the first offered card (headless), then close the screen
await page.evaluate((id) => window.__draftPick(id), offer[0])
await page.waitForTimeout(300)

// --- 2) the tap-inspect card showing the build ---
await page.evaluate((id) => window.__verb(`set ${id} {"selected":true}`), pid)
await page.waitForTimeout(500)
await page.screenshot({ path: join(OUT, 'sig-inspect-card.png') })

const modsAfter = JSON.parse(await page.evaluate((id) => window.__verb(`get ${id}`), pid)).playerCtl.inventory[0].mods
await page.close()
await ctx.close()
await browser.close()

const fail = []
if (offer.length !== 3) fail.push(`offer size ${offer.length} (want 3)`)
if (!modsAfter.some((m) => m.id === offer[0])) fail.push(`pick "${offer[0]}" not applied`)
if (errs.length) fail.push(`page errors: ${errs.join(' | ')}`)

if (SHARE) {
  mkdirSync(SHARE, { recursive: true })
  for (const f of ['sig-draft-screen.png', 'sig-inspect-card.png']) cpSync(join(OUT, f), join(SHARE, f))
}
console.log('[draft/inspect] offer:', offer, '| mods after pick:', JSON.stringify(modsAfter))
if (fail.length) {
  for (const f of fail) console.error('[draft/inspect] FAIL:', f)
  process.exitCode = 1
} else {
  console.log('[draft/inspect] OK')
}
