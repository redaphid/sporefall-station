// Backbuffer shader-FX proof: four deterministic videos through the REAL
// composite pipeline (window.__fx must report live+unfailed in every run):
//   1. grenade — showcase's staggered grenades: shockwave rings + kaleidoscopic
//      bloom cores (fractal pass) at ~tick 70/140/210;
//   2. shimmer — the fire-stage fixture: heat-haze displacement over every
//      burning cell while the row spreads;
//   3. trail — a max-stack machinegun build (power >= chroma tier) streaming
//      feedback echo trails behind every round;
//   4. portal — the player parked beside the level exit: idle kaliset glimmer
//      + feedback swirl breathing on the portal.
// Plus before/after stills: the same grenade tick rendered fx=off.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { record } from './lib.mjs'
import { recordFeature } from './record-feature.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')

/** Every run must prove the pipeline was genuinely composited, not fallen back. */
const fxAsserts = (s) => [
  !s.fx && 'window.__fx missing — pipeline introspection gone',
  s.fx && s.fx.mode !== 'full' && `pipeline mode ${s.fx.mode}, wanted full`,
  s.fx && !s.fx.active && 'pipeline INACTIVE — composite path fell back',
  s.fx && s.fx.failed && 'pipeline reports a shader/RTT failure',
]

// ---------------------------------------------------------------------------
// 1. Grenade shockwave + kaleidoscopic bloom (showcase scenario, 3 grenades).
// ---------------------------------------------------------------------------
// (record() directly — a ?world= fixture would REPLACE the scenario stage.)
await record({
  name: 'shaderfx-grenade',
  params: { mode: 'solo', e2e: '1', scenario: 'showcase', seed: 42, script: 'fxIdle', fx: 'full' },
  stills: [
    { tick: 60, label: '01-armed' },
    { tick: 72, label: '02-boom-shockwave' },
    { tick: 78, label: '03-ring-expanding' },
    { tick: 142, label: '04-boom2-bloom' },
    { tick: 212, label: '05-boom3' },
    { tick: 250, label: '06-aftermath' },
  ],
  readState: () => {
    const w = window.__world
    return {
      tick: w.tick,
      fx: { ...window.__fx },
      grenades: w.entities.filter((e) => e.archetype === 'grenade' && !e.dead).length,
    }
  },
  expect: (s) =>
    [
      ...fxAsserts(s),
      s.tick < 260 && `run ended early at tick ${s.tick}`,
      s.grenades !== 0 && `${s.grenades} grenade(s) never exploded — no shockwaves to show`,
    ].filter(Boolean),
})

// ---------------------------------------------------------------------------
// 2. Incendiary heat shimmer over the fire-stage burn row.
// ---------------------------------------------------------------------------
await recordFeature({
  name: 'shaderfx-shimmer',
  world: 'fire-stage',
  script: 'burn',
  params: { fx: 'full' },
  stills: [
    { tick: 20, label: '01-ignition' },
    {
      tick: 80,
      label: '02-heat-haze',
      // Pin the mid-run fire-cell count where the shimmer prims must be live.
      act: async (page) => {
        await page.evaluate(() => {
          window.__firesMid = window.__world.entities.filter((e) => e.kind === 'fire' && !e.dead).length
        })
      },
    },
    { tick: 150, label: '03-burn-down' },
  ],
  readState: () => ({
    tick: window.__world.tick,
    fx: { ...window.__fx },
    firesMid: window.__firesMid ?? 0,
  }),
  expect: (s) => [
    ...fxAsserts(s),
    !(s.firesMid > 0) && 'no live fire cells at tick 80 — nothing was shimmering',
  ],
})

