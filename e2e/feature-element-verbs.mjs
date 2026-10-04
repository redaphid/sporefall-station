// #87 — elements differ by VERB. Records the `element-verbs` scenario in the real
// pixi build, injected as an exact world at tick 0 (?world=@inline) so the first
// still catches every verb at once. Five hostile thugs in one room: HELD
// (frozen), PANICKING (lit by the player, bolting east under a "!!" mark),
// JUMPED (a shock on one thug that leapt to its neighbour) and BLIND (choking on
// spore under a slashed eye). The player stands idle; the real systems do the
// rest. Adversarial post-run asserts on the live world: the leap landed, the lit
// thug ran AWAY from the player while marked, and the spore thug was blinded.
//
// Needs a WebGL-capable browser: headless WSL chromium renders a black canvas,
// so run it against a headed Chrome with E2E_CDP=http://localhost:9333.
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { record } from './lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const world = JSON.parse(
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/test/element-verbs-world.mts', '7'], { cwd: root, encoding: 'utf8' }),
)
const thugs = world.entities.filter((e) => e.archetype === 'thug').slice(-5)
const player = world.entities.find((e) => e.playerCtl)
const [, lit, , landing, choking] = thugs
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

const before = async (page) => {
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate(
    ({ j, litId, landingId, chokingId, from }) => {
      window.__sawPanic = 0
      window.__sawBlind = 0
      window.__sawLeap = false
      window.__panicMaxD = 0
      setInterval(() => {
        const w = window.__world
        if (!w) return
        const lit = w.byId.get(litId)
        if (lit && (lit.lockout?.panic?.activeUntil ?? 0) > w.tick) {
          window.__sawPanic++
          window.__panicMaxD = Math.max(window.__panicMaxD, Math.hypot(lit.pos.x - from.x, lit.pos.y - from.y))
        }
        if (w.byId.get(chokingId)?.fx?.spore) window.__sawBlind++
        if (w.byId.get(landingId)?.fx?.electrified) window.__sawLeap = true
      }, 30)
      window.__loadWorld(j)
    },
    { j: world, litId: lit.id, landingId: landing.id, chokingId: choking.id, from: player.pos },
  )
}

const pass = await record({
  name: 'feature-element-verbs',
  params: { mode: 'solo', e2e: '1', world: '@inline', script: 'fxIdle', zoom: 2 },
  beforeTicks: before,
  stills: [
    { tick: 6, label: '01-all-verbs' },
    { tick: 45, label: '02-panic-running' },
    { tick: 100, label: '03-still-blind' },
    { tick: 200, label: '04-aftermath' },
  ],
  readState: () => ({
    tick: window.__world.tick,
    gameOver: window.__world.gameOver,
    sawPanic: window.__sawPanic,
    sawBlind: window.__sawBlind,
    sawLeap: window.__sawLeap,
    panicMaxD: window.__panicMaxD,
  }),
  expect: (s) =>
    [
      s.sawPanic < 3 && `panic sampled only ${s.sawPanic} times`,
      s.sawBlind < 3 && `spore blindness sampled only ${s.sawBlind} times`,
      !s.sawLeap && 'the shock never leapt to the neighbouring thug',
      s.panicMaxD < dist(lit.pos, player.pos) + 2 &&
        `the lit thug did not run from the player (max ${s.panicMaxD.toFixed(2)} tiles, started ${dist(lit.pos, player.pos).toFixed(2)})`,
      s.gameOver && 'unexpected game over',
    ].filter(Boolean),
})
if (!pass) process.exitCode = 1
