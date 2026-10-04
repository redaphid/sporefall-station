// Online play on a bad network, through the start menu and the real relay
// (`wrangler dev`), with ws-fault-proxy.mjs between the pages and the relay:
//
//   1. A host whose first code is already held hosts under a fresh code.
//   2. A host that cannot reach the relay says so, offers Retry, and never Start.
//   3. A guest's link chip shows its round trip.
//   4. Fifteen seconds of silence with the socket open: the chip warns within
//      about 2 s, the guest shows reconnecting within about 5 s, and play
//      resumes on the same avatar once the network comes back.
//   5. The host vanishes without a goodbye: the guest sees HOST LEFT within 2 s.
//
// Requires a built dist/: `pnpm run build && node e2e/ws-online-reliability.mjs`.
// Env: WS_E2E_PORT (8787; the proxy takes the next port), E2E_OUT, E2E_CDP.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { acquireBrowser, muxVideo, OUT, releaseBrowser } from './lib.mjs'
import { startFaultProxy } from './ws-fault-proxy.mjs'
import { startWrangler } from './ws-lib.mjs'

const PORT = Number(process.env.WS_E2E_PORT ?? 8787)
const PROXY = PORT + 1
const BASE = `http://localhost:${PORT}`
const VIA_PROXY = `ws=${encodeURIComponent(`ws://localhost:${PROXY}/ws`)}`
const SIZE = { width: 960, height: 600 }
const HELD_CODE = 'ZZ22'

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    failures.push(msg)
  }
}

/** Poll `fn` on a page; resolves with ms waited, or null on timeout. */
const until = async (page, fn, arg, ms = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg).catch(() => false)) return Date.now() - t0
    await sleep(100)
  }
  return null
}

