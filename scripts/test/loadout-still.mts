// Renders the REAL loadout panel (src/ui/loadoutPanel.ts) driven by the REAL
// view model (buildLoadout) into the pause and death overlays, then screenshots
// both with Playwright. Visual proof for the loadout-panel feature — no pixi, so
// the weapon art falls back to its glyph (exactly as headless does in-app).
import { Window } from 'happy-dom'
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// happy-dom global document so the DOM-building UI modules work in node.
const win = new Window()
;(globalThis as unknown as { document: unknown; window: unknown }).document = win.document
;(globalThis as unknown as { window: unknown }).window = win

const { buildLoadout } = await import('../../src/ui/loadoutModel.ts')
const { createLoadoutPanel } = await import('../../src/ui/loadoutPanel.ts')
import type { Entity } from '../../src/game/entity.ts'

const player = (weaponId: string, mods?: { id: string; stacks: number }[]): Entity =>
  ({
    id: 1, kind: 'player', archetype: 'player',
    pos: { x: 0, y: 0 }, prevPos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, intent: { x: 0, y: 0 },
    speed: 4, radius: 0.4, facing: 0,
    combat: { weapon: weaponId, cooldown: 0 },
    playerCtl: {
      playerId: 0, abilityCooldown: 0, cash: 240, crimeUntilTick: 0, activeSlot: 0,
      inventory: [{ itemId: weaponId, qty: 8, ...(mods ? { mods } : {}) }],
    },
  }) as Entity

// A juicy build: shotgun with a spread of stat + behavior + element mods.
const hero = player('shotgun', [
  { id: 'overload', stacks: 2 },
  { id: 'incendiary', stacks: 1 },
  { id: 'pierce', stacks: 3 },
  { id: 'homing', stacks: 1 },
  { id: 'lifesteal', stacks: 2 },
])

const panelHtml = (e: Entity): string => {
  const p = createLoadoutPanel()
  p.update(buildLoadout(e))
  return (p.el as unknown as { outerHTML: string }).outerHTML
}

// Death overlay (mirrors screens.ts) + pause overlay (mirrors main.ts) side by side.
const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;background:#0b0b12;font-family:system-ui;
   display:flex;gap:0;flex-wrap:wrap}
  .screen{position:relative;width:430px;height:820px;overflow:hidden;border-right:1px solid #222}
  .bg{position:absolute;inset:0;background:
    radial-gradient(120% 80% at 50% 0%, #1a2418, #0b0b12 60%)}
  .overlay{position:absolute;inset:0;background:#000a;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:14px;color:#eee;text-align:center;padding:20px}
  .headline{font:800 34px system-ui;color:#e0483f}
  .pauseTitle{font:800 40px system-ui;color:#fff;letter-spacing:6px;text-shadow:0 2px 8px #000}
  .stats{color:#cfcfd6;font:14px system-ui}
  .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  button.primary{font:600 16px system-ui;padding:10px 24px;border-radius:8px;border:0;background:#7fd17f;color:#0b0b12}
  button.ghost{font:600 16px system-ui;padding:10px 24px;border-radius:8px;border:1px solid #ffd76a;background:#1b1e28;color:#ffd76a}
</style></head><body>
  <div class="screen"><div class="bg"></div>
    <div class="overlay">
      <div class="headline">YOU DIED</div>
      <div class="stats">Made it to floor 3 · $240 collected</div>
      ${panelHtml(hero)}
      <div class="row"><button class="primary">Run it back</button><button class="ghost">🎲 New Seed</button></div>
    </div>
  </div>
  <div class="screen"><div class="bg"></div>
    <div class="overlay">
      <div class="pauseTitle">PAUSED</div>
      ${panelHtml(hero)}
      <div class="row"><button class="primary">Resume</button><button class="ghost">🎲 New Seed</button><button class="ghost">Run it back</button></div>
    </div>
  </div>
</body></html>`

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../../docs/assets/loadout-panel')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 861, height: 820 }, deviceScaleFactor: 2 })
await page.setContent(doc, { waitUntil: 'load' })
await page.screenshot({ path: resolve(outDir, 'both-screens.png') })
// Individual crops too.
const shots = await page.$$('.screen')
await shots[0].screenshot({ path: resolve(outDir, 'death-screen.png') })
await shots[1].screenshot({ path: resolve(outDir, 'pause-screen.png') })

// Expanded detail: drop the panel's scroll cap so the Effects badges (pierce/
// homing/lifesteal/element) show in full for the proof.
await page.evaluate(() => {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
    if (el.style.maxHeight) {
      el.style.maxHeight = 'none'
      el.style.overflowY = 'visible'
    }
  }
})
await shots[0].screenshot({ path: resolve(outDir, 'death-screen-full.png') })
writeFileSync(resolve(outDir, 'preview.html'), doc)
await browser.close()
console.log('wrote docs/assets/loadout-panel/{both-screens,death-screen,pause-screen}.png + preview.html')
