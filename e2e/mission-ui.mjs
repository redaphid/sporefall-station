import { record } from './lib.mjs'

// Mission-UI feature proof (feat/mission-ui-links), three deterministic clips:
//
//   1. mission-ui           — the headline: chip → expanded panel → tap the
//      objective HYPERLINK → the camera GLIDES to the briefcase (pulsing ring),
//      dwells, glides home; the off-screen 🎯 edge indicator brackets both ends.
//   2. mission-ui-progress  — progress states over a real playthrough: active
//      objective → MISSION COMPLETE (done row, link dropped because the target
//      entity despawned) → exit row unlocks + links (tap → ring on the exit) →
//      floor 2's fresh mission.
//   3. mission-ui-degenerate — reach-only mission (single exit row) and game
//      over (chip + panel hide; restart overlay owns the screen).
//
// All DOM interaction goes through data-attributes (no pixel math); the sim is
// driven by ?script= timelines so every run is bit-identical. Sim TICKS gate
// each still, but Playwright actions cost wall-time, so every interaction sits
// inside a wide stand-still script window and clicks are STATE-qualified
// selectors (they wait for the row to reach the expected state, not a guess).

/** Install window.__snapMission(key): one in-page snapshot of the mission-UI
 * DOM + camera truth into window.__shots[key]. Installed once (beforeTicks) so
 * the atomic focus capture below can reuse it INSIDE a rAF poll. */
const installSnap = (page) =>
  page.evaluate(() => {
    window.__snapMission = (key) => {
      const shots = (window.__shots ??= {})
      const w = window.__world
      const target = w.entities.find((e) => e.id === w.mission.targetEntityId)
      const proj = target ? window.__project(target.pos.x, target.pos.y) : undefined
      const el = (sel) => document.querySelector(sel)
      const visible = (sel) => {
        const n = el(sel)
        return !!n && getComputedStyle(n).display !== 'none'
      }
      shots[key] = {
        chipText: el('[data-mission-chip]')?.textContent ?? '',
        chipVisible: visible('[data-mission-chip]'),
        panelOpen: visible('[data-mission-panel]'),
        rows: [...document.querySelectorAll('[data-objective]')].map((r) => ({
          key: r.dataset.objective,
          state: r.dataset.state,
          linked: !!r.querySelector('[data-locate]'),
          text: r.textContent,
        })),
        edgeIndicator: visible('[data-mission-marker="edge"]'),
        targetCaret: visible('[data-mission-marker="target"]'),
        focusRing: visible('[data-mission-marker="ring"]'),
        targetScreen: proj,
        missionComplete: w.mission.complete,
        floor: w.floor,
      }
    }
  })

const snap = (label) => (page) => page.evaluate((key) => window.__snapMission(key), label)

/** Tap an element by dispatching a DOM click directly. page.click() is unusable
 * here: the game page runs a continuous rAF loop + infinite CSS animations, and
 * Playwright's actionability/scroll machinery never sees the page as settled
 * (it hangs even with force:true while the handler HAS already fired). The
 * mission UI's handlers are plain click listeners, so element.click() exercises
 * the identical code path. Waits (sim-tick agnostic) for the selector to exist. */
const click = (sel) => async (page) => {
  await page.waitForFunction((s) => !!document.querySelector(s), sel, { timeout: 15000 })
  await page.evaluate((s) => document.querySelector(s).click(), sel)
}
const settle = (ms) => (page) => page.waitForTimeout(ms)
/** Re-expand the panel if its unobtrusive auto-collapse already folded it (the
 * wall-clock cost of earlier screenshots can outlast the 6s collapse timer),
 * then tap the row — mirroring what a player would do. */
const clickRow = (sel) => async (page) => {
  const open = await page.evaluate(() => {
    const p = document.querySelector('[data-mission-panel]')
    return !!p && getComputedStyle(p).display !== 'none'
  })
  if (!open) await click('[data-mission-chip]')(page)
  await click(sel)(page)
}
/** ATOMIC focus capture: poll on rAF INSIDE the page until the glide has centred
 * the mission target, then snapshot in the very same frame — immune to the
 * multi-second wall-clock cost of Playwright screenshots under video recording.
 * Times out into a snapshot anyway so the asserts report what actually happened. */
