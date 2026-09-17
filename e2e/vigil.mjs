// @ts-check
// §4.1 THE VIGIL proof: drive the `vigil` scenario + script in a real browser
// and assert the whole fight from LIVE world state — it is VULNERABLE while
// dormant and being hit does not wake it; being LOUD does, and awake it is
// near-immune; backing off lets it SETTLE; and each wake outlasts the last.
//
// WHY THIS ONE NEEDS A VIDEO MORE THAN MOST. The Vigil's verb is invisible:
// nothing on screen moves differently when the fight is going right, because
// the fight going right IS the boss not moving. So the recording narrates
// itself off the sim's own numbers — the meter annotation `systems/vigil.ts`
// pins to the boss, plus a banner this driver rewrites each poll with the live
// state and the damage the last beat actually did.
//
// Every assertion reads `window.__world`. Nothing here trusts a screenshot.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { muxVideo, OUT } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4943'
const VIDEO_DIR = join(OUT, 'video-vigil')
const SEED = process.env.E2E_SEED ?? '20260916'
const SIZE = { width: 1280, height: 720 }

// MUST MATCH `SCRIPTS.vigil` in src/input/scripted.ts — the beat boundaries the
// damage comparison is taken across. Mirrored rather than imported because this
// file is plain .mjs and the timeline is TypeScript; src/game/vigilShowcase.test.ts
// asserts the same beats against the real array, so a drift between the two
// fails there.
const SEGMENTS = [40, 26, 90, 1, 34, 90, 60, 60, 1, 30, 60, 280, 40]
const at = (n) => SEGMENTS.slice(0, n).reduce((a, b) => a + b, 0)
const BEAT1 = { from: at(2), to: at(3) } // knife vs a DORMANT boss
const BEAT2 = { from: at(5), to: at(6) } // the same knife vs an AWAKE boss
const GRENADE1 = at(3)
const TOTAL = at(SEGMENTS.length)

// systems/vigil.ts — the numbers the fight runs on, pinned so a retune that
// silently changes the story fails the recording too.
const WAKE_TICKS = [150, 300]
const ASLEEP_RESIST = 1.5
const AWAKE_RESIST = 0.15

