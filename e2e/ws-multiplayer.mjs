// End-to-end proof of WebSocket co-op through the REAL stack: two headless
// browsers running the actual built game, connected over the Cloudflare Worker
// relay (a Durable Object) served by `wrangler dev`. One page hosts
// (?mode=host&transport=ws), the other joins (?mode=join&transport=ws) into the
// same room — the same unified origin serves both the game and the /ws relay, so
// resolveWsBaseUrl's same-origin default is what gets exercised.
//
// Asserts the full multiplayer path end to end:
//   • the client appears in the host's lobby (WsTransport peerConnected fired
//     through the real DO, in-app)
//   • pressing Start begins the game on BOTH peers (host authoritative, client
//     synced) and the client's world ticks forward in lock-ish step
//
// Requires a built dist/. Run via ./e2e/run-ws.sh (builds first), or directly
// after `pnpm run build`: node e2e/ws-multiplayer.mjs
//
// Env: WS_E2E_PORT (8787), E2E_OUT (e2e/output).

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { startWrangler } from './ws-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.WS_E2E_PORT ?? 8787)
const BASE = `http://localhost:${PORT}`
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const ROOM = 'e2e-mp'
const SIZE = { width: 960, height: 600 }

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    failures.push(msg)
  }
}

/** Poll `fn()` on a page until truthy or timeout. */
const until = async (page, fn, ms = 15000, step = 200) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await page.evaluate(fn)) return true
    await sleep(step)
  }
  return false
}

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  console.log('[ws-mp] starting wrangler dev (serving built dist + relay)…')
  const wrangler = await startWrangler(PORT)
  const browser = await chromium.launch({ headless: true })
  const errs = []
  try {
    const hostCtx = await browser.newContext({ viewport: SIZE })
    const clientCtx = await browser.newContext({ viewport: SIZE })
    const host = await hostCtx.newPage()
    const client = await clientCtx.newPage()
    for (const [tag, p] of [
      ['host', host],
      ['client', client],
    ]) {
      p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e}`))
      p.on('console', (m) => m.type() === 'error' && errs.push(`${tag} console: ${m.text()}`))
    }

    // Host boots straight into the hosting lobby; client joins the same room.
    console.log('[ws-mp] opening host + client…')
    await host.goto(`${BASE}/?mode=host&transport=ws&room=${ROOM}&seed=424242&name=Host`, { waitUntil: 'networkidle' })
    await client.goto(`${BASE}/?mode=join&transport=ws&room=${ROOM}&name=Client`, { waitUntil: 'networkidle' })

    // The client should show up in the host's lobby — proof the WsTransport link
    // came up in-app through the real Durable Object.
    console.log('[ws-mp] waiting for the client to appear in the host lobby…')
    const twoInLobby = await until(host, () => document.querySelectorAll('#players > div').length >= 2, 20000)
    check(twoInLobby, 'client joins the host lobby over the WS relay (2 players listed)')
    await host.screenshot({ path: join(OUT, 'ws-mp-lobby.png') })

    // Host presses Start (a real user gesture) → the game begins for both.
    console.log('[ws-mp] pressing Start…')
    await host.getByRole('button', { name: 'Start game' }).click()

    const hostPlaying = await until(host, () => (globalThis.world?.tick ?? 0) > 30, 20000)
    const clientPlaying = await until(client, () => (globalThis.world?.tick ?? 0) > 30, 20000)
    check(hostPlaying, 'host world starts and ticks past 30')
    check(clientPlaying, "client world starts and ticks past 30 (synced from the host's snapshots)")

    // Both worlds are populated, and the client is tracking the host's tick.
    const state = async (p) =>
      p.evaluate(() => ({ tick: globalThis.world?.tick ?? 0, entities: globalThis.world?.entities?.length ?? 0 }))
    const hs = await state(host)
    const cs = await state(client)
    console.log(`[ws-mp] host=${JSON.stringify(hs)} client=${JSON.stringify(cs)}`)
    check(hs.entities > 0, 'host world has entities')
    check(cs.entities > 0, 'client world has entities (mirrored from host)')
    check(Math.abs(hs.tick - cs.tick) < 200, 'client tick tracks the host tick (not diverged/stalled)')

    await host.screenshot({ path: join(OUT, 'ws-mp-host-play.png') })
    await client.screenshot({ path: join(OUT, 'ws-mp-client-play.png') })

    if (errs.length) {
      for (const e of errs) console.error(`  FAIL ${e}`)
      failures.push(`${errs.length} page error(s)`)
    }
  } finally {
    await browser.close()
    await wrangler.stop()
  }

  if (failures.length) {
    console.error(`\n[ws-mp] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[ws-mp] OK — WebSocket co-op works end to end (screenshots in e2e/output)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