const captureFocused = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now()
        const poll = () => {
          const w = window.__world
          const t = w.entities.find((e) => e.id === w.mission.targetEntityId)
          const p = t && window.__project(t.pos.x, t.pos.y)
          const centred = p && Math.hypot(p.x - 640, p.y - 360) < 60
          if (centred || performance.now() - t0 > 9000) {
            window.__snapMission('focused')
            resolve()
            return
          }
          requestAnimationFrame(poll)
        }
        poll()
      }),
  )
const seq =
  (...acts) =>
  async (page) => {
    for (const a of acts) await a(page)
  }

const CENTER = { x: 1280 / 2, y: 720 / 2 }
const dist = (p) => (p ? Math.hypot(p.x - CENTER.x, p.y - CENTER.y) : Infinity)

// ---------------------------------------------------------------------------
// 1) Headline: hyperlink tap → animated camera pan + highlight + edge indicator.
// zoom=2 keeps the briefcase (10,11) OFF-SCREEN from spawn (1.5,1.5) so the
// edge indicator has something to do, and makes the glide unmistakable.
const ok1 = await record({
  name: 'mission-ui',
  params: { mode: 'solo', seed: 7, scenario: 'mission', script: 'missionui', e2e: 1, zoom: 2 },
  beforeTicks: installSnap,
  stills: [
    { tick: 40, label: '01-chip-collapsed-edge-indicator', act: snap('start') },
    { tick: 70, label: '02-panel-expanded-hyperlink', act: seq(click('[data-mission-chip]'), settle(120), snap('panel')) },
    { tick: 100, label: '03-link-tapped-pan-begins', act: seq(clickRow('[data-objective="mission"]'), snap('tapped')) },
    { tick: 101, label: '04-camera-on-target-ring', act: captureFocused },
    { tick: 300, label: '05-glide-home' },
    { tick: 520, label: '06-back-at-player-edge-indicator', act: snap('returned') },
  ],
  readState: () => window.__shots,
  expect: (s) => {
    const f = []
    // Start: collapsed chip carries the mission line; the target is off-screen
    // so the 🎯 edge indicator (and no caret/ring) shows.
    if (!s.start?.chipVisible) f.push('chip not visible at start')
    if (!/Floor 1 — Extract the specimen canister/.test(s.start?.chipText ?? '')) f.push(`chip text wrong: "${s.start?.chipText}"`)
    if (s.start?.panelOpen) f.push('panel should start collapsed')
    if (!s.start?.edgeIndicator) f.push('edge indicator missing while target off-screen')
    if (s.start?.focusRing) f.push('focus ring must not show before a tap')
    // Expanded: mission row is an active HYPERLINK, exit row locked and unlinked.
    if (!s.panel?.panelOpen) f.push('panel did not expand on chip tap')
    const mrow = s.panel?.rows.find((r) => r.key === 'mission')
    const erow = s.panel?.rows.find((r) => r.key === 'exit')
    if (!mrow?.linked || mrow?.state !== 'active') f.push(`mission row not an active link: ${JSON.stringify(mrow)}`)
    if (erow?.state !== 'locked' || erow?.linked) f.push(`exit row should be locked+unlinked: ${JSON.stringify(erow)}`)
    // The pan is ANIMATED: right after the tap the camera is en route (target
    // not yet near centre) …
    if (dist(s.tapped?.targetScreen) < 40) f.push('camera snapped instead of gliding (already centred right after tap)')
    // … and it ARRIVES: ring pulsing on the centred target, edge indicator
    // retired while it is on-screen.
    if (!s.focused?.focusRing) f.push('focus ring missing while focused')
    if (dist(s.focused?.targetScreen) > 120) f.push(`camera never centred target: ${JSON.stringify(s.focused?.targetScreen)}`)
    if (s.focused?.edgeIndicator) f.push('edge indicator should hide while target on-screen')
    // Returned: focus over, camera home, target off-screen again → edge indicator back.
    if (s.returned?.focusRing) f.push('focus ring stuck on after focus ended')
    if (!s.returned?.edgeIndicator) f.push('edge indicator did not come back after return')
    if (dist(s.returned?.targetScreen) < 200) f.push('camera never returned to the player')
    return f
  },
})

