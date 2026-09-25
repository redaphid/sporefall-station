// #78 — SEQUENCED MODS proof: a real, HEADFUL browser playing the feature.
//
// Unlike the tick-pinned `recordFeature` recipe, the beats here are pinned to
// SIM STATE (`castIndex`, `rechargeUntil`) rather than to tick numbers: the
// whole point of the feature is that the index advances shot to shot, so the
// stills must be taken exactly when it does, whatever cooldown the cast's own
// mods resolved to. The run is still fully deterministic (inline fixture +
// `?script=`); only the *sampling* is state-driven.
//
// Four clips:
//   seq-on    — sequenced pistol: strip, index advancing, wrap + recharge,
//               tap-two-chips swap on the HUD, pause-menu reorder + preview.
//   seq-off   — the SAME world and the SAME script with the flag off (no
//               `modCasting`): no strip, every mod folds into every shot.
//
// Browser: see e2e/lib.mjs `acquireBrowser`. `E2E_CDP` points at a real headed
// browser; there is no headless path in this file's intent.

import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireBrowser, releaseBrowser, muxVideo, BASE, OUT } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(readFileSync(join(__dirname, '../src/game/__fixtures__/combat-stage.json'), 'utf8'))
const SIZE = { width: 1280, height: 720 }

/** combat-stage, player wielding a pistol whose mod list is an ordered wand.
 * pistol's sequence shape is slots 4 / 1 cast per pull / 20-tick recharge, so
 * the 5th mod is STOWED (drawn dimmed past the divider) and the 4-entry window
 * wraps every three trigger pulls:
 *   pull 1 -> heavy + frost   (a modifier rides onto the next payload)
 *   pull 2 -> incendiary
 *   pull 3 -> shock           -> runs off the end: wrap + recharge
 */
const modded = (sequenced) => {
  const w = JSON.parse(JSON.stringify(base))
  const p = w.entities.find((e) => e.playerCtl)
  p.combat.weapon = 'pistol'
  p.loadout = {
    inventory: [
      {
        itemId: 'pistol',
        qty: 200,
        mods: [
          { id: 'heavy', stacks: 1 },
          { id: 'frost', stacks: 1 },
          { id: 'incendiary', stacks: 1 },
          { id: 'shock', stacks: 1 },
          { id: 'bounce', stacks: 2 },
        ],
      },
    ],
    activeSlot: 0,
  }
  if (sequenced) w.modCasting = 'sequence'
  return w
}

