// Online play goes peer to peer: two browser contexts host and join through the
// start menu against `wrangler dev`, the relay signals a WebRTC link between
// them, and they play over it. Checks that both sides report the P2P path, that
// ICE picked a host-to-host candidate pair (same machine, so same network: no
// STUN or internet hairpin), that the guest moves on the host's world, and that
// the link chip reads "P2P <n> ms". A second room with ?p2p=0 on the host proves
// the relay path still plays and its chip reads "Relay".
//
// Requires a built dist/: `pnpm run build && node e2e/ws-p2p.mjs`.
// Env: WS_E2E_PORT (8787), E2E_OUT (e2e/output), E2E_CDP (drive a running Chrome).

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { acquireBrowser, muxVideo, OUT, releaseBrowser } from './lib.mjs'
import { startWrangler } from './ws-lib.mjs'

const PORT = Number(process.env.WS_E2E_PORT ?? 8787)
const BASE = `http://localhost:${PORT}`
const SIZE = { width: 960, height: 600 }

const failures = []
const check = (cond, msg) => {
  if (cond) console.log(`  ok  ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    failures.push(msg)
  }
}

const until = async (page, fn, arg, ms = 20000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true
    await sleep(200)
  }
  return false
}

const session = (page) => page.evaluate(() => globalThis.sporefall?.session() ?? {})
const chip = (page) => page.evaluate(() => document.querySelector('[data-role="link-chip"]')?.textContent ?? '')

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  console.log('[p2p] starting wrangler dev (built dist + relay)…')
  const wrangler = await startWrangler(PORT)
  const { browser, shared } = await acquireBrowser()
  const errs = []
  const contexts = []
  const open = async (tag, query = '') => {
    const videoDir = join(OUT, `video-ws-p2p-${tag}`)
    rmSync(videoDir, { recursive: true, force: true })
    const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
    contexts.push({ ctx, tag, videoDir })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e}`))
    page.on('console', (m) => m.type() === 'error' && errs.push(`${tag} console: ${m.text()}`))
    await page.goto(`${BASE}/?name=${tag}${query}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Play online/ }).click()
    return page
  }
  const shot = (page, label) => page.screenshot({ path: join(OUT, `ws-p2p-${label}.png`) })

  const playPair = async (tag, hostQuery) => {
    const host = await open(`${tag}Host`, hostQuery)
    await host.getByRole('button', { name: 'Host online game' }).click()
    await until(host, () => (document.querySelector('#room-code')?.textContent ?? '').length > 0)
    const code = (await host.locator('#room-code').textContent())?.trim() ?? ''
    const guest = await open(`${tag}Guest`)
    await guest.locator('[data-role="online-code"]').fill(code)
    await guest.getByRole('button', { name: 'Join', exact: true }).click()
    await until(host, () => document.querySelectorAll('#players > div').length === 2)
    await host.getByRole('button', { name: 'Start game' }).click()
    const ticking = (p) => until(p, () => (globalThis.world?.tick ?? 0) > 60, undefined, 30000)
    check(await ticking(host), `${tag}: host run starts`)
    check(await ticking(guest), `${tag}: guest world ticks from the host's snapshots`)
    return { host, guest }
  }

  try {
    const { host, guest } = await playPair('p2p', '')
    check(
      await until(guest, () => globalThis.sporefall.session().link?.path === 'p2p'),
      'guest reports the P2P path',
    )
    check(await until(host, () => globalThis.sporefall.session().link?.path === 'p2p'), 'host reports the P2P path')
    check(
      await until(guest, () => Object.values(globalThis.sporefall.session().pairs ?? {}).some((p) => p), undefined, 5000),
      'guest has a selected ICE candidate pair',
    )
    const pairs = { guest: (await session(guest)).pairs, host: (await session(host)).pairs }
    console.log(`[p2p] candidate pairs: ${JSON.stringify(pairs)}`)
    const all = [...Object.values(pairs.guest ?? {}), ...Object.values(pairs.host ?? {})].filter(Boolean)
    // A remote "prflx" is the peer's own host address, learned from its first
    // connectivity check before its trickled (mDNS) candidate resolved. Either
    // way the pair is LAN to LAN: no STUN-mapped (srflx) or relayed candidate.
    check(
      all.length >= 2 && all.every((p) => p.local === 'host' && (p.remote === 'host' || p.remote === 'prflx')),
      'ICE picked a LAN pair (local host, remote host or prflx) on both ends',
    )

    const guestSlotX = () =>
      host.evaluate(() => globalThis.world.entities.find((e) => e.playerCtl?.playerId === 1)?.pos.x ?? NaN)
    const x0 = await guestSlotX()
    await guest.bringToFront()
    await guest.keyboard.down('KeyD')
    await sleep(1500)
    await guest.keyboard.up('KeyD')
    await sleep(300)
    const x1 = await guestSlotX()
    check(x1 - x0 > 1.5, `the guest walked on the host's world over the direct link (${(x1 - x0).toFixed(2)} tiles)`)
    check(await until(guest, () => /^P2P \d+ ms$/.test(document.querySelector('[data-role="link-chip"]')?.textContent ?? '')), `guest chip reads "${await chip(guest)}"`)
    check(/^P2P \d+ ms$/.test(await chip(host)) || (await chip(host)) === 'P2P', `host chip reads "${await chip(host)}"`)
    const s = await session(guest)
    console.log(`[p2p] guest link ${JSON.stringify(s.link)}, prediction corrections ${s.predictionCorrections}`)
    await shot(host, '01-host-p2p')
    await shot(guest, '02-guest-p2p')

    const relay = await playPair('relay', '&p2p=0')
    check(
      await until(relay.guest, () => /^Relay \d+ ms$/.test(document.querySelector('[data-role="link-chip"]')?.textContent ?? '')),
      `with ?p2p=0 on the host, the guest plays over the relay and its chip reads "${await chip(relay.guest)}"`,
    )
    await shot(relay.guest, '03-guest-relay')
  } finally {
    for (const { ctx, tag, videoDir } of contexts) {
      await ctx.close().catch(() => {})
      try {
        muxVideo(`ws-p2p-${tag}`, videoDir)
      } catch {
        /* no video for this context */
      }
    }
    if (!shared) await browser.close().catch(() => {})
    else await releaseBrowser()
    await wrangler.stop()
  }
  check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(' | ')})`)
  if (failures.length) {
    console.error(`\n[p2p] ${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\n[p2p] all checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
