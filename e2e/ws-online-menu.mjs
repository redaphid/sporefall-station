// "Play online" end to end, through the start menu a player actually sees: one
// browser hosts and reads its room code off the lobby, a second types that code
// in (lower-case, as a thumb would) and joins over the real relay (a Durable
// Object under `wrangler dev`). A third player who types a code nobody hosts
// must wait in their own room and never leak into the host's lobby.
//
// Requires a built dist/: `pnpm run build && node e2e/ws-online-menu.mjs`, or
// ./e2e/run-ws.sh. `E2E_CDP` drives an already-running headed Chrome instead of
// headless chromium (see acquireBrowser in lib.mjs).
//
// Env: WS_E2E_PORT (8787), E2E_OUT (e2e/output), E2E_CDP.

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
    if (await page.evaluate(fn, arg)) return true
    await sleep(200)
  }
  return false
}

const main = async () => {
  mkdirSync(OUT, { recursive: true })
  console.log('[online] starting wrangler dev (built dist + relay)…')
  const wrangler = await startWrangler(PORT)
  const { browser, shared } = await acquireBrowser()
  const errs = []
  const contexts = []
  const open = async (tag) => {
    const videoDir = join(OUT, `video-ws-online-${tag}`)
    const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } })
    contexts.push({ ctx, tag, videoDir })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e}`))
    page.on('console', (m) => m.type() === 'error' && errs.push(`${tag} console: ${m.text()}`))
    await page.goto(`${BASE}/?name=${tag}`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /Play online/ }).click()
    return page
  }
  const shot = (page, label) => page.screenshot({ path: join(OUT, `ws-online-${label}.png`) })
  try {
    const host = await open('Host')
    await shot(host, '01-online-screen')
    await host.getByRole('button', { name: 'Host online game' }).click()
    const code = (await host.locator('#room-code').textContent({ timeout: 15000 }))?.trim() ?? ''
    console.log(`[online] host's room code: ${code}`)
    check(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `host lobby shows a readable 4-character code ("${code}")`)
    await shot(host, '02-host-lobby-code')

    const guest = await open('Guest')
    await guest.locator('[data-role="online-code"]').fill(code.toLowerCase())
    await guest.getByRole('button', { name: 'Join', exact: true }).click()
    check(
      await until(host, () => document.querySelectorAll('#players > div').length === 2),
      'the guest who typed the code appears in the host lobby',
    )
    await shot(guest, '03-guest-lobby')

    const stranger = await open('Stranger')
    const other = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
    await stranger.locator('[data-role="online-code"]').fill(other)
    await stranger.getByRole('button', { name: 'Join', exact: true }).click()
    check(
      await until(stranger, (c) => document.body.innerText.includes(`Waiting for the host of ${c}`), other),
      'a code nobody hosts waits for its host and says which code',
    )
    await sleep(1500)
    check(
      (await host.evaluate(() => document.querySelectorAll('#players > div').length)) === 2,
      "a different code never lands in this host's lobby",
    )
    await shot(stranger, '04-stranger-waiting')

    await host.getByRole('button', { name: 'Start game' }).click()
    const ticking = (p) => until(p, () => (globalThis.world?.tick ?? 0) > 60, undefined, 30000)
    check(await ticking(host), 'host run starts')
    check(await ticking(guest), "guest's world ticks from the host's snapshots")
    const players = await host.evaluate(() => globalThis.world.entities.filter((e) => e.playerCtl).length)
    check(players === 2, `the host world holds both players (${players})`)
    await guest.keyboard.down('KeyD')
    await sleep(1200)
    await guest.keyboard.up('KeyD')
    await shot(host, '05-host-playing')
    await shot(guest, '06-guest-playing')

    const back = await open('Backer')
    await back.getByRole('button', { name: 'Back' }).click()
    check(
      await until(back, () => !!document.querySelector('[data-role="start-menu"]')),
      'Back from Play online returns to the start menu',
    )

    if (errs.length) {
      for (const e of errs) console.error(`  FAIL ${e}`)
      failures.push(`${errs.length} page error(s)`)
    }
  } finally {
    for (const { ctx } of contexts) await ctx.close().catch(() => {})
    for (const { tag, videoDir } of contexts) {
      if (tag !== 'Host' && tag !== 'Guest') {
        rmSync(videoDir, { recursive: true, force: true })
        continue
      }
      const { mp4 } = muxVideo(`ws-online-${tag.toLowerCase()}`, videoDir)
      console.log(`[online] video: ${mp4}`)
    }
    if (shared) await releaseBrowser()
    else await browser.close()
    await wrangler.stop()
  }

  if (failures.length) {
    console.error(`\n[online] ${failures.length} FAILURE(S)`)
    process.exit(1)
  }
  console.log('\n[online] OK: Play online hosts and joins by room code (stills + videos in e2e/output)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
