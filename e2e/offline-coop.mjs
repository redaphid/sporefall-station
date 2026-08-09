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
 *
 * Requires a built dist/ (pnpm run build). Exit code is the verdict.
 * Run: node e2e/offline-coop.mjs
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

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

  try {
    // ONE context: BroadcastChannel only reaches same-origin contexts in the
    // same browser, which is exactly the two-tabs co-op path.
    const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } })

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
    await browser.close()
    await server.stop()
  }

  if (failures.length) {
    console.error(`\n[offline] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[offline] OK — two-instance co-op works with no internet at all')
  process.exit(0)
}

main().catch((e) => {
  console.error('[offline] harness crashed:', e)
  process.exit(2)
})
