// @ts-check
// feat/npc-ai-ecs proof: drives the `npc-ai` scenario with the `npc-ai` script
// in a real browser and asserts the four pluggable behaviors are distinguishable
// in play — patrol walks its beat, the skittish civilian alerts the cop, the
// hunter presses to last-known position and sweeps, the scavenger stashes loot.
// The annotation overlay labels every cast member with its LIVE behavior · goal
// (via the real `annotate` verb), so the video narrates the AI's own state.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readdirSync, renameSync, statSync, cpSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4897'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-npc-ai')
const SHARE = process.env.E2E_SHARE ?? ''
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '20260718'
const SIZE = { width: 1280, height: 720 }

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[npc-ai-e2e ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

/** Colors per behavior so the labels read at a glance. */
const COLORS = { patrol: '#4fc3f7', hunter: '#ef5350', skittish: '#ffd54f', scavenger: '#81c784', basic: '#e0e0e0' }

const readCast = (page) =>
  page.evaluate(() => {
    const w = window.__world
    const out = { tick: w.tick, npcs: [], player: null }
    for (const e of w.entities) {
      if (e.playerCtl) out.player = { id: e.id, x: e.pos.x, y: e.pos.y, hp: e.health?.hp }
      if (e.kind !== 'npc' || e.dead || !e.ai) continue
      out.npcs.push({
        id: e.id,
        archetype: e.archetype,
        behavior: e.ai.behavior ?? 'basic',
        goal: e.ai.goal,
        mode: e.ai.mode,
        targetId: e.ai.targetId,
        patrolIndex: e.ai.patrolIndex,
        search: e.ai.search ? { left: e.ai.search.left } : null,
        alerted: e.ai.alerted,
        stash: e.ai.stash ?? [],
        scores: e.ai.lastScores ?? {},
        x: e.pos.x,
        y: e.pos.y,
      })
    }
    return out
  })

/** Redraw the entity-anchored labels: `behavior · goal` over every cast NPC. */
const annotate = async (page, cast) => {
  const labels = cast.npcs.map((n) => ({
    id: `ai-${n.id}`,
    kind: 'label',
    targetId: n.id,
    text: `${n.behavior} · ${n.goal ?? n.mode}${n.search ? ` (${n.search.left})` : ''}${n.stash.length ? ` [${n.stash.length}]` : ''}`,
    color: COLORS[n.behavior] ?? '#ffffff',
  }))
  labels.push({ id: 'banner', kind: 'text', x: 16, y: 20, text: 'NPC AI: pluggable behaviors — live goal labels', color: '#ffffff' })
  await page.evaluate((batch) => {
    window.__verb('clearAnnotations')
    window.__verb(`annotate ${JSON.stringify(batch)}`)
  }, labels)
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

  await page.goto(`${BASE}/?mode=solo&scenario=npc-ai&script=npc-ai&e2e=1&seed=${SEED}&zoom=1`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => !!window.__world && !!window.__verb, { timeout: 20000 })

  const total = await page.evaluate(() => window.__scriptTicks ?? 0)
  log('script ticks:', total)

  // Observed milestones, collected across the whole run.
  const saw = {
    patrolLegs: new Set(),
    patrolGoal: false,
    alertGoal: false,
    alerted: false,
    copAggro: false,
    hunterBattle: false,
    hunterSearch: false,
    scavStash: 0,
    scoresSeen: false,
  }
  let shot = 0
  const screenshot = async (label) => {
    shot += 1
    const name = `npc-ai-${String(shot).padStart(2, '0')}-${label}.png`
    await page.screenshot({ path: join(OUT, name) })
    log('screenshot', name)
  }
  const SHOTS = [
    [60, 'cast-labelled'],
    [140, 'civ-alert-run'],
    [260, 'hunter-at-cold-trail'],
    [420, 'behaviors-resolved'],
  ]
  let nextShot = 0

  let tick = 0
  while (tick < total) {
    const cast = await readCast(page)
    tick = cast.tick
    await annotate(page, cast)
    for (const n of cast.npcs) {
      if (n.behavior === 'patrol') {
        if (n.patrolIndex !== undefined) saw.patrolLegs.add(n.patrolIndex)
        if (n.goal === 'patrol') saw.patrolGoal = true
        if (n.mode === 'aggro' && n.targetId === cast.player?.id) saw.copAggro = true
      }
      if (n.behavior === 'skittish') {
        if (n.goal === 'alert') saw.alertGoal = true
        if (n.alerted === cast.player?.id) saw.alerted = true
      }
      if (n.behavior === 'hunter') {
        if (n.goal === 'battle' || n.goal === 'pursue') saw.hunterBattle = true
        if (n.goal === 'search') saw.hunterSearch = true
      }
      if (n.behavior === 'scavenger') saw.scavStash = Math.max(saw.scavStash, n.stash.length)
      if (Object.keys(n.scores).length > 0) saw.scoresSeen = true
    }
    if (nextShot < SHOTS.length && tick >= SHOTS[nextShot][0]) {
      await screenshot(SHOTS[nextShot][1])
      nextShot++
    }
    await sleep(150)
  }
  await sleep(500)
  const final = await readCast(page)
  log('final cast:', JSON.stringify(final.npcs, null, 1))

  check(saw.patrolGoal && saw.patrolLegs.size >= 2, `the cop walked its beat (legs seen: ${[...saw.patrolLegs].join(',')})`)
  check(saw.alertGoal, 'the skittish civilian chose ALERT (ran for the cop)')
  check(saw.alerted, 'the civilian reported the attacker (alerted flag set)')
  check(saw.copAggro, 'the alerted cop turned on the player')
  check(saw.hunterBattle, 'the hunter engaged the player')
  check(saw.hunterSearch, 'the hunter swept last-known position after losing the trail')
  check(saw.scavStash >= 2, `the scavenger stashed loot (${saw.scavStash} items)`)
  check(saw.scoresSeen, 'per-think consideration scores were live on entities')
  check(pageErrors.length === 0, 'zero page errors')

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (!webm) {
    failures.push('no webm recorded')
  } else {
    const webmPath = join(OUT, 'npc-ai-behaviors.webm')
    const mp4 = join(OUT, 'npc-ai-behaviors.mp4')
    renameSync(join(VIDEO_DIR, webm), webmPath)
    execFileSync('ffmpeg', ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf',
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-movflags', '+faststart', mp4], { stdio: 'ignore' })
    rmSync(webmPath, { force: true })
    const bytes = statSync(mp4).size
    log('video ->', mp4, `(${(bytes / 1024).toFixed(0)} KB)`)
    if (bytes < 100_000) failures.push(`mp4 only ${bytes} bytes`)
    if (SHARE) {
      mkdirSync(SHARE, { recursive: true })
      cpSync(mp4, join(SHARE, 'npc-ai-behaviors.mp4'))
    }
  }
  rmSync(VIDEO_DIR, { recursive: true, force: true })

  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: all four behaviors verified on stage, zero page errors')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