/** The bits of sim state every beat is judged against, read live in the page. */
const probe = () => {
  const w = window.__world
  if (!w) return { tick: 0 }
  const pl = w.entities.find((e) => e.playerCtl)
  const stack = pl?.loadout?.inventory?.[pl.loadout.activeSlot ?? 0]
  return {
    tick: w.tick,
    modCasting: w.modCasting ?? null,
    castIndex: stack?.castIndex ?? null,
    rechargeUntil: stack?.rechargeUntil ?? null,
    recharging: stack?.rechargeUntil !== undefined && stack.rechargeUntil > w.tick,
    order: (stack?.mods ?? []).map((m) => m.id),
    thugsAlive: w.entities.filter((e) => e.archetype === 'thug' && !e.dead).length,
    frozen: w.entities.filter((e) => e.fx && e.fx.frozen).length,
    stripChips: document.querySelectorAll('[data-role="mod-sequence"] button[data-i]').length,
    rechargeBar: !!document.querySelector('[data-role="mod-recharge"]'),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Evidence gathered by the pause-menu reorder beat (see the run's summary). */
let pauseReorderEvidence = null

// The strip is a ~190x50 corner of a 1280x720 frame — unreadable in a PR at
// full-frame scale. Every beat also gets the strip ELEMENT alone, blown up 4x
// IN THE PAGE (a temporary `transform: scale(4)`) so the chips, the next-mod
// glow and the recharge bar are legible on their own. Done in the browser
// rather than with ffmpeg because Playwright's bundled ffmpeg has no PNG
// decoder, and requiring a system ffmpeg just to crop would defeat the point.
const shotStripZoomed = async (page, locator, dest) => {
  if (!(await locator.isVisible().catch(() => false))) return false
  const el = await locator.elementHandle()
  if (!el) return false
  await el.evaluate((n) => {
    n.dataset.zoomPrev = n.getAttribute('style') ?? ''
    // An opaque plate behind it: the HUD strip is normally transparent, so a 4x
    // blow-up would otherwise read the game scene through the gaps.
    n.style.background = '#0b0f16'
    n.style.padding = '6px 8px'
    n.style.borderRadius = '6px'
    n.style.transformOrigin = 'top left'
    n.style.transform = 'scale(4)'
  })
  await sleep(120)
  await locator.screenshot({ path: dest }).catch(() => {})
  await el.evaluate((n) => {
    n.setAttribute('style', n.dataset.zoomPrev ?? '')
    delete n.dataset.zoomPrev
  })
  return true
}

/** Poll the page until `pred(state)` holds. Throws with the last state seen. */
const until = async (page, label, pred, timeoutMs = 25000) => {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(probe)
    if (pred(last)) return last
    await sleep(25)
  }
  throw new Error(`[${label}] timed out waiting; last state ${JSON.stringify(last)}`)
}

const runClip = async ({ name, world, beats, expect }) => {
  pauseReorderEvidence = null
  const videoDir = join(OUT, `video-${name}`)
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })
  mkdirSync(OUT, { recursive: true })

  const { browser, shared } = await acquireBrowser()
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
  const page = await context.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`))

  const url = `${BASE}/?${new URLSearchParams({ mode: 'solo', e2e: '1', world: '@inline', script: 'shooting' })}`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.__loadWorld === 'function', { timeout: 20000 })
  await page.evaluate((j) => window.__loadWorld(j), world)

  const shots = []
  for (const b of beats) {
    const state = await until(page, `${name}/${b.label}`, b.when)
    if (b.act) {
      await b.act(page)
      await sleep(300)
    }
    const file = join(OUT, `${name}-${b.label}.png`)
    await page.screenshot({ path: file })
    // …and the strip on its own, 4x, so the chips are readable in the PR.
    const strips = page.locator('[data-role="mod-sequence"]')
    await shotStripZoomed(page, b.pauseStrip ? strips.last() : strips.first(), join(OUT, `${name}-${b.label}-strip.png`))
    shots.push({ label: b.label, file, state: b.act ? await page.evaluate(probe) : state })
  }

  const final = await page.evaluate(probe)
  await sleep(700)
  await page.close()
  await context.close()
  if (!shared) await browser.close()

  const { mp4, bytes } = muxVideo(name, videoDir)
  const failures = expect(final, shots).filter(Boolean)
  if (errs.length) failures.push(`page errors: ${errs.slice(0, 3).join(' | ')}`)
  if (bytes < 80_000) failures.push(`video only ${bytes} bytes`)

  console.log(`\n[${name}] ${mp4} (${(bytes / 1024).toFixed(0)} KB)`)
  for (const s of shots) console.log(`[${name}]   still ${s.label}: castIndex=${s.state.castIndex} recharging=${s.state.recharging} chips=${s.state.stripChips} order=${s.state.order.join('>')}`)
  console.log(`[${name}] final: ${JSON.stringify(final)}`)
  if (pauseReorderEvidence) console.log(`[${name}] pause-reorder evidence: ${JSON.stringify(pauseReorderEvidence)}`)
  if (failures.length) {
    for (const f of failures) console.error(`[${name}] FAIL: ${f}`)
    return false
  }
  console.log(`[${name}] OK`)
  return true
}

// ---------------------------------------------------------------- flag ON ---
// Each beat waits for the SIM to reach the state it is meant to show.
const seqOn = () =>
  runClip({
    name: 'seq-on',
    world: modded(true),
    expect: (f, shots) => [
      f.modCasting !== 'sequence' && 'run was not sequenced',
      !shots.some((s) => s.state.castIndex === 2) && 'never saw the index advance to 2',
      !shots.some((s) => s.state.recharging) && 'never caught the wrap recharge',
      !shots.some((s) => s.state.rechargeBar) && 'recharge bar never rendered',
      shots.every((s) => s.state.stripChips !== 5) && 'sequence strip never drew its 5 chips',
      // The HUD swap must have reordered the REAL sim list, not just the DOM.
      shots.at(-1).state.order[0] === 'heavy' && 'the tap-two-chips swap never reached the sim',
    ],
    beats: [
      // 1. The strip itself: five chips, the stowed one past the divider, the
      //    first cast (heavy + frost) outlined as next.
      { label: '01-strip', when: (s) => s.tick > 8 && s.stripChips === 5 },
      // 2/3. The index advancing shot to shot.
      { label: '02-index-advanced', when: (s) => s.castIndex === 2 },
      { label: '03-index-advanced-again', when: (s) => s.castIndex === 3 },
      // 4. Running off the end: index back to 0 and the weapon recharging.
      { label: '04-wrap-recharge', when: (s) => s.recharging },
      // 5. A second wrap, to show the cycle is the rhythm and not a one-off.
      { label: '05-second-cycle', when: (s) => s.castIndex === 2 },
      // 6. Tap-two-chips reorder on the HUD strip: first tap arms a chip…
      {
        label: '06-hud-chip-picked',
        when: (s) => s.tick > 0,
        act: async (page) => {
          await page.click('[data-role="mod-sequence"] button[data-i="1"]')
        },
      },
      // …second tap swaps them, and the request rides out on the next command.
      {
        label: '07-hud-swapped',
        when: (s) => s.tick > 0,
        act: async (page) => {
          await page.click('[data-role="mod-sequence"] button[data-i="0"]')
          await sleep(600)
        },
      },
      // 8. The pause menu carries the same strip under the loadout panel.
      {
        label: '08-pause-menu',
        pauseStrip: true,
        when: (s) => s.tick > 0,
        act: async (page) => {
          await page.keyboard.press('Escape')
          await sleep(500)
        },
      },
      // 9. Reorder from the pause menu. The intent (modSwapQueue.ts) is that the
      //    swap is a PREVIEW while paused and applies on the first tick after
      //    Resume. `pauseReorder` reads the strip synchronously either side of
      //    each tap, which is the only way to see the preview at all — see the
      //    finding recorded in `pauseReorderEvidence`.
      {
        label: '09-pause-reorder-tapped',
        pauseStrip: true,
        when: (s) => s.tick > 0,
        act: async (page) => {
          pauseReorderEvidence = await page.evaluate(() => {
            const strips = document.querySelectorAll('[data-role="mod-sequence"]')
            const menu = strips[strips.length - 1]
            const read = () => [...menu.querySelectorAll('button[data-i]')].map((b) => b.title.split(' (')[0])
            const tap = (i) => menu.querySelector(`button[data-i="${i}"]`).click()
            const before = read()
            tap(3)
            const afterFirstTap = read()
            tap(4)
            const previewSameTurn = read()
            return { before, afterFirstTap, previewSameTurn }
          })
          await sleep(500)
          pauseReorderEvidence.afterOneFrame = await page.evaluate(() => {
            const strips = document.querySelectorAll('[data-role="mod-sequence"]')
            return [...strips[strips.length - 1].querySelectorAll('button[data-i]')].map((b) => b.title.split(' (')[0])
          })
        },
      },
      {
        label: '10-resumed',
        when: (s) => s.tick > 0,
        act: async (page) => {
          await page.keyboard.press('Escape')
          await sleep(1000)
        },
      },
    ],
  })

// --------------------------------------------------------------- flag OFF ---
const seqOff = () =>
  runClip({
    name: 'seq-off',
    world: modded(false),
    expect: (f, shots) => [
      f.modCasting !== null && 'flag-off run somehow got a casting rule',
      shots.some((s) => s.state.stripChips > 0) && 'the strip rendered with the flag OFF',
      f.castIndex !== null && 'flag-off run wrote a castIndex',
    ],
    beats: [
      { label: '01-no-strip', when: (s) => s.tick > 8 },
      { label: '02-firing-folded', when: (s) => s.tick > 250 },
      { label: '03-aftermath', when: (s) => s.tick > 400 },
    ],
  })

let ok = true
ok = (await seqOn()) && ok
ok = (await seqOff()) && ok
await releaseBrowser()
if (!ok) process.exitCode = 1
