// @ts-check
// §4.2 Echo proof: drive the `echo-adapt` scenario + script in a real browser and
// assert the adaptive resist map actually behaves, live, from world state.
//
// The three beats the script plays, and what each one has to show:
//   1. SUSTAINED FIRE  — `resist.physical` falls (it learns; damage drops off).
//   2. THE LULL        — it climbs back (it forgets; backing off buys you it).
//   3. FIRE AGAIN      — the gun lands hard again (the loop is the fight).
//
// It also verifies THE HAZARD live, in a real browser, on a boss that has spent
// the whole clip adapting: `resist.frozen` must read exactly 0 at every single
// sample, and an `electrified` key must never appear. That is the freeze-shatter
// instant-kill the foundation branch closed, and an adaptive resist map is the
// one thing in the game that could re-open it by accident.
//
// Uses the SHARED recorder (`record()` in lib.mjs), which owns the webm→mp4 mux —
// deliberately not a local copy of the ffmpeg call.
//
// `record()` reads state once, at the end, so the per-beat numbers are gathered
// by an in-page sampler installed in `beforeTicks` and reduced in `readState`.
import { record } from './lib.mjs'

const SEED = process.env.E2E_SEED ?? '20260916'

// Script beat boundaries, in SIM TICKS — must match SCRIPTS['echo-adapt'].
const FIRE1 = [40, 340]
const LULL = [400, 760]
const FIRE2 = [760, 1000]

const ok = await record({
  name: 'echo-adapt',
  params: { mode: 'solo', scenario: 'echo-adapt', script: 'echo-adapt', e2e: '1', seed: SEED, zoom: '1' },

  // Install a per-frame sampler of the boss's live resist map before tick 0, so
  // the whole curve is captured rather than just its endpoint.
  beforeTicks: async (page) => {
    await page.waitForFunction(() => !!window.__world, { timeout: 20000 })
    await page.evaluate(() => {
      window.__echoSamples = []
      const sample = () => {
        const w = window.__world
        const e = w && w.entities.find((x) => x.ai && x.ai.behavior === 'echo')
        if (e) {
          const r = e.resist || {}
          const meter = w.annotations.find((a) => String(a.id).indexOf('echo:') === 0)
          window.__echoSamples.push({
            tick: w.tick,
            phys: r.physical === undefined ? 1 : r.physical,
            frozen: r.frozen,
            electrified: r.electrified,
            hp: e.health ? e.health.hp : 0,
            revealed: !!w.mission.bossRevealed,
            meter: meter && meter.text ? meter.text : '',
          })
        }
        window.requestAnimationFrame(sample)
      }
      window.requestAnimationFrame(sample)
    })
  },

  stills: [
    { tick: 40, label: '01-entrance' },
    { tick: 320, label: '02-sustained-fire-it-adapts' },
    { tick: 700, label: '03-the-lull-it-forgets' },
    { tick: 950, label: '04-back-on-the-gun' },
  ],

  readState: () => {
    const s = window.__echoSamples || []
    const between = (a, b) => s.filter((x) => x.tick >= a && x.tick < b).map((x) => x.phys)
    const fire1 = between(40, 340)
    const lull = between(400, 760)
    const fire2 = between(760, 1000)
    return {
      samples: s.length,
      everRevealed: s.some((x) => x.revealed),
      physStart: s.length ? s[0].phys : null,
      minFire1: fire1.length ? Math.min.apply(null, fire1) : null,
      maxLull: lull.length ? Math.max.apply(null, lull) : null,
      minFire2: fire2.length ? Math.min.apply(null, fire2) : null,
      // THE HAZARD: every distinct value frozen ever held across the whole clip.
      frozenValues: Array.from(new Set(s.map((x) => x.frozen))),
      electrifiedSeen: s.some((x) => x.electrified !== undefined),
      meters: Array.from(new Set(s.map((x) => x.meter))).slice(0, 6),
      hpStart: s.length ? s[0].hp : null,
      hpEnd: s.length ? s[s.length - 1].hp : null,
    }
  },

  expect: (st) => {
    const f = []
    if (!st || !st.samples || st.samples < 100) f.push(`too few samples (${st && st.samples})`)
    if (!st.everRevealed) f.push('the boss entrance never fired')
    if (st.hpEnd === null || st.hpEnd >= st.hpStart) f.push(`Echo took no damage (${st.hpStart} -> ${st.hpEnd})`)

    // ── THE HAZARD, verified live on a fully-adapted boss ──────────────────
    // Exactly one value, and that value is 0. Anything else means adaptation
    // moved the frost immunity and the one-tap freeze-shatter execute is back.
    if (st.frozenValues.length !== 1 || st.frozenValues[0] !== 0) {
      f.push(`resist.frozen MOVED — freeze-shatter exploit reopened: ${JSON.stringify(st.frozenValues)}`)
    }
    if (st.electrifiedSeen) f.push('adaptation invented an electrified key')

    // ── Beat 1: it learns ──────────────────────────────────────────────────
    if (st.minFire1 === null || st.minFire1 >= 0.75) {
      f.push(`sustained fire did not make it adapt (min physical ${st.minFire1})`)
    }
    // ── Beat 2: it forgets ─────────────────────────────────────────────────
    if (st.maxLull === null || st.maxLull <= st.minFire1 + 0.05) {
      f.push(`backing off bought nothing (min ${st.minFire1} -> max ${st.maxLull})`)
    }
    // ── Legibility: the player is told, on screen, what is happening ───────
    if (!st.meters.some((m) => m.indexOf('ADAPT') >= 0)) {
      f.push(`the adaptation meter never said anything: ${JSON.stringify(st.meters)}`)
    }
    return f
  },
})

process.exit(ok ? 0 : 1)