mkdirSync(OUT, { recursive: true })
rmSync(VIDEO_DIR, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[vigil ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

/** One sample of everything this proof reasons about, straight off the world. */
const readState = (page) =>
  page.evaluate(() => {
    const w = window.__world
    const boss = w.entities.find((e) => e.ai && e.ai.behavior === 'vigil')
    const player = w.entities.find((e) => e.playerCtl)
    if (!boss) return { tick: w.tick, boss: null, player: null, meter: null, revealed: !!w.mission.bossRevealed }
    const meter = w.annotations.find((a) => a.id === `vigil:${boss.id}`)
    return {
      tick: w.tick,
      revealed: !!w.mission.bossRevealed,
      boss: {
        id: boss.id,
        hp: boss.health.hp,
        max: boss.health.max,
        dead: !!boss.dead,
        dormant: !!boss.ai.dormant,
        awake: boss.ai.wakeUntil !== undefined,
        wakes: boss.ai.wakes ?? 0,
        noise: boss.ai.noise ?? 0,
        resist: boss.resist ? boss.resist.physical : null,
        x: boss.pos.x,
        y: boss.pos.y,
      },
      player: player ? { id: player.id, x: player.pos.x, y: player.pos.y, hp: player.health.hp } : null,
      meter: meter ? meter.text : null,
    }
  })

/** The banner, rewritten each poll. Cleared BY ID: a blanket clearAnnotations
 * would delete the Vigil's own meter (it lives in `w.annotations` like any
 * other), and the sim would re-add it a tick later — a flicker on the video
 * exactly where the viewer is supposed to be reading it. */
const narrate = async (page, text, color) => {
  await page.evaluate(
    ([t, c]) => {
      window.__verb('clearAnnotations vigil-banner')
      window.__verb(`annotate ${JSON.stringify({ id: 'vigil-banner', kind: 'text', x: 16, y: 20, text: t, color: c })}`)
    },
    [text, color],
  )
}

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: VIDEO_DIR, size: SIZE } })
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    pageErrors.push(String(e))
    log('PAGE ERROR:', String(e))
  })
  page.on('console', (m) => m.type() === 'error' && log('console.error:', m.text()))

  // `commit`, NOT `domcontentloaded`. The bundle registers a service worker
  // (src/app/pwa.ts), and with one installed playwright's DCL lifecycle wait can
  // simply never resolve. Measured on this branch: `goto` timed out at 90s while
  // the page underneath reached `document.readyState === 'complete'` in ~2s and
  // had a live world in ~6s, with zero page errors and zero failed requests.
  //
  // Waiting on `commit` and then on the app's OWN readiness hook is the better
  // contract regardless: `__world`/`__verb` is what this driver actually needs,
  // and a lifecycle event was only ever a proxy for it.
  await page.goto(`${BASE}/?mode=solo&scenario=vigil&script=vigil&e2e=1&seed=${SEED}&zoom=1`, {
    waitUntil: 'commit',
  })
  // NB the THIRD argument. The signature is `waitForFunction(fn, arg, options)`,
  // so passing the options object SECOND makes it the page-function arg and
  // silently leaves the timeout at its 30s default — which is exactly how this
  // first failed. Boot needs longer than 30s under `recordVideo`, because the
  // screencast sits on top of software WebGL here (chromium logs "GPU stall due
  // to ReadPixels"); the same boot measured ~6s with video capture off.
  const bootStart = Date.now()
  await page.waitForFunction(() => !!window.__world && !!window.__verb, undefined, { timeout: 180000 })
  log(`world ready after ${((Date.now() - bootStart) / 1000).toFixed(1)}s`)

  const saw = {
    revealedEarly: false,
    dormantAtStart: false,
    hpAt: new Map(), // tick -> hp, sampled every poll
    wokeDuringBeat1: false,
    damagedDuringBeat1: false,
    wakes: [], // tick of each dormant→awake transition
    settles: [], // tick of each awake→dormant transition
    resistAsleep: new Set(),
    resistAwake: new Set(),
    meterAsleep: false,
    meterFilling: false,
    meterAwake: false,
    noisePeak: 0,
    maxWakes: 0,
  }
  let wasAwake = false
  let shot = 0
  const screenshot = async (label) => {
    shot += 1
    const name = `vigil-${String(shot).padStart(2, '0')}-${label}.png`
    await page.screenshot({ path: join(OUT, name) })
    log('screenshot', name)
  }
  const SHOTS = [
    [30, 'dormant-and-revealed'],
    [at(3) - 5, 'knifing-it-in-its-sleep'],
    [at(5) - 2, 'the-grenade-wakes-it'],
    [at(6) - 5, 'the-same-knife-bounces-off'],
    [at(8) - 5, 'backed-off-and-settled'],
    [at(10) + 10, 'woken-a-second-time'],
    [TOTAL - 10, 'settled-again-after-a-longer-wake'],
  ]
  let nextShot = 0

  let tick = 0
  while (tick < TOTAL) {
    const s = await readState(page)
    tick = s.tick
    if (!s.boss) {
      failures.push('no Vigil on stage')
      break
    }
    saw.hpAt.set(tick, s.boss.hp)
    saw.maxWakes = Math.max(saw.maxWakes, s.boss.wakes)
    saw.noisePeak = Math.max(saw.noisePeak, s.boss.noise)
    if (s.revealed && tick < 30) saw.revealedEarly = true
    if (s.boss.dormant && tick < 30) saw.dormantAtStart = true
    if (s.boss.awake) saw.resistAwake.add(s.boss.resist)
    else saw.resistAsleep.add(s.boss.resist)
    if (s.boss.awake && !wasAwake) saw.wakes.push(tick)
    if (!s.boss.awake && wasAwake) saw.settles.push(tick)
    wasAwake = s.boss.awake
    if (tick <= BEAT1.to && s.boss.awake) saw.wokeDuringBeat1 = true
    if (tick <= BEAT1.to && s.boss.hp < s.boss.max) saw.damagedDuringBeat1 = true
    if (s.meter && s.meter.includes('ASLEEP')) saw.meterAsleep = true
    if (s.meter && s.meter.includes('|')) saw.meterFilling = true
    if (s.meter && s.meter.includes('AWAKE')) saw.meterAwake = true

    // Narrate the verb: what it is doing, and what that is costing the player.
    const pct = ((s.boss.hp / s.boss.max) * 100).toFixed(0)
    const banner = s.boss.awake
      ? `AWAKE (wake #${s.boss.wakes}, ${WAKE_TICKS[s.boss.wakes - 1] ?? WAKE_TICKS[WAKE_TICKS.length - 1]} ticks) — resist ${s.boss.resist} — BACK OFF · hp ${pct}%`
      : `DORMANT — resist ${s.boss.resist} (soft!) — noise ${s.boss.noise.toFixed(1)} · hp ${pct}%`
    await narrate(page, `THE VIGIL: be quiet. ${banner}`, s.boss.awake ? '#ff7043' : '#4e7d8c')

    if (nextShot < SHOTS.length && tick >= SHOTS[nextShot][0]) {
      await screenshot(SHOTS[nextShot][1])
      nextShot++
    }
    await sleep(100)
  }
  await sleep(400)

  // Damage across the two equal-length knife beats: the resist swap, measured.
  const hpNear = (t) => {
    let best
    let bestD = Infinity
    for (const [k, v] of saw.hpAt) {
      const d = Math.abs(k - t)
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    return best
  }
  const beat1Damage = hpNear(BEAT1.from) - hpNear(BEAT1.to)
  const beat2Damage = hpNear(BEAT2.from) - hpNear(BEAT2.to)
  log('beat damage — dormant:', beat1Damage, 'awake:', beat2Damage)
  log('wakes at', saw.wakes, 'settles at', saw.settles, 'noise peak', saw.noisePeak.toFixed(1))

  check(saw.revealedEarly, 'the Vigil announced itself on sight (the entrance fired)')
  check(saw.dormantAtStart, 'it starts DORMANT — the fight opens with it asleep')
  check(saw.damagedDuringBeat1, 'the knife really hurt it while it slept')
  check(beat1Damage > 0, `damage landed on the dormant boss (${beat1Damage} hp)`)
  check(!saw.wokeDuringBeat1, 'being hit that hard did NOT wake it — damage is silent to it')
  check(saw.wakes.length >= 1, 'the GRENADE woke it — loudness, not injury')
  check(saw.wakes.length >= 1 && saw.wakes[0] > GRENADE1, `it woke AFTER the grenade (tick ${saw.wakes[0]}, grenade ${GRENADE1})`)
  check(saw.noisePeak > 0, `the noise meter visibly filled (peak ${saw.noisePeak.toFixed(1)})`)
  check(beat2Damage >= 0 && beat1Damage > beat2Damage * 5, `awake it is near-immune: ${beat1Damage} hp asleep vs ${beat2Damage} awake`)
  check([...saw.resistAsleep].every((r) => r === ASLEEP_RESIST), `dormant resist is ${ASLEEP_RESIST} (saw ${[...saw.resistAsleep]})`)
  check(
    saw.resistAwake.size > 0 && [...saw.resistAwake].every((r) => r === AWAKE_RESIST),
    `awake resist is ${AWAKE_RESIST} (saw ${[...saw.resistAwake]})`,
  )
  check(saw.settles.length >= 1, 'backing off and going quiet SETTLED it back to dormant')
  if (saw.settles.length >= 1) {
    const first = saw.settles[0] - saw.wakes[0]
    check(Math.abs(first - WAKE_TICKS[0]) <= 8, `the first wake ran ~${WAKE_TICKS[0]} ticks (measured ${first})`)
  }
  check(saw.wakes.length >= 2, 'a second noise woke it again')
  if (saw.wakes.length >= 2 && saw.settles.length >= 2) {
    const first = saw.settles[0] - saw.wakes[0]
    const second = saw.settles[1] - saw.wakes[1]
    check(second > first, `EACH WAKE IS LONGER THAN THE LAST (${first} → ${second} ticks)`)
    check(Math.abs(second - WAKE_TICKS[1]) <= 8, `the second wake ran ~${WAKE_TICKS[1]} ticks (measured ${second})`)
  }
  check(saw.meterAsleep, 'the pinned meter read ASLEEP on screen')
  check(saw.meterFilling, 'the meter was seen FILLING as the room got loud')
  check(saw.meterAwake, 'the meter read AWAKE — BACK OFF once it was up')
  check(pageErrors.length === 0, 'zero page errors')

  await page.close()
  await context.close()
  await browser.close()

  const { video, format, bytes, note } = muxVideo('vigil', VIDEO_DIR)
  if (note) log('NOTE:', note)
  log('video ->', video, `(${(bytes / 1024).toFixed(0)} KB, ${format})`)
  if (bytes < 100_000) failures.push(`video only ${bytes} bytes`)

  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: vulnerable asleep · loud wakes it · quiet settles it · each wake longer — all verified live')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
