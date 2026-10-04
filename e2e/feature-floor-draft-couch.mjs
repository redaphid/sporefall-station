// #84 / PR #98 review — the floor draft at the couch, recorded in a real headed
// browser (see e2e/lib.mjs `acquireBrowser`: E2E_CDP or E2E_HEADFUL=1).
//
// Two fake standard pads join as P1 and P2 through the real gamepadCoop. P1
// takes the exit, both get a hand and the draft fills the screen. P1 taps a
// card and is back in the fight with three brutes spawned beside them: the
// hand must shrink to a bottom strip so P1 can see. P2 then takes a card with
// A and the draft closes.
//
//   pnpm run build && pnpm exec vite preview --port 4899 --strictPort &
//   E2E_CDP=http://127.0.0.1:9333 BASE_URL=http://localhost:4899 node e2e/feature-floor-draft-couch.mjs

import { record } from './lib.mjs'

/** Install two mutable fake pads behind navigator.getGamepads. */
const installPads = () =>
  Object.assign(window, {
    __mkPad: (index, pressed = []) => ({
      index,
      id: `Fake Pad ${index} (STANDARD GAMEPAD Vendor: beef Product: cafe)`,
      connected: true,
      timestamp: performance.now(),
      mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, (_, i) => ({
        pressed: pressed.includes(i),
        touched: pressed.includes(i),
        value: pressed.includes(i) ? 1 : 0,
      })),
    }),
  }) &&
  Object.defineProperty(Navigator.prototype, 'getGamepads', {
    configurable: true,
    writable: true,
    value: () => window.__pads ?? [],
  })

/** Press and release A on pad `index` (both pads stay connected). */
const tapA = (page, index) =>
  page.evaluate(async (i) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const idle = () => [window.__mkPad(0), window.__mkPad(1)]
    window.__pads = idle()
    await sleep(250)
    const pads = idle()
    pads[i] = window.__mkPad(i, [0])
    window.__pads = pads
    await sleep(250)
    window.__pads = idle()
    await sleep(250)
  }, index)

const layout = (page) =>
  page.evaluate(() => {
    const ov = document.querySelector('.draft-screen')
    const hands = window.__world.entities
      .filter((e) => e.playerCtl)
      .map((e) => ({
        p: e.playerCtl.playerId,
        hand: Boolean(e.playerCtl.draft),
        stacks: (e.loadout?.inventory ?? []).reduce((n, st) => n + (st.mods ?? []).reduce((k, m) => k + m.stacks, 0), 0),
      }))
    return {
      tick: window.__world.tick,
      hands,
      shown: ov ? getComputedStyle(ov).display !== 'none' : false,
      dim: ov ? ov.style.background.includes('rgba') : false,
      clickThrough: ov ? ov.style.pointerEvents === 'none' : false,
    }
  })

const beats = []
const log = async (page, label) => {
  const l = await layout(page)
  beats.push({ label, ...l })
  console.log(`[floor-draft-couch] ${label}: ${JSON.stringify(l)}`)
}

const ok = await record({
  name: 'floor-draft-couch',
  params: { mode: 'solo', seed: '7', scenario: 'armed', debug: '', e2e: '' },
  // ?debug (for the spawn verb) dials the dev hub, which this recording does not run.
  ignoreConsole: /ws:\/\/localhost:7810/,
  beforeTicks: async (page) => {
    await page.waitForFunction(() => (window.__world?.tick ?? 0) > 5, null, { timeout: 30000 })
    await page.evaluate(installPads)
  },
  stills: [
    {
      tick: 20,
      label: '1-two-pads-joined',
      act: async (page) => {
        await tapA(page, 0)
        await tapA(page, 1)
        await log(page, 'joined')
      },
    },
    {
      tick: 110,
      label: '2-both-choosing-full',
      act: async (page) => {
        await page.evaluate(() => {
          const w = window.__world
          const p1 = w.entities.find((e) => e.playerCtl?.playerId === 0)
          w.mission.exitUnlocked = true
          p1.pos.x = p1.prevPos.x = w.level.exit.x + 0.5
          p1.pos.y = p1.prevPos.y = w.level.exit.y + 0.5
        })
        await page.waitForSelector('.draft-card')
        await page.waitForTimeout(500)
        await log(page, 'both choosing')
      },
    },
    {
      tick: 200,
      label: '3-p1-picked-strip',
      act: async (page) => {
        await page.click('.draft-card[data-index="0"]')
        await page.waitForTimeout(400)
        await page.evaluate(() => {
          const me = window.__world.entities.find((e) => e.playerCtl?.playerId === 0)
          for (const [dx, dy] of [[3, 0], [-3, 1], [2, -3]])
            window.sporefall.verb(`spawn npc brute ${(me.pos.x + dx).toFixed(1)} ${(me.pos.y + dy).toFixed(1)}`)
        })
        await page.waitForTimeout(500)
        await log(page, 'P1 picked')
      },
    },
    { tick: 380, label: '4-p1-fighting-p2-choosing', act: (page) => log(page, 'P1 fighting') },
    {
      tick: 460,
      label: '5-p2-picked-closed',
      act: async (page) => {
        await tapA(page, 1)
        await log(page, 'P2 picked')
      },
    },
  ],
  readState: () => ({
    players: window.__world.entities
      .filter((e) => e.playerCtl)
      .map((e) => ({
        p: e.playerCtl.playerId,
        hand: Boolean(e.playerCtl.draft),
        mods: (e.loadout?.inventory ?? []).flatMap((st) => (st.mods ?? []).map((m) => m.id)),
        stacks: (e.loadout?.inventory ?? []).reduce((n, st) => n + (st.mods ?? []).reduce((k, m) => k + m.stacks, 0), 0),
      })),
  }),
  expect: (s) => {
    const f = []
    const at = (label) => beats.find((b) => b.label === label)
    const both = at('both choosing')
    if (!both?.shown || !both.dim || both.clickThrough) f.push(`both choosing should be full-screen: ${JSON.stringify(both)}`)
    for (const label of ['P1 picked', 'P1 fighting']) {
      const b = at(label)
      if (!b?.shown || b.dim || !b.clickThrough) f.push(`${label} should be an undimmed click-through strip: ${JSON.stringify(b)}`)
      if (!b?.hands.find((h) => h.p === 1)?.hand) f.push(`${label}: P2 should still hold a hand`)
    }
    if (at('P2 picked')?.shown) f.push('the draft should close once P2 picks')
    if (s.players.length !== 2) f.push(`expected 2 players, got ${s.players.length}`)
    if (s.players.some((p) => p.hand)) f.push('a hand is still open at the end')
    // Each player gains exactly one mod stack between the deal and the end.
    for (const end of s.players) {
      const was = both?.hands.find((h) => h.p === end.p)?.stacks
      if (end.stacks !== (was ?? NaN) + 1) f.push(`P${end.p + 1} should gain one mod stack: ${was} -> ${end.stacks}`)
    }
    return f
  },
})
// No releaseBrowser(): over E2E_CDP the headed browser is shared, so only
// this run's context (closed by record()) is ours to tear down.
process.exit(ok ? 0 : 1)
