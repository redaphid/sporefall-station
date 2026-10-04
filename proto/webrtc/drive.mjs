// Usage: node drive.mjs <durS> <conditions json> <paths csv> <out.jsonl>
import net from 'node:net'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/home/hypnodroid/Projects/sporefall-station/.claude/worktrees/agent-a175e656a85e49dfc/package.json')
const { chromium } = require('playwright')

const D = '/tmp/claude-1000/wrtc94'
const [durS, condJson, pathsCsv, out] = process.argv.slice(2)
const conditions = JSON.parse(condJson)
const paths = pathsCsv.split(',')
const PROXY_IP = '10.0.136.62'

const ctl = (path, msg) => new Promise((res, rej) => {
  const c = net.connect(path, () => c.end(msg))
  let s = ''
  c.on('data', (d) => (s += d))
  c.on('end', () => res(s))
  c.on('error', rej)
})

const browser = await chromium.connectOverCDP('http://127.0.0.1:9273')
const page = browser.contexts()[0].pages().find((p) => p.url().includes(':8853'))
await page.reload()
await page.waitForFunction(() => typeof window.runBench === 'function')
await page.bringToFront()
for (const cond of conditions) {
  const tc = await ctl(`${D}/ctl.sock`, `${cond.delay} ${cond.loss}`)
  console.log(cond.name, '|', tc.trim())
  for (const path of paths) {
    await ctl(`${D}/reset.sock`, 'x')
    try {
      const r = await page.evaluate((o) => window.runBench(o), {
        path, durS: +durS, wsBase: 'ws://localhost:8852/ws', proxyIp: PROXY_IP, ua: 40051, ub: 40052,
      })
      const row = { cond: cond.name, ...r }
      console.log(JSON.stringify(row))
      fs.appendFileSync(out, JSON.stringify(row) + '\n')
    } catch (e) {
      console.log(cond.name, path, 'ERROR', e.message.split('\n')[0])
    }
  }
}
await ctl(`${D}/ctl.sock`, '0 0')
await browser.close().catch(() => {})
process.exit(0)
