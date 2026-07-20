// feat/sprite-animation — ANIMATION STATES showcase video (exact world + real systems).
//
// One deterministic run cycles a character through every animation state:
//   idle (breathe) → walk (lean+bob) → attack (pistol lunge; the thug flinches
//   HURT then topples as a DEATH ghost) → the player takes a bullet (HURT
//   flinch) → dodge ROLL (tumble + landing squash) → idle again.
//
// Evidence: an asserted mp4 (record() harness) plus PRECISION stills — the sim
// pauses (HostSession.isPaused) at each target tick on a fresh page load, so a
// 6-tick state can be captured exactly even though screenshots lag under video
// recording. Same URL + inline world + ?script ⇒ every load replays the
// identical timeline (determinism is the whole point).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { recordFeature } from './record-feature.mjs'
import { BASE, OUT } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))

/** combat-stage reduced to the anim stage: player parked on the lane at x6
 * facing east, ONE guard thug at x12 (2 pistol shots = death), and a slow
 * bullet crawling in from the WEST that stings the player at ~tick 138. */
const stage = () => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.pos = { x: 6, y: 11 }
  p.prevPos = { x: 6, y: 11 }
  p.facing = 0
  p.health.hp = p.health.max
  const thug = w.entities.find((e) => e.archetype === 'thug') // the x=12 guard
  const sting = {
    id: w.nextId,
    kind: 'projectile',
    archetype: 'projectile',
    pos: { x: 1.6, y: 11 },
    prevPos: { x: 1.6, y: 11 },
    vel: { x: 1.5, y: 0 },
    intent: { x: 0, y: 0 },
    speed: 0,
    radius: 0.15,
    facing: 0,
    projectile: { ownerId: 999, damage: 14, ttl: 400 },
  }
  w.nextId += 1
  w.entities = [p, thug, sting]
  return w
}

const readState = () => {
  const w = window.__world
  const pl = w.entities.find((e) => e.playerCtl)
  return {
    tick: w.tick,
    playerHp: pl?.health?.hp ?? null,
    playerMax: pl?.health?.max ?? null,
    playerX: pl?.pos.x ?? null,
    playerDowned: !!pl?.playerCtl?.downed,
    thugs: w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length,
    projectiles: w.entities.filter((e) => e.kind === 'projectile' && !e.dead).length,
  }
}

// --- 1) The asserted feature video -----------------------------------------
const ok = await recordFeature({
  name: 'anim-states',
  world: stage(),
  script: 'animStates',
  stills: [
    { tick: 15, label: 'video-01-idle' },
    { tick: 100, label: 'video-02-thug-down' },
    { tick: 150, label: 'video-03-player-hurt' },
    { tick: 240, label: 'video-04-rolled' },
  ],
  readState,
  expect: (s) => [
    s.thugs !== 0 && `thug survived the attack phase (${s.thugs} left) — no death state shown`,
    s.playerHp >= s.playerMax && `west bullet never landed (hp ${s.playerHp}/${s.playerMax}) — no hurt state shown`,
    s.playerHp <= 0 && 'player died — the sting was supposed to be survivable',
    s.playerDowned && 'player went down',
    s.playerX !== null && s.playerX < 11.5 && `roll burst missing (x=${s.playerX}) — expected the tumble to carry past 11.5`,
  ],
})

// --- 2) Precision stills: pause the sim AT the state, then shoot ------------
// Fresh page per still (pausing consumes scripted input, so never resume).
const STILLS = [
  { tick: 15, label: 'idle' },
  { tick: 42, label: 'walk' },
  { tick: 83, label: 'attack-lunge' },
  { tick: 91, label: 'npc-hurt' },
  { tick: 110, label: 'npc-death-fall' },
  { tick: 143, label: 'player-hurt' },
  { tick: 226, label: 'roll-tumble' },
  { tick: 233, label: 'roll-land-squash' },
  { tick: 272, label: 'idle-again' },
]

const stillErrors = []
const params = new URLSearchParams({ mode: 'solo', e2e: '1', world: '@inline', script: 'animStates' })
const url = `${BASE}/?${params}`
const browser = await chromium.launch({ headless: true })

for (const s of STILLS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (e) => stillErrors.push(`${s.label}: ${e}`))
  try {
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
    await page.evaluate((j) => window.__loadWorld(j), stage())
    // Freeze EXACTLY at the target tick, in-page (no Node roundtrip latency):
    // wrap session.tick to become a no-op once the world reaches the tick.
    // The render loop keeps drawing the frozen tick — a razor-sharp still of a
    // 6-tick state. (Never resumed; each still gets its own page load.)
    await page.waitForFunction(() => window.__sporefall !== undefined, { timeout: 20000 })
    await page.evaluate((t) => {
      const sporefall = window.__sporefall
      const orig = sporefall.tick.bind(sporefall)
      sporefall.tick = () => {
        if (window.__world.tick >= t) return
        orig()
      }
    }, s.tick)
    await page.waitForFunction((t) => (window.__world?.tick ?? 0) >= t, s.tick, { timeout: 30000 })
    const frozen = await page.evaluate(() => window.__world.tick)
    await page.waitForTimeout(120) // let the frozen frame render
    await page.screenshot({ path: join(OUT, `anim-states-${s.label}.png`) })
    console.log(`[anim-states] still ${s.label} @ tick ${frozen} (target ${s.tick})`)
    if (frozen !== s.tick) stillErrors.push(`${s.label}: froze at ${frozen}, target ${s.tick}`)
  } catch (err) {
    stillErrors.push(`${s.label}: ${err}`)
  } finally {
    await page.close()
  }
}
await browser.close()

if (stillErrors.length) {
  for (const e of stillErrors) console.error(`[anim-states] STILL FAIL: ${e}`)
  process.exitCode = 1
} else {
  console.log('[anim-states] all precision stills captured')
}
if (!ok) process.exitCode = 1
