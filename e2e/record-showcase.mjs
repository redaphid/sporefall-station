import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const OUT = process.env.E2E_OUT ?? join(__dirname, 'output')
const VIDEO_DIR = join(OUT, 'showcase-video')

rmSync(VIDEO_DIR, { recursive: true, force: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[showcase]', ...a)

const main = async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`${BASE}/asset-showcase.html`, { waitUntil: 'networkidle' })
  log('loaded showcase')
  await page.screenshot({ path: join(OUT, 'assets-showcase-first.png') })
  await page.waitForFunction(() => window.__showcaseDone === true, { timeout: 40000 })
  await sleep(500)
  await page.screenshot({ path: join(OUT, 'assets-showcase-grid.png') })
  log('showcase complete')

  await page.close()
  await context.close()
  await browser.close()

  const webm = readdirSync(VIDEO_DIR).find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error('no showcase webm produced')
  renameSync(join(VIDEO_DIR, webm), join(OUT, 'assets-showcase.webm'))
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
  log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