// ---------------------------------------------------------------------------
// 2) Progress states across a REAL mission playthrough. The missionProgress
// script parks the player for 300 ticks after the pickup, so every panel
// interaction lands inside a wide deterministic window (no wall-clock races).
const ok2 = await record({
  name: 'mission-ui-progress',
  params: { mode: 'solo', seed: 7, scenario: 'mission', script: 'missionProgress', e2e: 1 },
  beforeTicks: installSnap,
  stills: [
    { tick: 20, label: '01-objective-active', act: snap('active') },
    { tick: 230, label: '02-mission-complete-banner', act: snap('complete') },
    {
      tick: 250,
      label: '03-panel-done-row-exit-unlocked',
      act: seq(click('[data-mission-chip]'), settle(120), snap('panelDone')),
    },
    {
      tick: 280,
      label: '04-exit-link-focus-ring',
      act: seq(clickRow('[data-objective="exit"][data-state="active"]'), settle(250), snap('exitTapped')),
    },
    { tick: 880, label: '05-floor2-fresh-mission', act: snap('floor2') },
  ],
  readState: () => ({ shots: window.__shots, floor: window.__world.floor }),
  expect: ({ shots: s, floor }) => {
    const f = []
    if (s.active?.missionComplete) f.push('mission should start incomplete')
    if (s.active?.rows.find((r) => r.key === 'exit')?.state !== 'locked') f.push('exit not locked at start')
    if (!/LAUNCH BAY is open/.test(s.complete?.chipText ?? '')) f.push(`chip did not flip on completion: "${s.complete?.chipText}"`)
    const done = s.panelDone?.rows.find((r) => r.key === 'mission')
    if (done?.state !== 'done') f.push(`mission row not done: ${JSON.stringify(done)}`)
    if (done?.linked) f.push('despawned target must drop its hyperlink')
    const exit = s.panelDone?.rows.find((r) => r.key === 'exit')
    if (exit?.state !== 'active' || !exit?.linked) f.push(`exit row should be active+linked: ${JSON.stringify(exit)}`)
    if (!s.exitTapped?.focusRing) f.push('tapping the exit link should show the focus ring')
    if (floor < 2) f.push(`playthrough never reached floor 2 (floor ${floor})`)
    if (!/Floor 2 — /.test(s.floor2?.chipText ?? '')) f.push(`no fresh floor-2 mission in chip: "${s.floor2?.chipText}"`)
    return f
  },
})

// ---------------------------------------------------------------------------
// 3) Degenerate states: a reach-only mission collapses to ONE exit row; game
// over hides the mission UI entirely. (?e2e world mutation — view-layer test.)
const ok3 = await record({
  name: 'mission-ui-degenerate',
  params: { mode: 'solo', seed: 7, script: 'missionui', e2e: 1 },
  beforeTicks: installSnap,
  stills: [
    { tick: 30, label: '01-generated-mission', act: snap('generated') },
    {
      tick: 60,
      label: '02-reach-only-single-row',
      act: seq(
        (page) =>
          page.evaluate(() => {
            window.__world.mission = { template: 'reach', complete: true, exitUnlocked: true, description: 'Reach the Launch Bay' }
          }),
        settle(120),
        click('[data-mission-chip]'),
        settle(120),
        snap('reach'),
      ),
    },
    {
      tick: 100,
      label: '03-game-over-ui-hidden',
      act: seq(
        (page) =>
          page.evaluate(() => {
            window.__world.gameOver = true
          }),
        settle(250),
        snap('over'),
      ),
    },
  ],
  readState: () => window.__shots,
  expect: (s) => {
    const f = []
    if (!/Floor 1 — /.test(s.generated?.chipText ?? '')) f.push(`no generated mission in chip: "${s.generated?.chipText}"`)
    if (s.reach?.rows.length !== 1 || s.reach?.rows[0].key !== 'exit') f.push(`reach mission should be ONE exit row: ${JSON.stringify(s.reach?.rows)}`)
    if (s.reach?.rows[0].state !== 'active' || !s.reach?.rows[0].linked) f.push('reach exit row should be active+linked')
    if (s.over?.chipVisible) f.push('chip must hide on game over')
    if (s.over?.panelOpen) f.push('panel must hide on game over')
    if (s.over?.edgeIndicator || s.over?.focusRing || s.over?.targetCaret) f.push('markers must hide on game over')
    return f
  },
})

if (!(ok1 && ok2 && ok3)) process.exitCode = 1
