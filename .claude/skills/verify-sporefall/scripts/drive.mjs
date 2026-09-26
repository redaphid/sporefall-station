#!/usr/bin/env node
// Drive the served game in headless Chromium with an ordered list of steps and
// write the evidence (run.json, stills, optional mp4) to one directory.
//
//   drive.mjs [--port 4990] [--name label] [--video] [--viewport 1280x720] [--origin https://host] STEP...
//
// --origin loads pages at that origin but answers every request to it from the
// local preview, so this build runs under a real https:// origin. The browser
// then applies its HTTPS-only rules (mixed content, secure context), which the
// http:// preview cannot show.
//
// Steps run in the order given:
//   --open <path>        load BASE+path in a fresh context (resets localStorage).
//                        Returns at navigation commit: main.ts awaits the start
//                        menu at top level, so DOMContentLoaded never fires until a
//                        mode is picked. Gate readiness with --until / --until-tick.
//   --reload <path>      load BASE+path in the SAME context (storage survives)
//   --click <name>       click the button with that accessible name
//   --until-tick <n>     wait until window.world.tick >= n
//   --until <js>         wait until the page expression is truthy
//   --eval <js>          evaluate a page expression, record its JSON result
//   --assert <js>        like --eval, but a falsy result fails the run
//   --shot <label>       full-viewport PNG
//   --wait-ms <n>        wall-clock pause (prefer --until-tick)
//
// Exit 0 only if every --assert held and the page threw nothing.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname }).toString().trim()
const argv = process.argv.slice(2)
const opt = { port: process.env.PORT ?? '4990', name: 'run', video: false, viewport: '1280x720', origin: '' }
const steps = []
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i].replace(/^--/, '')
  if (flag === 'video') opt.video = true
  else if (['port', 'name', 'viewport', 'origin'].includes(flag)) opt[flag] = argv[++i]
  else steps.push({ step: flag, arg: argv[++i] })
}
if (!steps.length || steps[0].step !== 'open') {
  console.error('first step must be --open <path>; see the header of this file')
  process.exit(2)
}

const LOCAL = `http://127.0.0.1:${opt.port}`
const BASE = opt.origin ? new URL(opt.origin).origin : LOCAL
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = resolve(process.env.VERIFY_OUT ?? join(ROOT, 'e2e/output/verify', `${stamp}-${opt.name}`))
mkdirSync(OUT, { recursive: true })
const [width, height] = opt.viewport.split('x').map(Number)

// Under WSL the headless GPU process kills the tab once pixi asks for a context
// (default flags and swiftshader both crash); these two flags are the set that boots.
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-software-rasterizer'] })
let context
let page
const pageErrors = []
const consoleErrors = []
const consoleLog = []
const log = []
let failed = false

const newContext = async () => {
  await context?.close()
  const videoDir = join(OUT, '.video')
  context = await browser.newContext({
    viewport: { width, height },
    ...(opt.video ? { recordVideo: { dir: videoDir, size: { width, height } } } : {}),
  })
  if (opt.origin)
    await context.route(`${BASE}/**`, async (route) => {
      const { pathname, search } = new URL(route.request().url())
      await route.fulfill({ response: await route.fetch({ url: LOCAL + pathname + search }) })
    })
  page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => {
    consoleLog.push(`${m.type()}: ${m.text()}`)
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
}
const tick = () => page.evaluate(() => window.world?.tick ?? null).catch(() => null)
const evalExpr = (js) => page.evaluate((src) => JSON.parse(JSON.stringify((0, eval)(src)) ?? 'null'), js)

for (const { step, arg } of steps) {
  const entry = { step, arg }
  try {
    if (step === 'open') {
      await newContext()
      await page.goto(BASE + arg, { waitUntil: 'commit' })
    } else if (step === 'reload') await page.goto(BASE + arg, { waitUntil: 'commit' })
    else if (step === 'click') await page.getByRole('button', { name: arg }).first().click()
    else if (step === 'until-tick')
      await page.waitForFunction((n) => (window.world?.tick ?? 0) >= n, Number(arg), { timeout: 60000 })
    else if (step === 'until')
      await page.waitForFunction((src) => (0, eval)(src), arg, { timeout: 60000 })
    else if (step === 'eval') entry.result = await evalExpr(arg)
    else if (step === 'assert') {
      entry.result = await evalExpr(arg)
      entry.ok = !!entry.result
      failed ||= !entry.ok
    } else if (step === 'shot') {
      const file = join(OUT, `${String(log.length).padStart(2, '0')}-${arg}.png`)
      await page.screenshot({ path: file })
      entry.file = relative(ROOT, file)
    } else if (step === 'wait-ms') await page.waitForTimeout(Number(arg))
    else throw new Error(`unknown step --${step}`)
  } catch (e) {
    entry.error = String(e).split('\n')[0]
    failed = true
  }
  entry.tick = await tick()
  log.push(entry)
  const mark = entry.error ? 'ERR ' : entry.ok === false ? 'FAIL' : 'ok  '
  console.log(`${mark} --${step} ${arg ?? ''}${entry.result !== undefined ? ` => ${JSON.stringify(entry.result).slice(0, 200)}` : ''}${entry.error ? ` : ${entry.error}` : ''} [tick ${entry.tick}]`)
  if (entry.error) break
}

await context.close()
await browser.close()
let video
if (opt.video) {
  process.env.E2E_OUT = OUT
  const { muxVideo } = await import(join(ROOT, 'e2e/lib.mjs'))
  try {
    video = relative(ROOT, muxVideo(opt.name, join(OUT, '.video')).mp4)
  } catch (e) {
    video = `none: ${e.message}`
    failed = true
  }
}

failed ||= pageErrors.length > 0
const run = { base: BASE, name: opt.name, verdict: failed ? 'FAIL' : 'PASS', steps: log, pageErrors, consoleErrors, consoleLog, video }
writeFileSync(join(OUT, 'run.json'), JSON.stringify(run, null, 2))
console.log(`${run.verdict}  evidence: ${relative(ROOT, OUT)}/run.json${pageErrors.length ? `  pageErrors: ${pageErrors.length}` : ''}`)
process.exit(failed ? 1 : 0)
