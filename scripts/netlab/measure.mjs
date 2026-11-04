// Relay vs WebRTC P2P on real game traffic: the real sessions (bench.ts) play a
// scripted run between two Chromium contexts inside the netlab, once per path
// per network profile, and report round trip, snapshot jitter, rubber-banding
// and lost taps.
//   NETLAB_DIR=<scratch dir> node scripts/netlab/measure.mjs [--seconds 60] [--json out.json] [--only hawaii]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { enterNetns, profileToImpairment, startLab } from './lab.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const DIR = process.env.NETLAB_DIR ?? path.join(process.env.TMPDIR ?? '/tmp', 'sporefall-netlab')
const WWW = path.join(DIR, 'www')
const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt)

/** Added round trip and one-way loss, end to end, per path. Hawaii: everyone on
 * one house wifi (P2P stays on the LAN) while the relay sits in San Jose, so
 * every relayed packet crosses the Pacific twice. */
const PROFILES = [
  { name: 'clean', relay: { rttMs: 0, lossPct: 0 }, udp: { rttMs: 0, lossPct: 0 } },
  { name: '+80 ms', relay: { rttMs: 80, lossPct: 0 }, udp: { rttMs: 80, lossPct: 0 } },
  { name: '+80 ms, 2% loss', relay: { rttMs: 80, lossPct: 2 }, udp: { rttMs: 80, lossPct: 2 } },
  { name: '+80 ms, 5% loss', relay: { rttMs: 80, lossPct: 5 }, udp: { rttMs: 80, lossPct: 5 } },
  { name: 'Hawaii (relay +110 ms, 1.5% loss; LAN P2P)', relay: { rttMs: 110, lossPct: 1.5 }, udp: { rttMs: 0, lossPct: 0 } },
]

if (process.env.NETLAB_INNER !== '1') {
  const { build } = await import('vite')
  fs.mkdirSync(WWW, { recursive: true })
  await build({
    root: REPO,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: WWW,
      emptyOutDir: false,
      lib: { entry: path.join(HERE, 'bench.ts'), formats: ['iife'], name: 'netbench', fileName: () => 'bench.js' },
    },
  })
  fs.writeFileSync(path.join(WWW, 'bench.html'), '<!doctype html><meta charset="utf-8"><title>netbench</title><script src="bench.js"></script>')
}
await enterNetns()

const SECONDS = Number(arg('--seconds', 60))
const only = arg('--only', '')
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN
}
const r1 = (x) => Math.round(x * 10) / 10
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms, what) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const lab = await startLab({ staticRoot: WWW, dir: DIR })
const rows = []
const { host, guest } = await lab.openPages(`${lab.staticOrigin}/bench.html`)
if (process.env.NETLAB_VERBOSE) for (const p of [host, guest]) p.on('console', (m) => console.log('  page:', m.text()))
// The first createOffer in a fresh Chromium inside the netns takes about 28 s
// (no network beyond the namespace); later ones take milliseconds. Pay it once
// here, outside every measured join, and reuse the two pages for every run.
const warm = () => {
  const pc = new RTCPeerConnection()
  pc.createDataChannel('warm')
  return pc.createOffer().then(() => pc.close())
}
await Promise.all([host.evaluate(warm), guest.evaluate(warm)])
try {
  for (const [i, profile] of PROFILES.entries()) {
    if (only && !profile.name.toLowerCase().includes(only)) continue
    await lab.impair(profileToImpairment(profile))
    for (const via of (process.env.NETLAB_PATHS ?? 'relay,p2p').split(',')) {
      const o = { room: `bench-${i}-${via}-${process.pid}`, wsBase: `ws://${lab.lanIp}:${lab.relayPort}/ws`, p2p: via === 'p2p', seed: 4242, iceTimeoutMs: Number(process.env.NETLAB_ICE_MS ?? 3000), script: process.env.NETLAB_SCRIPT ?? 'wa' }
      try {
        await host.evaluate(async (opts) => (window.H = await window.bench.host(opts), true), o)
        await guest.evaluate(async (opts) => (window.G = await window.bench.guest(opts), true), o)
        await until(() => guest.evaluate(() => window.G.phase() === 'playing'), 20000, 'the guest to play')
        const got = await guest.evaluate(() => window.G.path())
        if (got !== via) throw new Error(`asked for ${via}, the guest is on ${got}`)
        await sleep(5000)
        await guest.evaluate(() => window.G.begin())
        await sleep(SECONDS * 1000)
        await guest.evaluate(() => window.G.quiet())
        await sleep(3000)
        const g = await guest.evaluate(() => window.G.stats())
        const h = await host.evaluate(() => window.H.stats())
        const gaps = g.arrivals.slice(1).map((a, k) => a - g.arrivals[k])
        const row = {
          profile: profile.name,
          path: via,
          endPath: g.link.path,
          rttN: g.rtts.length,
          rttP50: r1(pct(g.rtts, 50)),
          rttP95: r1(pct(g.rtts, 95)),
          rttMax: r1(Math.max(...g.rtts)),
          jitter: r1(pct(g.lateness, 95) - pct(g.lateness, 50)),
          gapP95: r1(pct(gaps, 95)),
          gapMax: r1(Math.max(...gaps)),
          correctionsPerMin: r1((g.corrections / g.seconds) * 60),
          taps: g.taps,
          tapsLost: g.taps - h.attackEdges,
        }
        rows.push(row)
        console.log(JSON.stringify(row))
      } catch (e) {
        console.log(JSON.stringify({ profile: profile.name, path: via, error: String(e.message ?? e) }))
      } finally {
        await guest.evaluate(() => window.G?.stop()).catch(() => {})
        await host.evaluate(() => window.H?.stop()).catch(() => {})
        await sleep(500)
      }
    }
  }
} finally {
  await lab.stop()
}
const out = arg('--json', '')
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 2))
console.log('\n| profile | path | RTT p50 / p95 (ms) | jitter (ms) | snapshot gap p95 (ms) | corrections / min | taps lost |')
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.profile} | ${r.path} | ${r.rttP50} / ${r.rttP95} | ${r.jitter} | ${r.gapP95} | ${r.correctionsPerMin} | ${r.tapsLost} of ${r.taps} |`)
process.exit(0)
