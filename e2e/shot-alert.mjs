// Stills for the STATION ALERT escalation: the same camera, before and after
// the objective is met, so the change is directly comparable.
//
// Video is deliberately not attempted — the local recorder needs ffmpeg, which
// is not installed on this machine (pre-existing, unrelated). `record()` in
// lib.mjs snaps its PNGs before it muxes, so this reuses that pattern minus the
// mux rather than forking the recorder.
//
// Honesty note: the player is teleported to a doorway for a legible vantage and
// the objective is completed by handing over the briefcase — exactly what
// auto-pickup does. Everything after that is the REAL sim: the door sweep, the
// alert latch, the manhunt and every presentation cue are the shipped code
// paths, not staged.

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const SIZE = { width: 1280, height: 720 }
const SEED = 2

const shoot = async (page, label) => {
  await page.screenshot({ path: join(OUT, `alert-${label}.png`) })
  console.log('shot', label)
}

const run = async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: SIZE })
  const page = await context.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`${BASE}/?e2e=1&mode=solo&seed=${SEED}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => (window.__world?.tick ?? 0) > 2, null, { timeout: 30000 })

  // Park the player in a doorway with several other doors in shot, and hold the
  // camera there for every frame so before/after are the same view.
  const setup = await page.evaluate(() => {
    const w = window.__world
    const self = w.entities.find((e) => e.playerCtl)
    const doors = w.entities.filter((e) => e.door)
    const cx = w.level.w / 2
    const cy = w.level.h / 2
    // The door with the most neighbours nearby — the most legible vantage.
    let best = doors[0]
    let bestScore = -1
    for (const d of doors) {
      const near = doors.filter((o) => Math.hypot(o.pos.x - d.pos.x, o.pos.y - d.pos.y) < 9).length
      const score = near * 10 - Math.hypot(d.pos.x - cx, d.pos.y - cy) * 0.1
      if (score > bestScore) {
        bestScore = score
        best = d
      }
    }
    self.pos.x = best.pos.x + 1.6
    self.pos.y = best.pos.y + 1.6
    self.prevPos.x = self.pos.x
    self.prevPos.y = self.pos.y
    return {
      selfId: self.id,
      at: { x: self.pos.x, y: self.pos.y },
      template: w.mission.template,
      doorsClosed: doors.filter((d) => !d.door.open || d.door.locked).length,
      doorsTotal: doors.length,
    }
  })
  console.log('setup', setup)

  await page.waitForTimeout(1200)
  await shoot(page, '1-before')

  // Meet the objective. `steal` = the canister lands in the loadout (what
  // auto-pickup does); anything else completes when its target dies.
  const fired = await page.evaluate(() => {
    const w = window.__world
    const self = w.entities.find((e) => e.playerCtl)
    if (w.mission.template === 'steal') {
      self.loadout = { inventory: [{ itemId: 'briefcase', qty: 1 }], activeSlot: 0 }
    } else if (w.mission.targetEntityId !== undefined) {
      const t = w.byId.get(w.mission.targetEntityId)
      if (t) t.dead = true
    }
    return true
  })
  console.log('objective met:', fired)

  // The banner + klaxon + haptic fire on the alert tick; catch the banner while
  // it is still up (it fades after ~2.2s).
  await page.waitForTimeout(700)
  const after = await page.evaluate(() => {
    const w = window.__world
    const doors = w.entities.filter((e) => e.door)
    const npcs = w.entities.filter((e) => e.ai && !e.playerCtl && !e.dead)
    return {
      alertTick: w.mission.alertTick,
      alarm: w.alarm,
      doorsOpen: doors.filter((d) => d.door.open).length,
      doorsTotal: doors.length,
      stillLocked: doors.filter((d) => d.door.locked).length,
      hunting: npcs.filter((n) => n.ai.targetId !== undefined).length,
      npcs: npcs.length,
    }
  })
  console.log('after', after)
  await shoot(page, '2-alert')

  await page.waitForTimeout(2600)
  await shoot(page, '3-escape')

  const late = await page.evaluate(() => {
    const w = window.__world
    const self = w.entities.find((e) => e.playerCtl)
    const npcs = w.entities.filter((e) => e.ai && !e.playerCtl && !e.dead)
    const near = npcs.filter((n) => Math.hypot(n.pos.x - self.pos.x, n.pos.y - self.pos.y) < 14).length
    return { tick: w.tick, hunting: npcs.filter((n) => n.ai.targetId !== undefined).length, within14: near }
  })
  console.log('late', late)

  if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 5))
  await context.close()
  await browser.close()

  const problems = []
  if (after.alertTick === undefined) problems.push('alert never latched')
  if (after.doorsOpen !== after.doorsTotal) problems.push(`${after.doorsTotal - after.doorsOpen} doors still shut`)
  if (after.stillLocked > 0) problems.push(`${after.stillLocked} doors still locked`)
  if (after.hunting === 0) problems.push('nobody is hunting')
  if (problems.length) {
    console.error('FAILED:', problems.join('; '))
    process.exit(1)
  }
  console.log('OK — alert latched, every door open, floor hunting')
}

run()
