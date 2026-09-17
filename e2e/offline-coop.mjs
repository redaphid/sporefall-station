/**
 * Cold start with NO internet, two instances, co-op end to end — the campsite.
 *
 * Deliberately different from e2e/ws-multiplayer.mjs, which boots `wrangler dev`
 * and plays through a Cloudflare Durable Object. There is no Cloudflare at a
 * campsite. This serves the BUILT dist/ from a dumb local static file server
 * (the equivalent of the APK's bundled webDir) and hard-blocks every request
 * that is not to that server, recording each attempt.
 *
 * Transport is BroadcastChannelTransport (`?transport=tabs`), the browser stand-in
 * for the phone-to-phone BLE link: same NetHostSession / NetClientSession, same
 * protocol, same framing. It does NOT exercise bleTransport.ts itself — only two
 * real phones can do that.
 *
 * Asserts:
 *   • both instances boot with all external network blocked
 *   • the client joins the host lobby and both reach floor 1
 *   • both worlds tick and stay populated
 *   • NO request to a non-local origin is even attempted during boot or play
 *   • LATE JOIN (#33): a THIRD instance that arrives after Start — the friend who
 *     turns up two floors in — lands on the floor the host is actually on, with
 *     no flash of floor 1 on the way. Records that page to mp4 (lib.mjs muxVideo).
 *
 * Requires a built dist/ (pnpm run build) and ffmpeg on PATH.
 * Exit code is the verdict.
 * Run: node e2e/offline-coop.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { muxVideo } from './lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', 'dist')
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const PORT = Number(process.env.OFFLINE_PORT ?? 8123)

const failures = []
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures.push(msg)
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/** The dumbest possible static server — proves nothing server-side is needed. */
const serveDist = async () => {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`)
      let p = normalize(join(ROOT, decodeURIComponent(url.pathname)))
      if (!p.startsWith(ROOT)) {
        res.writeHead(403).end()
        return
      }
      let s = await stat(p).catch(() => null)
      if (s?.isDirectory()) {
        p = join(p, 'index.html')
        s = await stat(p).catch(() => null)
      }
      if (!s) {
        // SPA fallback, same as a Capacitor webview serving index.html.
        p = join(ROOT, 'index.html')
        s = await stat(p).catch(() => null)
        if (!s) {
          res.writeHead(404).end()
          return
        }
      }
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
      createReadStream(p).pipe(res)
    } catch {
      res.writeHead(500).end()
    }
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  return { stop: () => new Promise((r) => server.close(r)) }
}

const until = async (page, fn, ms = 20000, step = 200) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(fn)) return true
    } catch {
      /* page still navigating */
    }
    await sleep(step)
  }
  return false
}

/**
 * Take the stairs, the way the game does: unlock the exit and stand a live
 * player on the exit tile, then let the host's own missionSystem call nextFloor.
 * No test-only backdoor — this is the real transition, so the floor the late
 * joiner has to match is a floor the sim genuinely produced.
 *
 * Re-applied every poll because the movement systems keep running underneath.
 */
const advanceHostFloor = async (page, ms = 20000) => {
  const before = await page.evaluate(() => globalThis.world?.floor ?? 0)
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const now = await page.evaluate((from) => {
      const w = globalThis.world
      if (!w) return 0
      // Once we HAVE moved on, touch nothing: re-unlocking the new floor's exit
      // and re-teleporting onto it would immediately take a second staircase and
      // overshoot (floor 2 → 4 instead of 3).
      if (w.floor !== from) return w.floor
      w.mission.exitUnlocked = true
      for (const e of w.entities) {
        if (!e.playerCtl || e.dead || e.playerCtl.downed) continue
        e.pos.x = w.level.exit.x + 0.5
        e.pos.y = w.level.exit.y + 0.5
        e.prevPos.x = e.pos.x
        e.prevPos.y = e.pos.y
        break
      }
      return w.floor
    }, before)
    if (now > before) return now
    await sleep(100)
  }
  return before
}

const main = async () => {
  await readFile(join(ROOT, 'index.html')).catch(() => {
    console.error(`[offline] no built dist at ${ROOT} — run: pnpm run build`)
    process.exit(2)
  })

  const server = await serveDist()
  const BASE = `http://127.0.0.1:${PORT}`
  const browser = await chromium.launch({ headless: true })
  const errs = []
  /** Every request the app tried to send anywhere but our local server. */
  const external = []
  const videoDir = join(OUT, 'video-offline-coop')
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })
  /** The late joiner's playwright video handle, muxed to mp4 after close. */
  let lateVideo = null

  try {
    // ONE context: BroadcastChannel only reaches same-origin contexts in the
    // same browser, which is exactly the two-tabs co-op path. Every page in it
    // records its own webm; we keep the late joiner's as the video proof.
    const ctx = await browser.newContext({
      viewport: { width: 900, height: 600 },
      recordVideo: { dir: videoDir, size: { width: 900, height: 600 } },
    })

    // Hard-block anything off-box. This is the campsite: no DNS, no route.
    // OFFLINE_SELFTEST=1 also kills the app's main JS chunk, so the instances
    // cannot boot. The harness MUST go red — a test that cannot fail is noise.
    const selfTest = process.env.OFFLINE_SELFTEST === '1'
    await ctx.route('**/*', (route) => {
      const url = route.request().url()
      if (selfTest && /assets\/.*\.js(\?|$)/.test(url)) return route.abort('failed')
      const local = url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')
      if (local) return route.continue()
      external.push(url)
      return route.abort('internetdisconnected')
    })

    const host = await ctx.newPage()
    const client = await ctx.newPage()
    for (const [tag, p] of [
      ['host', host],
      ['client', client],
    ]) {
      p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e}`))
      p.on('console', (m) => m.type() === 'error' && errs.push(`${tag} console: ${m.text()}`))
    }

    console.log('[offline] cold boot, all external network blocked')
    await host.goto(`${BASE}/?mode=host&transport=tabs&room=camp&seed=424242&name=HostPhone`, { waitUntil: 'load' })
    const hostBooted = await until(host, () => !!document.querySelector('#players') || !!globalThis.world, 25000)
    check(hostBooted, 'host instance boots to the hosting lobby with no internet')

    await client.goto(`${BASE}/?mode=join&transport=tabs&room=camp&name=FriendPhone`, { waitUntil: 'load' })

    console.log('[offline] joining…')
    const twoInLobby = await until(host, () => document.querySelectorAll('#players > div').length >= 2, 25000)
    check(twoInLobby, 'client joins the host lobby offline (2 players listed)')

    if (twoInLobby) {
      await host.getByRole('button', { name: 'Start game' }).click()
      const hostPlaying = await until(host, () => (globalThis.world?.tick ?? 0) > 60, 25000)
      const clientPlaying = await until(client, () => (globalThis.world?.tick ?? 0) > 60, 25000)
      check(hostPlaying, 'host world starts and ticks past 60 offline')
      check(clientPlaying, 'client world starts and ticks past 60 offline (synced from the host)')

      await sleep(3000)
      const snap = async (p) =>
        p.evaluate(() => ({
          tick: globalThis.world?.tick ?? 0,
          entities: globalThis.world?.entities?.length ?? 0,
        }))
      const hs = await snap(host)
      const cs = await snap(client)
      console.log(`[offline] host=${JSON.stringify(hs)} client=${JSON.stringify(cs)}`)
      check(hs.entities > 0, 'host world has entities offline')
      check(cs.entities > 0, 'client world has entities offline')

      await host.screenshot({ path: join(OUT, 'offline-host.png') }).catch(() => {})
      await client.screenshot({ path: join(OUT, 'offline-client.png') }).catch(() => {})

      // ── LATE JOIN (#33) ───────────────────────────────────────────────────
      // The friend who turns up two floors in. Everything above joined from the
      // lobby BEFORE Start, which is the one case where the client's old
      // hardcoded `floor = 1` happened to be right — so none of it could ever
      // catch this. Push the party off floor 1 first, then join.
      console.log('[offline] taking the party up two floors before the late join…')
      const f2 = await advanceHostFloor(host)
      const f3 = await advanceHostFloor(host)
      check(f3 === 3, `host reaches floor 3 before the late join (saw ${f2} then ${f3})`)

      if (f3 === 3) {
        const late = await ctx.newPage()
        late.on('pageerror', (e) => errs.push(`late pageerror: ${e}`))
        late.on('console', (m) => m.type() === 'error' && errs.push(`late console: ${m.text()}`))
        lateVideo = late.video()

        // Sample the floor from the first instant the app exposes a world, so a
        // flash of the WRONG map is caught rather than smoothed over. `window.world`
        // only appears once the join has reached `playing`, and a host State
        // message would repair a bad floor within ~500ms — far too late to be a
        // fair test if we only looked at the end.
        await late.addInitScript(() => {
          window.__floorTrail = []
          setInterval(() => {
            const f = globalThis.world?.floor
            if (typeof f !== 'number' || f <= 0) return
            const t = window.__floorTrail
            if (t[t.length - 1] !== f) t.push(f)
          }, 10)
        })

        console.log('[offline] third instance joining a run already on floor 3…')
        await late.goto(`${BASE}/?mode=join&transport=tabs&room=camp&name=LatePhone`, { waitUntil: 'load' })

        const latePlaying = await until(late, () => (globalThis.world?.tick ?? 0) > 0, 25000)
        check(latePlaying, 'late joiner drops into the running game (no lobby wait, no restart)')

        // NOT asserted: that the joiner's world fills with entities. On a busy
        // floor the host's reliable lane starves the snapshot slot and NOBODY
        // gets snapshots any more — the lobby client measured identically (see
        // #34). That is a pre-existing, join-order-independent defect, so failing
        // the late-join proof on it would be blaming the wrong change. Reported,
        // not asserted, until #34 lands.
        //
        // It does sharpen why this fix matters: with no snapshot ever arriving,
        // the old build's "the first snapshot corrects the floor" self-heal never
        // fires at all, and a late joiner is stranded on floor 1 for the whole run.
        await sleep(2500) // let the joiner actually play a beat, for the video
        const entities = await late.evaluate(() => globalThis.world?.entities?.length ?? 0)
        if (entities === 0) console.log('[offline] note: joiner world still empty — snapshot starvation, see #34')

        const trail = await late.evaluate(() => window.__floorTrail ?? [])
        const lateFloor = await late.evaluate(() => globalThis.world?.floor ?? 0)
        const hostFloor = await host.evaluate(() => globalThis.world?.floor ?? 0)
        console.log(
          `[offline] late joiner floor trail=${JSON.stringify(trail)} floor=${lateFloor} entities=${entities} (host floor ${hostFloor})`,
        )

        // The headline: the whole floor trail, not just where it ended up. The
        // pre-fix build self-heals off the first snapshot, so an end-state check
        // alone would pass on the bug — the trail catches the floor-1 flash.
        check(lateFloor === hostFloor, `late joiner is on the host's floor (${lateFloor} vs host ${hostFloor})`)
        check(trail[0] === hostFloor, `late joiner's FIRST floor is the host's (${trail[0]}), not a floor-1 flash`)
        check(!trail.includes(1), `late joiner never renders floor 1 (trail ${JSON.stringify(trail)})`)

        await late.screenshot({ path: join(OUT, 'offline-late-join.png') }).catch(() => {})
        await host.screenshot({ path: join(OUT, 'offline-host-floor3.png') }).catch(() => {})
      }
    }

    // The headline offline assertion.
    const uniqueExternal = [...new Set(external)]
    if (uniqueExternal.length > 0) {
      console.log('[offline] external requests attempted (all blocked):')
      for (const u of uniqueExternal.slice(0, 20)) console.log(`    ${u}`)
    }
    check(uniqueExternal.length === 0, 'the app attempts NO off-box request during boot or co-op play')

    if (errs.length) {
      for (const e of [...new Set(errs)].slice(0, 15)) console.error(`  FAIL ${e}`)
      failures.push(`${errs.length} page error(s) while offline`)
    }
  } finally {
    await browser.close() // finalises every page's webm
    await server.stop()
  }

  // Video proof of the late join, through lib.mjs's shared muxer. The context
  // recorded all three pages into one dir, so stage just the joiner's webm and
  // hand that directory over.
  if (lateVideo) {
    try {
      const stageDir = join(OUT, 'video-offline-late-join')
      rmSync(stageDir, { recursive: true, force: true })
      mkdirSync(stageDir, { recursive: true })
      // Windows keeps a handle on the webm for a moment after browser.close(),
      // so the first rename can lose a race with chromium's own file release.
      const src = await lateVideo.path()
      const dst = join(stageDir, 'late-join.webm')
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(src, dst)
          break
        } catch (e) {
          if (attempt >= 20) throw e
          await sleep(250)
        }
      }
      const { mp4, bytes } = muxVideo('offline-late-join', stageDir)
      console.log(`[offline] late-join video: ${mp4} (${(bytes / 1024).toFixed(0)} KB)`)
      check(bytes > 20_000, `late-join video is a real recording (${bytes} bytes)`)
    } catch (e) {
      check(false, `late-join video failed to mux: ${e.message}`)
    }
  } else {
    check(false, 'no late-join video was recorded')
  }
  // The host/client webms are of no interest, and Windows can still hold a lock
  // on them for a moment after close — never fail the run over housekeeping.
  try {
    rmSync(join(OUT, 'video-offline-coop'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* leftover webm; harmless */
  }

  if (failures.length) {
    console.error(`\n[offline] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[offline] OK — offline co-op works, and a late joiner lands on the host’s floor')
  process.exit(0)
}

main().catch((e) => {
  console.error('[offline] harness crashed:', e)
  process.exit(2)
})
