// A host quits to the main menu mid-run, in real pages over ?transport=tabs
// (BroadcastChannel, the same session and protocol code BLE uses). The host
// lands on a fresh start menu; the joiner hears the host leave, gets a "HOST
// LEFT" menu by itself without ever trying to reconnect, and its own Main menu
// takes it home too. Screenshots land in e2e/output/host-leaves/.
//
//   BASE_URL=http://127.0.0.1:4990 node e2e/host-leaves.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4990'
const OUT = join(process.env.E2E_OUT ?? 'e2e/output', 'host-leaves')
mkdirSync(OUT, { recursive: true })
const ROOM = `leave-${process.pid}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const until = async (page, what, fn, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn).catch(() => undefined)
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-software-rasterizer'] })
const context = await browser.newContext({ viewport: { width: 1100, height: 700 } })
const host = await context.newPage()
const client = await context.newPage()
const errors = { host: [], client: [] }
host.on('pageerror', (e) => errors.host.push(String(e)))
client.on('pageerror', (e) => errors.client.push(String(e)))

await host.goto(`${BASE}/?mode=host&transport=tabs&room=${ROOM}&seed=424242&name=Host`)
await client.goto(`${BASE}/?mode=join&transport=tabs&room=${ROOM}&name=Friend`)
await until(host, 'the friend in the lobby', () => document.querySelectorAll('#players > div').length >= 2)
await host.getByRole('button', { name: 'Start game' }).click()
await until(host, 'the host world', () => window.world?.tick > 60)
await until(client, 'the client world', () => window.world?.tick > 60 || window.sporefall?.session?.()?.tick > 60)

const r = {}
// Host: ☰, then Main menu twice.
await host.click('[data-role="pause-button"]')
r.hostMenuTitle = await host.textContent('[data-role="pause-title"]')
await host.click('[data-role="pause-main-menu"]')
r.hostArmed = await host.textContent('[data-role="pause-main-menu"]')
await host.evaluate(() => (window.__oldPage = true))
const phases = []
await client.exposeFunction('__phase', (p) => phases.push(p))
await client.evaluate(() => {
  const title = () => document.querySelector('[data-role="pause-title"]')?.textContent
  const seen = new Set()
  setInterval(() => {
    const t = title()
    const mission = document.body.innerText.includes('reconnecting') ? 'reconnecting' : null
    for (const s of [t, mission]) if (s && !seen.has(s)) (seen.add(s), window.__phase(s))
  }, 50)
})
await host.click('[data-role="pause-main-menu"]')
await until(host, 'the host start menu', () => !window.__oldPage && document.querySelector('[data-role="start-menu"]') !== null)
r.hostSearch = await host.evaluate(() => location.search)
await until(client, 'the client to hear the host leave', () => document.querySelector('[data-role="pause-title"]')?.textContent === 'HOST LEFT')
await sleep(1500) // long enough for a drop to start its reconnect loop, if it were going to
r.clientTitle = await client.textContent('[data-role="pause-title"]')
r.clientPhasesSeen = phases
await client.screenshot({ path: join(OUT, 'client-host-left.png') })
// Client: its own Main menu takes it home.
await client.evaluate(() => (window.__oldPage = true))
await client.click('[data-role="pause-main-menu"]')
await client.click('[data-role="pause-main-menu"]')
await until(client, 'the client start menu', () => !window.__oldPage && document.querySelector('[data-role="start-menu"]') !== null)
r.clientSearch = await client.evaluate(() => location.search)
r.errors = errors
await browser.close()

const NO_WEBGL = /reading 'updateRenderable'/
const realErrors = [...errors.host, ...errors.client].filter((e) => !NO_WEBGL.test(e))
const checks = [
  ['a net host gets a menu (not PAUSED) with a two-press Main menu', r.hostMenuTitle === 'MENU' && r.hostArmed === 'Quit to the menu? Press again'],
  ['the host lands on a fresh start menu with no params', r.hostSearch === ''],
  ['the client is told the host left, and never tries to reconnect', r.clientTitle === 'HOST LEFT' && !phases.includes('reconnecting')],
  ["the client's Main menu takes it home too", r.clientSearch === ''],
  ['no page errors (besides headless no-WebGL)', realErrors.length === 0],
]
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ r, checks }, null, 2))
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
console.log(JSON.stringify(r))
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
