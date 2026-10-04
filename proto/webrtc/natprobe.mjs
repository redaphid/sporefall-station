import { createRequire } from 'node:module'
const require = createRequire('/home/hypnodroid/Projects/sporefall-station/.claude/worktrees/agent-a175e656a85e49dfc/package.json')
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9273')
const page = browser.contexts()[0].pages().find((p) => p.url().includes(':8853'))
for (let i = 0; i < 2; i++) {
  const c = await page.evaluate(() => window.natProbe(['stun:stun.cloudflare.com:3478']))
  console.log(c.map((s) => s.replace(/\b(\d+\.\d+)\.\d+\.\d+\b/g, '$1.x.x').replace(/ generation.*/, '')).join('\n'))
  console.log('--')
}
process.exit(0)