const chip = (page) => page.evaluate(() => document.querySelector('[data-role="link-chip"]')?.textContent ?? null)
const phase = (page) => page.evaluate(() => globalThis.__sporefall?.phase)
const startButtonShown = (page) =>
  page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Start game'))

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  console.log('[reliability] starting wrangler dev + fault proxy…')
  const wrangler = await startWrangler(PORT)
  const proxy = await startFaultProxy(PROXY, PORT)
  const { browser, shared } = await acquireBrowser()
  const contexts = []
  const errs = []
  const open = async (tag, query, init) => {
    const videoDir = join(OUT, `video-ws-reliability-${tag}`)
    const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
    contexts.push({ ctx, tag, videoDir })
    if (init) await ctx.addInitScript(init)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e}`))
    await page.goto(`${BASE}/?name=${tag}&e2e&${query}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Play online/ }).click()
    return page
  }
  const shot = (page, label) => page.screenshot({ path: join(OUT, `ws-reliability-${label}.png`) })
  let occupant
  try {
    // 1. A held code: the page's first draw is forced onto a room a raw socket holds.
    occupant = new WebSocket(`ws://localhost:${PORT}/ws/online-${HELD_CODE}?role=host`)
    await new Promise((ok, bad) => (occupant.once('open', ok), occupant.once('error', bad)))
    const forceFirstCode = (code) => {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      const real = crypto.getRandomValues.bind(crypto)
      let forced = false
      crypto.getRandomValues = (arr) => {
        if (!forced && arr instanceof Uint8Array && arr.length === code.length) {
          forced = true
          for (let i = 0; i < code.length; i++) arr[i] = alphabet.indexOf(code[i])
          return arr
        }
        return real(arr)
      }
    }
    const taken = await open('Taken', 'x=1', `(${forceFirstCode})(${JSON.stringify(HELD_CODE)})`)
    await taken.getByRole('button', { name: 'Host online game' }).click()
    check((await until(taken, () => document.querySelector('#room-code')?.textContent?.length === 4)) !== null, 'a host under a held code still opens a room')
    const takenCode = await taken.evaluate(() => document.querySelector('#room-code')?.textContent)
    check(takenCode !== HELD_CODE, `it moved off the held code ${HELD_CODE} to ${takenCode}`)
    check(await startButtonShown(taken), 'and only then offers Start')
    await shot(taken, '01-held-code-fresh-room')
    occupant.close()

    // 2. No relay at all.
    const stranded = await open('Stranded', `ws=${encodeURIComponent('ws://localhost:9/ws')}`)
    await stranded.getByRole('button', { name: 'Host online game' }).click()
    check(
      (await until(stranded, () => document.body.innerText.includes("Couldn't open an online room"))) !== null,
      'an unreachable relay says it could not open a room',
    )
    check(!(await startButtonShown(stranded)), 'a failed host never shows Start')
    check(
      await stranded.evaluate(() => ['Retry', 'Back to menu'].every((t) => [...document.querySelectorAll('button')].some((b) => b.textContent === t))),
      'it offers Retry and Back to menu',
    )
    await shot(stranded, '02-unreachable-retry')

    // 3. Host and guest, both through the proxy.
    const host = await open('Host', VIA_PROXY)
    await host.getByRole('button', { name: 'Host online game' }).click()
    await until(host, () => document.querySelector('#room-code')?.textContent?.length === 4)
    const code = await host.evaluate(() => document.querySelector('#room-code').textContent)
    const guest = await open('Guest', VIA_PROXY)
    await guest.locator('[data-role="online-code"]').fill(code)
    await guest.getByRole('button', { name: 'Join', exact: true }).click()
    await until(host, () => document.querySelectorAll('#players > div').length === 2)
    await host.getByRole('button', { name: 'Start game' }).click()
    check((await until(guest, () => globalThis.__sporefall?.phase === 'playing', undefined, 30000)) !== null, 'guest is playing')
    proxy.delay(60, 20)
    const rttShown = await until(guest, () => /^\d+ ms$/.test(document.querySelector('[data-role="link-chip"]')?.textContent ?? ''), undefined, 8000)
    check(rttShown !== null, `guest chip shows its round trip ("${await chip(guest)}")`)
    check((await until(host, () => /\d+ ms$/.test(document.querySelector('[data-role="link-chip"]')?.textContent ?? ''), undefined, 8000)) !== null, `host chip shows its worst player's round trip ("${await chip(host)}")`)
    await shot(guest, '03-guest-chip-rtt')
    proxy.delay(0)

    // The host can share an online moment, and the link replays green.
    await guest.keyboard.down('KeyD')
    await sleep(1500)
    const shared = await host.evaluate(async () => {
      const share = globalThis.sporefallShare
      if (typeof share !== 'function') return { armed: false }
      const r = await share('online two-player moment')
      return { armed: true, url: r.url, rewindTicks: r.rewindTicks, runUpDropped: r.runUpDropped ?? null }
    })
    await guest.keyboard.up('KeyD')
    check(shared.armed, 'window.sporefallShare is armed on an online host')
    check(shared.rewindTicks >= 30, `the share carries the guest's run-up (${shared.rewindTicks} ticks, dropped: ${shared.runUpDropped})`)
    const viewerCtx = await browser.newContext({ viewport: SIZE })
    contexts.push({ ctx: viewerCtx, tag: 'Viewer', videoDir: join(OUT, 'video-ws-reliability-viewer-none') })
    const viewer = await viewerCtx.newPage()
    viewer.on('pageerror', (e) => errs.push(`viewer pageerror: ${e}`))
    // The Worker names the canonical site in the link; the capture lives in this
    // wrangler's local KV, so open the same ?state= here.
    await viewer.goto(`${BASE}/${new URL(shared.url).search}`, { waitUntil: 'networkidle' })
    const verdict = await until(viewer, () => globalThis.__stateReplay !== undefined, undefined, 20000)
    const replay = await viewer.evaluate(() => ({
      ok: globalThis.__stateReplay?.ok,
      reason: globalThis.__stateReplay?.reason,
      players: globalThis.__stateReplay?.world?.entities?.filter((e) => e.playerCtl).length,
    }))
    check(verdict !== null && replay.ok === true, `the shared link replays green on a fresh page (${replay.reason ?? 'ok'})`)
    check(replay.players === 2, `and the replayed world holds both players (${replay.players})`)
    await shot(viewer, '03b-shared-online-moment')
    await viewerCtx.close()

    const playersBefore = await host.evaluate(() => globalThis.world.entities.filter((e) => e.playerCtl).map((e) => e.id).join(','))

    // 4. Fifteen seconds of silence with the socket open.
    proxy.freeze('client', true)
    const t0 = Date.now()
    const weak = await until(guest, () => document.querySelector('[data-role="link-chip"]')?.textContent === 'Weak connection', undefined, 4000)
    check(weak !== null && weak <= 3000, `chip warns "Weak connection" within ~2 s of silence (${weak} ms)`)
    await shot(guest, '04-guest-weak')
    const reconnecting = await until(guest, () => globalThis.__sporefall?.phase === 'reconnecting', undefined, 8000)
    const reconnectAt = reconnecting === null ? null : Date.now() - t0
    check(reconnectAt !== null && reconnectAt <= 6500, `guest shows reconnecting within ~5 s with the socket still open (${reconnectAt} ms)`)
    const banner = await guest.evaluate(() => document.body.innerText)
    check(/reconnecting/i.test(banner) && !/bluetooth/i.test(banner), 'its banner says reconnecting and never Bluetooth')
    await shot(guest, '05-guest-reconnecting')
    await sleep(Math.max(0, 15000 - (Date.now() - t0)))
    proxy.freeze('client', false)
    const back = await until(guest, () => globalThis.__sporefall?.phase === 'playing', undefined, 30000)
    check(back !== null, `guest is playing again ${back} ms after the network returns`)
    await sleep(1500)
    const playersAfter = await host.evaluate(() => globalThis.world.entities.filter((e) => e.playerCtl).map((e) => e.id).join(','))
    check(playersBefore === playersAfter, `the guest reclaimed the same avatar (${playersBefore} -> ${playersAfter})`)
    check(/^\d+ ms$/.test((await chip(guest)) ?? ''), `chip is back to a round trip ("${await chip(guest)}")`)
    await shot(guest, '06-guest-recovered')

    // 5. The host's network vanishes: no Bye, no close frame.
    const t1 = Date.now()
    proxy.kill('host')
    const left = await until(guest, () => document.querySelector('[data-role="pause-title"]')?.textContent === 'HOST LEFT', undefined, 10000)
    check(left !== null && Date.now() - t1 <= 2500, `guest sees HOST LEFT ${Date.now() - t1} ms after the host vanished`)
    check((await phase(guest)) === 'ended', 'and it is ended, not reconnecting')
    check((await chip(guest)) === 'Disconnected', `its chip reads Disconnected ("${await chip(guest)}")`)
    await sleep(500)
    await shot(guest, '07-guest-host-left')

    if (errs.length) {
      for (const e of errs) console.error(`  FAIL ${e}`)
      failures.push(`${errs.length} page error(s)`)
    }
  } finally {
    occupant?.terminate()
    for (const { ctx } of contexts) await ctx.close().catch(() => {})
    for (const { tag, videoDir } of contexts) {
      if (tag !== 'Guest') {
        rmSync(videoDir, { recursive: true, force: true })
        continue
      }
      console.log(`[reliability] video: ${muxVideo('ws-reliability-guest', videoDir).mp4}`)
    }
    if (shared) await releaseBrowser()
    else await browser.close()
    await proxy.close()
    await wrangler.stop()
  }

  if (failures.length) {
    console.error(`\n[reliability] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[reliability] OK (stills + guest video in e2e/output)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