// ---------------------------------------------------------------------------
// 3. Feedback trail on a max-stack bullet stream (combat-stage + monster build).
// ---------------------------------------------------------------------------
const combat = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
{
  const w = JSON.parse(JSON.stringify(combat))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = 'machinegun'
  p.playerCtl.inventory = [
    {
      itemId: 'machinegun',
      qty: 99,
      mods: [
        { id: 'glassCannon', stacks: 2 },
        { id: 'velocity', stacks: 3 },
        { id: 'homing', stacks: 3 },
        { id: 'shock', stacks: 1 },
      ],
    },
  ]
  p.playerCtl.activeSlot = 0
  await recordFeature({
    name: 'shaderfx-trail',
    world: w,
    script: 'shooting',
    params: { fx: 'full', zoom: 2 },
    stills: [
      { tick: 250, label: '01-opening-fire' },
      {
        tick: 290,
        label: '02-stream-trails',
        // Pin the in-flight modded stream while the trail is on screen (the
        // thugs are usually dead+swept by the end, so assert mid-run).
        act: async (page) => {
          await page.evaluate(() => {
            window.__moddedShotsMid = window.__world.entities.filter(
              (e) => e.kind === 'projectile' && e.projectile?.mods?.length && !e.dead,
            ).length
          })
        },
      },
      { tick: 330, label: '03-echo' },
    ],
    readState: () => ({
      tick: window.__world.tick,
      fx: { ...window.__fx },
      moddedShotsMid: window.__moddedShotsMid ?? 0,
      thugsAlive: window.__world.entities.filter((e) => e.archetype === 'thug' && !e.dead).length,
    }),
    expect: (s) => [
      ...fxAsserts(s),
      !(s.moddedShotsMid > 0) && 'no max-stack rounds in flight at tick 290 — nothing was trailing',
      s.thugsAlive >= 3 && 'the stream hit nothing — all three thugs still standing',
    ],
  })
}

// ---------------------------------------------------------------------------
// 4. Exit-portal idle: serialize the booted world, park the player beside the
//    exit tile, and watch the kaliset glimmer + feedback swirl breathe.
// ---------------------------------------------------------------------------
{
  // Phase 1: read the level's exit + a lossless world snapshot off a real boot.
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`${BASE}/?mode=solo&e2e=1&seed=42`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => (window.__world?.tick ?? 0) > 2, { timeout: 20000 })
  const grabbed = await page.evaluate(() => ({
    json: window.backseat.serialize(),
    exit: window.__world.level.exit,
  }))
  await browser.close()

  // Phase 2: replay that exact world with the player parked NEXT to the exit
  // (not on it — stepping on the tile would change floors mid-video).
  const world = JSON.parse(grabbed.json)
  const player = world.entities.find((e) => e.playerCtl)
  player.pos = { x: grabbed.exit.x + 0.5, y: grabbed.exit.y + 2.2 }
  player.prevPos = { ...player.pos }
  const floorBefore = world.floor

  await recordFeature({
    name: 'shaderfx-portal',
    world,
    script: 'fxIdle',
    params: { fx: 'full' },
    stills: [
      { tick: 30, label: '01-portal' },
      { tick: 130, label: '02-swirl' },
      { tick: 240, label: '03-breathing' },
    ],
    readState: () => ({
      tick: window.__world.tick,
      fx: { ...window.__fx },
      floor: window.__world.floor,
      px: window.__world.entities.find((e) => e.playerCtl)?.pos ?? null,
    }),
    expect: (s) => [
      ...fxAsserts(s),
      s.floor !== floorBefore && `floor changed ${floorBefore} -> ${s.floor} — player fell into the exit`,
      s.px &&
        Math.hypot(s.px.x - player.pos.x, s.px.y - player.pos.y) > 0.5 &&
        'player wandered off the portal frame',
    ],
  })
}

// ---------------------------------------------------------------------------
// Before/after still: the SAME showcase boom tick with the pipeline OFF.
// ---------------------------------------------------------------------------
{
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${BASE}/?mode=solo&e2e=1&seed=42&scenario=showcase&script=fxIdle&fx=off`, {
    waitUntil: 'networkidle',
  })
  const tick = () => page.evaluate(() => window.__world?.tick ?? 0)
  while ((await tick()) < 72) await page.waitForTimeout(40)
  await page.screenshot({ path: join(OUT, 'shaderfx-grenade-02-boom-shockwave-OFF.png') })
  const fx = await page.evaluate(() => ({ ...window.__fx }))
  await browser.close()
  if (fx.mode !== 'off' || fx.active) {
    console.error(`[shaderfx-off-still] FAIL: fx=${JSON.stringify(fx)} — off mode not honoured`)
    process.exitCode = 1
  } else if (errs.length) {
    console.error(`[shaderfx-off-still] FAIL: ${errs.join(' | ')}`)
    process.exitCode = 1
  } else {
    console.log('[shaderfx-off-still] OK — fx=off control still captured')
  }
  const SHARE = process.env.E2E_SHARE ?? ''
  if (SHARE) {
    const { cpSync } = await import('node:fs')
    cpSync(join(OUT, 'shaderfx-grenade-02-boom-shockwave-OFF.png'), join(SHARE, 'shaderfx-grenade-02-boom-shockwave-OFF.png'))
  }
}
