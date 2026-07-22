// @ts-check
// feat/npc-ai-deliberate proof: drive the `npc-deliberate` scenario + script in
// a real browser and assert the three tactical moments actually play out from
// live world state — the boxed hunter ROUTES around its U-wall to the player
// (no wall-grinding, no solid overlap ever), the squad's lead HOLDS at the
// closed door until the pack stacks and then all breach together (an NPC — not
// the player — opens the door), and the dormant lurker springs its proximity
// ambush. The annotation overlay labels the cast with live behavior · goal so
// the video narrates the AI's own state. Records stills + mp4.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readdirSync, renameSync, statSync, cpSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4942'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output-npc-deliberate')
const SHARE = process.env.E2E_SHARE ?? ''
const VIDEO_DIR = join(OUT, 'video')
const SEED = process.env.E2E_SEED ?? '20260722'
const SIZE = { width: 1280, height: 720 }

// Stage geometry (must match scenarios.setupNpcDeliberate; cx=32, cy=32).
const DOOR = { x: 38.5, y: 32.5 }
const WALL_X = 38 // the squad-side wall plane
const U_BOX = { x0: 21, y0: 25, x1: 27, y1: 29 } // hunter's U pocket (tiles)

rmSync(OUT, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[npc-deliberate ${new Date().toISOString().slice(11, 19)}]`, ...a)

/** @type {string[]} */
const pageErrors = []
/** @type {string[]} */
const failures = []
const check = (cond, msg) => {
  if (!cond) failures.push(msg)
  log(cond ? 'PASS' : 'FAIL', msg)
}

const COLORS = { squad: '#ef5350', lurker: '#b388ff', hunter: '#ffb74d' }

const readCast = (page) =>
  page.evaluate(() => {
    const w = window.__world
    const lw = w.level.w
    const out = { tick: w.tick, npcs: [], player: null, door: null, anyNpcInSolid: false }
    for (const e of w.entities) {
      if (e.playerCtl) out.player = { id: e.id, x: e.pos.x, y: e.pos.y, hp: e.health?.hp }
      if (e.door) out.door = { id: e.id, open: e.door.open, x: e.pos.x, y: e.pos.y }
      if (e.kind !== 'npc' || e.dead || !e.ai) continue
      // The solid-overlap invariant, computed in-page against the live grid.
      const tx = Math.floor(e.pos.x)
      const ty = Math.floor(e.pos.y)
      if (w.level.solid[ty * lw + tx] === 1) out.anyNpcInSolid = true
      out.npcs.push({
        id: e.id,
        archetype: e.archetype,
        behavior: e.ai.behavior ?? 'basic',
        role: e.ai.squad?.role,
        goal: e.ai.goal,
        mode: e.ai.mode,
        dormant: !!e.ai.dormant,
        x: e.pos.x,
        y: e.pos.y,
      })
    }
    return out
  })

/** Live labels over the cast: behavior/role · goal (or 'dormant…'). */
const annotate = async (page, cast) => {
  const labels = cast.npcs.map((n) => ({
    id: `ai-${n.id}`,
    kind: 'label',
    targetId: n.id,
    text: n.dormant ? 'lurker · (dormant…)' : `${n.role ? `squad:${n.role}` : n.behavior} · ${n.goal ?? n.mode}`,
    color: COLORS[n.behavior] ?? '#ffffff',
  }))
  labels.push({
    id: 'banner',
    kind: 'text',
    x: 16,
    y: 20,
    text: 'DELIBERATE AI: routed pursuit · squad door-stack breach · lurker ambush',
    color: '#ffffff',
  })
  await page.evaluate((batch) => {
    window.__verb('clearAnnotations')
    window.__verb(`annotate ${JSON.stringify(batch)}`)
  }, labels)
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const inU = (n) => n.x >= U_BOX.x0 && n.x <= U_BOX.x1 + 1 && n.y >= U_BOX.y0 && n.y <= U_BOX.y1 + 1

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: VIDEO_DIR, size: SIZE } })
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    pageErrors.push(String(e))
    log('PAGE ERROR:', String(e))
  })
  page.on('console', (m) => m.type() === 'error' && log('console.error:', m.text()))

  await page.goto(`${BASE}/?mode=solo&scenario=npc-deliberate&script=npc-deliberate&e2e=1&seed=${SEED}&zoom=1`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => !!window.__world && !!window.__verb, { timeout: 20000 })

  const total = await page.evaluate(() => window.__scriptTicks ?? 0)
  log('script ticks:', total)

  const saw = {
    lurkerDormant: false,
    lurkerWoke: false,
    lurkerPounced: false,
    hunterStartedBoxed: false,
    hunterEscapedU: false,
    hunterReached: false,
    leadHeldStack: false,
    stackWhileOpen: false,
    doorOpened: false,
    playerNearDoorWhenOpened: false,
    solidOverlap: false,
    squadCross: new Map(), // id -> tick it was first seen west of the wall
  }
  let doorWasOpen = false

  let shot = 0
  const screenshot = async (label) => {
    shot += 1
    const name = `npc-deliberate-${String(shot).padStart(2, '0')}-${label}.png`
    await page.screenshot({ path: join(OUT, name) })
    log('screenshot', name)
  }
  const SHOTS = [
    [40, 'cast-and-dormant-lurker'],
    [110, 'lurker-pounce'],
    [260, 'squad-stack-or-hunter-route'],
    [500, 'breach-aftermath'],
  ]
  let nextShot = 0

  let tick = 0
  while (tick < total) {
    const cast = await readCast(page)
    tick = cast.tick
    await annotate(page, cast)
    if (cast.anyNpcInSolid) saw.solidOverlap = true
    const lurker = cast.npcs.find((n) => n.archetype === 'lurker')
    const hunter = cast.npcs.find((n) => n.behavior === 'hunter' || n.archetype === 'gangster')
    const lead = cast.npcs.find((n) => n.role === 'lead')
    if (lurker) {
      if (lurker.dormant && tick < 60) saw.lurkerDormant = true
      if (!lurker.dormant && lurker.mode === 'aggro') saw.lurkerWoke = true
      if (!lurker.dormant && cast.player && dist(lurker, cast.player) < 2) saw.lurkerPounced = true
    }
    if (hunter) {
      if (tick < 30 && inU(hunter)) saw.hunterStartedBoxed = true
      if (saw.hunterStartedBoxed && !inU(hunter)) saw.hunterEscapedU = true
      if (cast.player && dist(hunter, cast.player) < 3) saw.hunterReached = true
    }
    if (lead?.goal === 'stack') {
      saw.leadHeldStack = true
      if (cast.door?.open) saw.stackWhileOpen = true
    }
    if (cast.door?.open && !doorWasOpen) {
      doorWasOpen = true
      saw.doorOpened = true
      if (cast.player && dist(cast.player, DOOR) < 4) saw.playerNearDoorWhenOpened = true
    }
    for (const n of cast.npcs) {
      if (n.role && n.x < WALL_X && !saw.squadCross.has(n.id)) saw.squadCross.set(n.id, tick)
    }
    if (nextShot < SHOTS.length && tick >= SHOTS[nextShot][0]) {
      await screenshot(SHOTS[nextShot][1])
      nextShot++
    }
    await sleep(120)
  }
  await sleep(500)

  check(saw.lurkerDormant, 'the lurker was visibly DORMANT at the start')
  check(saw.lurkerWoke, 'the stroll past its pocket WOKE the lurker into instant aggro')
  check(saw.lurkerPounced, 'the lurker closed to knife range (the pounce landed)')
  check(saw.hunterStartedBoxed, 'the hunter started boxed inside the U-pocket')
  check(saw.hunterEscapedU, 'the hunter ROUTED out of the U (no wall-grinding)')
  check(saw.hunterReached, 'the hunter came around and reached the player')
  check(saw.leadHeldStack, 'the squad lead HELD at the door (stack goal observed)')
  check(!saw.stackWhileOpen, 'the hold only ever happened at a CLOSED door')
  check(saw.doorOpened, 'the door was breached')
  check(!saw.playerNearDoorWhenOpened, 'the player was nowhere near it — an NPC opened it')
  check(saw.squadCross.size === 3, `all 3 squad members made entry (${saw.squadCross.size}/3)`)
  if (saw.squadCross.size === 3) {
    const ticks = [...saw.squadCross.values()]
    const spread = Math.max(...ticks) - Math.min(...ticks)
    check(spread <= 200, `the squad entered TOGETHER (spread ${spread} ticks)`)
  }
  check(!saw.solidOverlap, 'no NPC ever stood inside a solid tile')
  check(pageErrors.length === 0, 'zero page errors')

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (!webm) {
    failures.push('no webm recorded')
  } else {
    const webmPath = join(OUT, 'npc-deliberate.webm')
    const mp4 = join(OUT, 'npc-deliberate.mp4')
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
      cpSync(mp4, join(SHARE, 'npc-deliberate.mp4'))
    }
  }
  rmSync(VIDEO_DIR, { recursive: true, force: true })

  if (failures.length) {
    log('FAILURES:', failures.join('; '))
    process.exit(1)
  }
  log('SUCCESS: routed pursuit, squad breach, lurker ambush — all verified live')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
